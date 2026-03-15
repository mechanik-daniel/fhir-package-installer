/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */

import https from 'https';
import http from 'http';
import fs from 'fs-extra';
import pLimit from 'p-limit';
import path from 'path';
import { Readable } from 'stream';
import { finished, pipeline } from 'stream/promises';
import * as tar from 'tar-stream';
import * as zlib from 'zlib';
import os from 'os';
import semver from 'semver';
import crypto from 'crypto';
 

import type {
  FileInPackageIndex,
  PackageIndex,
  PackageManifest
} from '@outburn/types';

import type {
  FpiConfig,
  PackageResource,
  DownloadPackageOptions,
  InstallPackageOptions
} from './types';
import { Logger, FhirPackageIdentifier } from '@outburn/types';

const tempDirs = new Set<string>();
let tempCleanupRegistered = false;

const registerTempCleanup = (): void => {
  if (tempCleanupRegistered) return;
  tempCleanupRegistered = true;
  process.once('exit', () => {
    for (const dir of tempDirs) {
      try {
        fs.removeSync(dir);
      } catch {
        // best-effort cleanup
      }
    }
    tempDirs.clear();
  });
};

const createTempDir = (): string => {
  registerTempCleanup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhir-package-installer-'));
  tempDirs.add(dir);
  return dir;
};

// NOTE: This is injected at build time via tsup `define` (see tsup.config.ts).
// It must NOT be read from package.json at runtime (supports SEA/bundling scenarios).
declare const __FPI_VERSION__: string | undefined;
const FPI_VERSION = typeof __FPI_VERSION__ === 'string' && __FPI_VERSION__.trim().length > 0
  ? __FPI_VERSION__
  : '0.0.0';
const FPI_INDEX_CACHE_VERSION = (() => {
  const v = semver.parse(FPI_VERSION);
  if (!v) return '0.0';
  return `${v.major}.${v.minor}`;
})();

/**
 * Mapping from core FHIR packages to their implicit dependencies
 * Based on https://chat.fhir.org/#narrow/stream/179239-tooling/topic/New.20Implicit.20Package/near/325318949
 */
const IMPLICIT_DEPENDENCIES_MAP: Record<string, string[]> = {
  'hl7.fhir.r3.core': [
    'hl7.terminology.r3', 
    'hl7.fhir.uv.extensions.r3'
  ],
  'hl7.fhir.r4.core': [
    'hl7.terminology.r4',
    'hl7.fhir.uv.extensions.r4'
  ],
  'hl7.fhir.r5.core': [
    'hl7.terminology.r5',
    'hl7.fhir.uv.extensions.r5'
  ]
};

// TTL for cached registry lookups (stored under `cachePath`)
const DEFAULT_REGISTRY_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Process-wide in-memory cache sizing
const MEM_CACHE_MAX_ENTRIES = 500;

// ---- Module-level (process-wide) single-flight maps ----
// These are intentionally module-scoped so multiple FhirPackageInstaller instances within
// the same Node process coordinate and don't duplicate work.
const inFlightJson = new Map<string, Promise<any>>();
const inFlightTarball = new Map<string, Promise<string>>();
const inFlightIndex = new Map<string, Promise<PackageIndex>>();
const inFlightImplicitEffectiveVersion = new Map<string, Promise<string>>();

// Process-wide cache for implicit package effective versions.
// Keyed by {registryUrl, cachePath, packageId} so different installer configs don't bleed into each other.
const implicitEffectiveVersionCache = new Map<string, string>();

class ImplicitPackageResolutionError extends Error {
  public readonly packageId: string;
  public readonly attemptedVersions: string[];
  public readonly registryUrl: string;
  public readonly cachePath: string;
  public readonly causes: string[];

  constructor(args: {
    packageId: string;
    attemptedVersions: string[];
    registryUrl: string;
    cachePath: string;
    causes?: string[];
  }) {
    const attempted = args.attemptedVersions.length > 0 ? args.attemptedVersions.join(', ') : '(none)';
    const prefix = `Failed to resolve implicit package ${args.packageId}`;
    const meta = `attemptedVersions=[${attempted}] registryUrl=${args.registryUrl} cachePath=${args.cachePath}`;
    const causeText = (args.causes && args.causes.length > 0)
      ? ` causes=[${args.causes.join(' | ')}]`
      : '';
    super(`${prefix}. ${meta}.${causeText}`);
    this.name = 'ImplicitPackageResolutionError';
    this.packageId = args.packageId;
    this.attemptedVersions = args.attemptedVersions;
    this.registryUrl = args.registryUrl;
    this.cachePath = args.cachePath;
    this.causes = args.causes ?? [];
  }
}

type FhirPackageInstallStep =
  | 'download-tarball'
  | 'extract-tarball'
  | 'cache-package'
  | 'generate-index';

class FhirPackageInstallError extends Error {
  public readonly packageId: string;
  public readonly version: string;
  public readonly registryUrl: string;
  public readonly cachePath: string;
  public readonly step: FhirPackageInstallStep;
  public readonly tarballUrl?: string;

  constructor(args: {
    packageId: string;
    version: string;
    registryUrl: string;
    cachePath: string;
    step: FhirPackageInstallStep;
    tarballUrl?: string;
    cause?: unknown;
  }) {
    const safe = (v: unknown): string => {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (v instanceof Error) return v.message;
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    };

    const pkg = `${args.packageId}@${args.version}`;
    const meta = `step=${args.step} registryUrl=${args.registryUrl} cachePath=${args.cachePath}`;
    const tarball = args.tarballUrl ? ` tarballUrl=${args.tarballUrl}` : '';
    const causeText = args.cause ? ` Cause: ${safe(args.cause)}` : '';
    super(`Failed to install ${pkg}. ${meta}.${tarball}${causeText}`);
    this.name = 'FhirPackageInstallError';
    this.packageId = args.packageId;
    this.version = args.version;
    this.registryUrl = args.registryUrl;
    this.cachePath = args.cachePath;
    this.step = args.step;
    this.tarballUrl = args.tarballUrl;
    (this as any).cause = args.cause;
  }
}

const withSingleFlight = async <T>(
  map: Map<string, Promise<T>>,
  key: string,
  fn: () => Promise<T>
): Promise<T> => {
  const existing = map.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      return await fn();
    } finally {
      map.delete(key);
    }
  })();

  map.set(key, p);
  return p;
};

const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

type DiskCacheEnvelope<T> = {
  expiresAt: number;
  data: T;
};

type MemCacheEnvelope<T> = {
  expiresAt?: number;
  value: T;
};

// ---- Module-level (process-wide) TTL memory cache ----
// Shared across all FhirPackageInstaller instances in the same Node process.
const memCache = new Map<string, MemCacheEnvelope<any>>();

const memGet = <T>(key: string): T | null => {
  const e = memCache.get(key);
  if (!e) return null;
  if (typeof e.expiresAt === 'number') {
    if (Date.now() >= e.expiresAt) {
      memCache.delete(key);
      return null;
    }
  }
  return e.value as T;
};

const memSet = <T>(key: string, value: T, ttlMs: number): void => {
  const expiresAt = Date.now() + ttlMs;
  // Update insertion order for LRU-ish behavior.
  memCache.delete(key);
  memCache.set(key, { expiresAt, value });
  while (memCache.size > MEM_CACHE_MAX_ENTRIES) {
    const firstKey = memCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    memCache.delete(firstKey);
  }
};

const memSetNoTtl = <T>(key: string, value: T): void => {
  // Update insertion order for LRU-ish behavior.
  memCache.delete(key);
  memCache.set(key, { value });
  while (memCache.size > MEM_CACHE_MAX_ENTRIES) {
    const firstKey = memCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    memCache.delete(firstKey);
  }
};

/**
 * Default logger is a no-op.
 *
 * This is a library module: it should not write to stdout/stderr unless the caller
 * explicitly provides a logger (e.g. a console-mapped logger in CLI apps).
 */
const defaultLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

/**
 * Max number of concurrent file operations (read / write))
 */
// Cap concurrency to reduce risk of EMFILE/too-many-open-files on Windows.
const limit = pLimit(Math.max(4, Math.min(32, os.cpus().length)));

/**
 * Generates an index entry for the package resource
 * @param filename resource filename
 * @param content resource content
 * @returns FileInPackageIndex object 
 */
const extractResourceIndexEntry = (filename: string, content: PackageResource): FileInPackageIndex => {
  const evalAttribute = (att: any | any[]) => (typeof att === 'string' ? att : undefined);
  const indexEntry: FileInPackageIndex = {
    filename,
    resourceType: content.resourceType,
    id: content.id,
    url: evalAttribute(content.url),
    name: evalAttribute(content.name),
    version: evalAttribute(content.version),
    kind: evalAttribute(content.kind),
    type: evalAttribute(content.type),
    supplements: evalAttribute(content.supplements),
    content: evalAttribute(content.content),
    baseDefinition: evalAttribute(content.baseDefinition),
    derivation: evalAttribute(content.derivation),
    date: evalAttribute(content.date)
  };
  return indexEntry;
};

export class FhirPackageInstaller {
  private logger: Logger = defaultLogger;
  private registryUrl = 'https://packages.fhir.org';
  private registryDisabled = false;
  private registryToken?: string; // optional token for private registries
  private requestTimeoutMs = 90000; // 90 seconds
  private extractTimeoutMs = 60000; // 60 seconds
  private registryTtlMs = DEFAULT_REGISTRY_TTL_MS;
  /**
   * Path to the FHIR package cache directory.
   * This directory is used to store downloaded and extracted FHIR packages.
   * If the directory does not exist, it will be created.
   * Default location follows FHIR spec:
   * - User apps: ~/.fhir/packages (Windows: C:\Users\<user>\.fhir\packages)
   * - System services: /var/lib/.fhir/packages (Windows: %ProgramData%\.fhir\packages)
   */
  private cachePath!: string;
  private skipExamples = false; // skip dependency installation of example packages
  private allowHttp = false; // allow HTTP URLs for testing
  private resolvingImplicitDeps = new Set<string>();
  private installingPackages = new Set<string>();
  
  constructor(config?: FpiConfig) {
    const {
      logger,
      registryUrl,
      registryToken,
      cachePath,
      skipExamples,
      allowHttp,
      requestTimeoutMs,
      extractTimeoutMs,
      registryTtlMs
    } = config || {} as FpiConfig;

    // Set logger first so getDefaultCachePath() can use it for warnings
    if (logger) {
      this.logger = logger;
    }

    const normalizedCachePath = ((): string | undefined => {
      if (cachePath == null) {
        return undefined;
      }
      if (typeof cachePath !== 'string') {
        this.logger.warn?.(
          `Non-string cachePath provided (${typeof cachePath}); falling back to FHIR spec default cache path.`
        );
        return undefined;
      }
      const trimmed = cachePath.trim();
      if (trimmed === '' || trimmed.toLowerCase() === 'n/a') {
        this.logger.warn?.(
          'Non-usable cachePath provided (empty/whitespace or "n/a"); falling back to FHIR spec default cache path.'
        );
        return undefined;
      }
      return trimmed;
    })();

    this.cachePath = normalizedCachePath ?? this.getDefaultCachePath();

    if (registryUrl) {
      const normalized = registryUrl.trim();
      this.registryUrl = registryUrl;
      if (normalized.toLowerCase() === 'n/a') {
        this.registryUrl = 'n/a';
        this.registryDisabled = true;
      }
    }
    if (registryToken) {
      this.registryToken = registryToken;
    }
    if (allowHttp) {
      this.allowHttp = allowHttp;
    }

    if (typeof requestTimeoutMs === 'number' && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
      this.requestTimeoutMs = requestTimeoutMs;
    }
    if (typeof extractTimeoutMs === 'number' && Number.isFinite(extractTimeoutMs) && extractTimeoutMs > 0) {
      this.extractTimeoutMs = extractTimeoutMs;
    }
    // Unify registry TTL config.
    const effectiveRegistryTtlMs =
      (typeof registryTtlMs === 'number' && Number.isFinite(registryTtlMs) && registryTtlMs > 0)
        ? registryTtlMs
        : undefined;
    if (typeof effectiveRegistryTtlMs === 'number') {
      this.registryTtlMs = effectiveRegistryTtlMs;
    }
    if (skipExamples) {
      this.skipExamples = skipExamples;
    }
  }

  /**
   * Determines the default FHIR package cache path based on FHIR specifications:
   * https://confluence.hl7.org/display/FHIR/FHIR+Package+Cache
   * 
   * For user applications:
   * - Windows: C:\Users\<username>\.fhir\packages
   * - Unix/Linux: ~/.fhir/packages
   * 
   * For system services (daemons):
   * - Windows: %ProgramData%\.fhir\packages (typically C:\ProgramData\.fhir\packages)
   * - Unix/Linux: /var/lib/.fhir/packages
   * 
   * Behavior can be overridden via the FHIR_PACKAGE_CACHE_MODE environment variable:
   * - FHIR_PACKAGE_CACHE_MODE=system -> always use system service paths
   * - FHIR_PACKAGE_CACHE_MODE=user   -> always use user paths
   */
  private getDefaultCachePath(): string {
    const isWindows = process.platform === 'win32';
    const homeDir = os.homedir();

    // Allow explicit override of cache mode via environment variable
    const cacheMode = process.env.FHIR_PACKAGE_CACHE_MODE?.toLowerCase();
    let isSystemService: boolean;

    if (cacheMode === 'system') {
      isSystemService = true;
    } else if (cacheMode === 'user') {
      isSystemService = false;
    } else {
      // Detect if running as a system service/daemon
      // On Windows: Check if homedir ends with the SYSTEM profile path (no real user home)
      // Using path.normalize() handles mixed separators and ensures consistent comparison
      // On Unix: Prefer a "daemon-like" heuristic rather than only checking for root:
      //   - running as root (uid 0)
      //   - not invoked via sudo (no SUDO_USER)
      //   - missing common interactive-session variables (DISPLAY, SSH_CONNECTION, TERM)
      if (isWindows) {
        const normalizedHome = path.normalize(homeDir).toLowerCase();
        const systemProfileSuffix = path
          .normalize(path.join('Windows', 'System32', 'config', 'systemprofile'))
          .toLowerCase();
        isSystemService = normalizedHome.endsWith(systemProfileSuffix);
      } else {
        const isRoot = process.getuid?.() === 0;
        const isSudo = !!process.env.SUDO_USER;
        const hasDisplay = !!process.env.DISPLAY;
        const hasSshConnection = !!process.env.SSH_CONNECTION;
        const hasTerm = !!process.env.TERM;

        isSystemService = Boolean(
          isRoot &&
          !isSudo &&
          !hasDisplay &&
          !hasSshConnection &&
          !hasTerm
        );
      }
    }

    if (isSystemService) {
      if (isWindows) {
        // Use ProgramData environment variable as per FHIR spec.
        // If ProgramData is not set, fall back to "C:\\ProgramData" if it exists and is writable;
        // otherwise fall back to user home directory.
        let programData = process.env.ProgramData;

        if (!programData || programData.trim() === '') {
          const fallbackProgramData = 'C:\\ProgramData';
          try {
            if (fs.pathExistsSync(fallbackProgramData)) {
              fs.accessSync(fallbackProgramData, fs.constants.W_OK);
              this.logger.warn(
                'ProgramData environment variable is not set; ' +
                'using fallback "C:\\ProgramData" for system service cache directory.'
              );
              programData = fallbackProgramData;
            } else {
              this.logger.warn(
                'ProgramData environment variable is not set and ' +
                'fallback "C:\\ProgramData" does not exist. Falling back to user cache directory.'
              );
            }
          } catch {
            this.logger.warn(
              'ProgramData environment variable is not set and ' +
              'fallback "C:\\ProgramData" is not writable. Falling back to user cache directory.'
            );
          }
        }

        if (programData) {
          return path.join(programData, '.fhir', 'packages');
        }
        // ProgramData unavailable or not writable - use user home
        return path.join(homeDir, '.fhir', 'packages');
      } else {
        // Unix/Linux daemon location
        return '/var/lib/.fhir/packages';
      }
    }

    // Standard user location
    return path.join(homeDir, '.fhir', 'packages');
  }

  private async withDiskLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    // Lock files live under cachePath so we never write outside user-controlled boundaries.
    const locksDir = await this.ensureDiskCacheSubdir('locks');
    const lockPath = path.join(locksDir, `${sha256Hex(lockKey)}.lock`);

    const start = Date.now();
    const maxWaitMs = Math.max(1000, this.requestTimeoutMs);
    const staleMs = Math.max(2 * 60 * 1000, maxWaitMs * 2);

    while (true) {
      try {
        await fs.ensureDir(path.dirname(lockPath));
        await fs.writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, { flag: 'wx' });
        const heartbeat = setInterval(() => {
          // Keep mtime fresh so waiters can distinguish live vs stale locks.
          fs.utimes(lockPath, new Date(), new Date()).catch(() => undefined);
        }, 1000);
        (heartbeat as any).unref?.();
        try {
          return await fn();
        } finally {
          clearInterval(heartbeat);
          await fs.remove(lockPath).catch(() => undefined);
        }
      } catch (e: any) {
        if (e?.code !== 'EEXIST') {
          // If locking fails for other reasons, don't break functionality.
          return await fn();
        }

        // If the lock looks stale, attempt to break it.
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > staleMs) {
            await fs.remove(lockPath).catch(() => undefined);
            continue;
          }
        } catch {
          // ignore
        }

        if (Date.now() - start > maxWaitMs) {
          // Avoid deadlocks: proceed without the lock after waiting.
          return await fn();
        }

        await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 100)));
      }
    }
  }

  // ---- Per-cachePath persistent cache helpers ----
  private async ensureDiskCacheSubdir(name: string): Promise<string> {
    const dir = path.join(this.cachePath, '.fpi.cache', name);
    await fs.ensureDir(dir);
    return dir;
  }

  private getDiskCacheKeyPrefix(): string {
    // Avoid accidental cross-registry pollution for metadata/tarballs.
    return `${this.registryUrl}`;
  }

  private async readDiskCacheJson<T>(filePath: string): Promise<T | null> {
    try {
      if (!await fs.exists(filePath)) return null;
      const raw = await fs.readJSON(filePath, { encoding: 'utf8' }) as any;
      if (!raw || typeof raw !== 'object') return null;

      // TTL envelope format: { expiresAt: number, data: T }
      if (typeof raw.expiresAt === 'number' && 'data' in raw) {
        if (Date.now() >= raw.expiresAt) {
          // Lazy eviction
          await fs.remove(filePath).catch(() => undefined);
          return null;
        }
        return raw.data as T;
      }

      // Non-TTL format: just the raw data.
      return raw as T;
    } catch {
      return null;
    }
  }

  private async writeDiskCacheJson<T>(filePath: string, data: T, ttlMs: number): Promise<void> {
    try {
      await fs.ensureDir(path.dirname(filePath));
      const expiresAt = Date.now() + ttlMs;
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeJSON(tmp, { expiresAt, data } satisfies DiskCacheEnvelope<T>);
      await fs.move(tmp, filePath, { overwrite: true });
    } catch {
      // best-effort
    }
  }

  private async writeDiskCacheJsonNoTtl<T>(filePath: string, data: T): Promise<void> {
    try {
      await fs.ensureDir(path.dirname(filePath));
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeJSON(tmp, data);
      await fs.move(tmp, filePath, { overwrite: true });
    } catch {
      // best-effort
    }
  }

  private getDiskRegistryMetadataCachePath(packageName: string): string {
    const key = `registry-meta|${this.getDiskCacheKeyPrefix()}|${packageName}`;
    return path.join(this.cachePath, '.fpi.cache', 'metadata', `${sha256Hex(key)}.json`);
  }

  private getDiskIndexCachePath(packageObject: FhirPackageIdentifier): string {
    const key = `index|${FPI_INDEX_CACHE_VERSION}|${packageObject.id}#${packageObject.version}`;
    return path.join(this.cachePath, '.fpi.cache', 'indexes', `${sha256Hex(key)}.json`);
  }

  private getDiskTarballCacheKey(packageObject: FhirPackageIdentifier): string {
    return `tarball|${this.getDiskCacheKeyPrefix()}|${packageObject.id}#${packageObject.version}`;
  }

  private async getDiskTarballCachePaths(packageObject: FhirPackageIdentifier): Promise<{ tgzPath: string; donePath: string }> {
    const tarDir = await this.ensureDiskCacheSubdir('tarballs');
    const tgzPath = path.join(tarDir, `${sha256Hex(this.getDiskTarballCacheKey(packageObject))}.tgz`);
    const donePath = `${tgzPath}.done`;
    return { tgzPath, donePath };
  }

  private async readDiskTarballCache(packageObject: FhirPackageIdentifier): Promise<string | null> {
    try {
      const { tgzPath, donePath } = await this.getDiskTarballCachePaths(packageObject);
      if (!await fs.exists(tgzPath)) return null;

      // We treat tarballs as immutable when keyed by id+version.
      // Use a done marker to avoid using a partially-written tgz after a crash.
      if (!await fs.exists(donePath)) {
        await fs.remove(tgzPath).catch(() => undefined);
        return null;
      }
      return tgzPath;
    } catch {
      return null;
    }
  }

  private async writeDiskTarballDoneMarker(donePath: string): Promise<void> {
    try {
      const tmp = `${donePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, 'ok');
      await fs.move(tmp, donePath, { overwrite: true });
    } catch {
      // best-effort
    }
  }

  private getIndexMemKey(packageObject: FhirPackageIdentifier): string {
    // Indexes are keyed only by immutable identity (package id+version) plus FPI minor version.
    // Do not include cachePath here: different installer instances in the same process should share.
    return `index|${FPI_INDEX_CACHE_VERSION}|${packageObject.id}#${packageObject.version}`;
  }

  private getIndexDiskLockKey(packageObject: FhirPackageIdentifier): string {
    return `index-cache|${FPI_INDEX_CACHE_VERSION}|${packageObject.id}#${packageObject.version}`;
  }

  private isRegistryDisabled(): boolean {
    return this.registryDisabled;
  }

  private formatRegistryDisabledMessage(detail: string): string {
    return `FHIR package registry is disabled (registryUrl=n/a). ${detail}`;
  }

  private async packageManifestExists(packageObject: FhirPackageIdentifier): Promise<boolean> {
    const packageDir = await this.getPackageDirPath(packageObject);
    return await fs.exists(path.join(packageDir, 'package', 'package.json'));
  }

  private async collectMissingPackages(root: FhirPackageIdentifier): Promise<string[]> {
    const missing: string[] = [];
    const visited = new Set<string>();

    const visit = async (pkg: FhirPackageIdentifier) => {
      const key = `${pkg.id}#${pkg.version}`;
      if (visited.has(key)) return;
      visited.add(key);

      const hasManifest = await this.packageManifestExists(pkg);
      if (!hasManifest) {
        missing.push(key);
        return;
      }

      const deps = await this.getDependencies(pkg);
      for (const [depId, depVersion] of Object.entries(deps || {})) {
        if (this.skipExamples && depId.includes('examples')) continue;
        await visit({ id: depId, version: depVersion });
      }
    };

    await visit(root);
    return missing;
  }

  private async withRetries<T>(
    fn: () => Promise<T>,
    retries = 3,
    delayMs = 5000
  ): Promise<T> {
    let lastError: any;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        const isTemporary =
          err.code === 'EAI_AGAIN' ||
          err.code === 'ENOTFOUND' ||
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          err.code === 'ECONNABORTED' ||
          err.message === 'aborted';
  
        if (!isTemporary || attempt === retries) {
          throw err;
        }
  
        this.logger.warn(
          `⚠️ Attempt ${attempt} failed (${err.code || err.message}), retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  /**
   * Takes a FhirPackageIdentifier Object and returns the corresponding directory name of the package
   * @param packageObject A PackageObject with both name and version keys
   * @returns (string) Directory name in the standard format `name#version`
   */
  private async toDirName(packageId: FhirPackageIdentifier | string): Promise<string> {
    const packageObj = typeof packageId === 'string' ? await this.toPackageObject(packageId) : packageId;
    return packageObj.id + '#' + packageObj.version;
  }

  /**
   * Takes a FhirPackageIdentifier Object and returns the path to the package folder in the cache
   * @param packageObject A FhirPackageIdentifier Object with both name and version keys
   * @returns The full path to the package directory
   */
  public async getPackageDirPath(packageId: FhirPackageIdentifier | string): Promise<string> {
    return path.join(this.cachePath, await this.toDirName(packageId));
  }

  /**
   * Get the full path to the .fpi.index.json file in the package folder
   * @param packageObject A FhirPackageIdentifier Object with both name and version keys
   * @returns (string) The path to the package index file
   */
  private async getPackageIndexPath(packageId: FhirPackageIdentifier | string): Promise<string> {
    return path.join(await this.getPackageDirPath(packageId), 'package', '.fpi.index.json');
  }


  /**
   * Scans a package folder and generates a new `.fpi.index.json` file
   * @param packageObject The package identifier object
   * @returns PackageIndex
   */
  private async generatePackageIndex(packageId: FhirPackageIdentifier | string): Promise<PackageIndex> {
    const pckIdObj = typeof packageId === 'string' ? await this.toPackageObject(packageId) : packageId;
    this.logger.debug?.(`Generating new .fpi.index.json file for package ${pckIdObj.id}@${pckIdObj.version}...`);
    const packagePath = await this.getPackageDirPath(pckIdObj);
    const indexPath = await this.getPackageIndexPath(pckIdObj);

    // Layer 1: memory
    const memKey = this.getIndexMemKey(pckIdObj);
    const memHit = memGet<PackageIndex>(memKey);
    if (memHit) {
      await fs.writeJSON(indexPath, memHit);
      return memHit;
    }

    // Cross-process: ensure only one process does the expensive scan per package version.
    return await this.withDiskLock(this.getIndexDiskLockKey(pckIdObj), async () => {
      // Re-check memory after acquiring the lock.
      const memHit2 = memGet<PackageIndex>(memKey);
      if (memHit2) {
        await fs.writeJSON(indexPath, memHit2);
        return memHit2;
      }

      // Layer 2: per-cachePath disk
      const diskPath = this.getDiskIndexCachePath(pckIdObj);
      const diskHit = await withSingleFlight(inFlightIndex, `disk-${memKey}`, async () => {
        // Ensure parent exists lazily
        await this.ensureDiskCacheSubdir('indexes');
        return await this.readDiskCacheJson<PackageIndex>(diskPath);
      });
      if (diskHit) {
        memSetNoTtl(memKey, diskHit);
        await fs.writeJSON(indexPath, diskHit);
        return diskHit;
      }

      const fileList = await fs.readdir(path.join(packagePath, 'package'));
      const files = await Promise.all(
        fileList.filter(
          file => file.endsWith('.json') && file !== 'package.json' && !file.endsWith('.index.json')
        ).map(
          file => limit(
            async () => {
              const contentText = await fs.readFile(path.join(packagePath, 'package', file), { encoding: 'utf8' });
              const content = JSON.parse(contentText) as PackageResource;
              const indexEntry = extractResourceIndexEntry(file, content);
              return indexEntry;
            }
          )
        )
      );
      const indexJson: PackageIndex = {
        'index-version': 2,
        files
      };
      await fs.writeJSON(indexPath, indexJson);

      // Persist to memory + per-cachePath disk (best-effort)
      memSetNoTtl(memKey, indexJson);
      try {
        await this.ensureDiskCacheSubdir('indexes');
        await this.writeDiskCacheJsonNoTtl(diskPath, indexJson);
      } catch {
        // ignore
      }

      return indexJson;
    });
  }

  /**
   * Generates HTTP options including authorization header for registry requests
   * @param url The URL being requested
   * @returns HTTP options object with headers if needed
   */
  private getHttpOptions(url: string): https.RequestOptions {
    const options: https.RequestOptions = {};
    
    // Add authorization header for requests to the configured registry
    // or any URL that contains the same hostname (to handle redirects within the same registry)
    if (this.registryToken && !this.isRegistryDisabled()) {
      try {
        const registryHostname = new URL(this.registryUrl).hostname;
        const urlHostname = new URL(url).hostname;
        if (url.startsWith(this.registryUrl) || urlHostname === registryHostname) {
          options.headers = {
            'Authorization': `Bearer ${this.registryToken}`
          };
        }
      } catch (err: any) {
        // If registryUrl isn't a valid URL, skip auth headers.
        // However, log a warning so misconfiguration is visible.
        const normalizedRegistryUrl = (this.registryUrl || '').trim().toLowerCase();
        if (normalizedRegistryUrl !== 'n/a') {
          const displayUrl = url.length > 128 ? `${url.substring(0, 128)}...` : url;
          this.logger.warn(
            `Failed to parse URL(s) for auth header (registryUrl='${this.registryUrl}', url='${displayUrl}'); proceeding without auth header. ` +
            `Error: ${err?.message || String(err)}`
          );
        }
      }
    }
    
    return options;
  }

  private fetchJson(url: string, redirectCount = 0): Promise<any> {
    const maxRedirects = 5;
    
    return this.withRetries(() => new Promise((resolve, reject) => {
      const options = this.getHttpOptions(url);
      const isHttps = url.startsWith('https:');
      const isHttp = url.startsWith('http:');
      
      // Check if HTTP is allowed for testing
      if (isHttp && !this.allowHttp) {
        reject(new Error('HTTP URLs not allowed. Use HTTPS or enable allowHttp for testing.'));
        return;
      }
      
      const client = isHttps ? https : http;
      const req = client.get(url, options, (res) => {
        // Handle redirects (301, 302, 303, 307, 308)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectCount >= maxRedirects) {
            reject(new Error(`Too many redirects (${maxRedirects}) when fetching ${url}`));
            return;
          }
          
          const redirectTarget = res.headers.location;
          const displayUrl = redirectTarget.length > 64 
            ? `${redirectTarget.substring(0, 64)}...` 
            : redirectTarget;
          this.logger.debug?.(`Following redirect from ${url} to ${displayUrl}`);
          // Recursively follow the redirect
          this.fetchJson(res.headers.location, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        
        // Apply a per-request inactivity timeout while reading the response
        res.setTimeout(this.requestTimeoutMs, () => {
          const timeoutErr: any = new Error(`Request timed out after ${this.requestTimeoutMs}ms while fetching ${url}`);
          timeoutErr.code = 'ETIMEDOUT';
          res.destroy(timeoutErr);
        });

        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          // Check for HTTP error status codes
          if (res.statusCode && res.statusCode >= 400) {
            try {
              const errorData = JSON.parse(data);
              const errorMsg = errorData.error || errorData.message || data;
              
              // Convert authentication/authorization errors to "not found" for consistency
              if (res.statusCode === 403 || res.statusCode === 401) {
                reject(new Error('Package not found in the registry (authentication failed)'));
              } else {
                reject(new Error(`HTTP ${res.statusCode}: ${errorMsg}`));
              }
            } catch {
              if (res.statusCode === 403 || res.statusCode === 401) {
                reject(new Error('Package not found in the registry (authentication failed)'));
              } else {
                reject(new Error(`HTTP ${res.statusCode}: ${data || 'Unknown error'}`));
              }
            }
            return;
          }
          
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e}`));
          }
        });
      });

      req.setTimeout(this.requestTimeoutMs, () => {
        const timeoutErr: any = new Error(`Request timed out after ${this.requestTimeoutMs}ms while fetching ${url}`);
        timeoutErr.code = 'ETIMEDOUT';
        req.destroy(timeoutErr);
      });

      req.on('error', reject);
    }));
  }  

  private fetchStream(url: string, redirectCount = 0): Promise<Readable> {
    const maxRedirects = 5;
    
    return this.withRetries(() => new Promise((resolve, reject) => {
      const options = this.getHttpOptions(url);
      const isHttps = url.startsWith('https:');
      const isHttp = url.startsWith('http:');
      
      // Check if HTTP is allowed for testing
      if (isHttp && !this.allowHttp) {
        reject(new Error('HTTP URLs not allowed. Use HTTPS or enable allowHttp for testing.'));
        return;
      }
      
      const client = isHttps ? https : http;
      const req = client.get(url, options, (res) => {
        // Handle redirects (301, 302, 303, 307, 308)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectCount >= maxRedirects) {
            reject(new Error(`Too many redirects (${maxRedirects}) when fetching ${url}`));
            return;
          }
          
          const redirectTarget = res.headers.location;
          const displayUrl = redirectTarget.length > 64 
            ? `${redirectTarget.substring(0, 64)}...` 
            : redirectTarget;
          this.logger.debug?.(`Following redirect from ${url} to ${displayUrl}`);
          // Recursively follow the redirect
          this.fetchStream(res.headers.location, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        
        if (res.statusCode === 200) {
          res.setTimeout(this.requestTimeoutMs, () => {
            const timeoutErr: any = new Error(`Request timed out after ${this.requestTimeoutMs}ms while fetching ${url}`);
            timeoutErr.code = 'ETIMEDOUT';
            res.destroy(timeoutErr);
          });
          resolve(res);
        } else {
          const code = res.statusCode ?? 0;
          if (code === 404) {
            reject(new Error(`Failed to fetch ${url} (status 404): not found`));
          } else {
            reject(new Error(`Failed to fetch ${url} (status ${code})`));
          }
        }
      });

      req.setTimeout(this.requestTimeoutMs, () => {
        const timeoutErr: any = new Error(`Request timed out after ${this.requestTimeoutMs}ms while fetching ${url}`);
        timeoutErr.code = 'ETIMEDOUT';
        req.destroy(timeoutErr);
      });

      req.on('error', reject);
    }));
  }  

  private async getPackageDataFromRegistry(packageName: string): Promise<Record<string, any>> {
    if (this.isRegistryDisabled()) {
      throw new Error(this.formatRegistryDisabledMessage(`Cannot query registry for package metadata (${packageName}).`));
    }

    const url = `${this.registryUrl}/${packageName}/`;
    const cacheKey = `fetch-json|${url}`;

    // Layer 1: memory
    const memKey = `registry-meta|${this.registryUrl}|${packageName}`;
    const memHit = memGet<Record<string, any>>(memKey);
    if (memHit) return memHit;

    // Layer 2: per-cachePath disk
    const diskPath = this.getDiskRegistryMetadataCachePath(packageName);

    return await withSingleFlight(inFlightJson, cacheKey, async () => {
      const memHit2 = memGet<Record<string, any>>(memKey);
      if (memHit2) return memHit2;

      return await this.withDiskLock(`registry-meta|${this.getDiskCacheKeyPrefix()}|${packageName}`, async () => {
        const memHit3 = memGet<Record<string, any>>(memKey);
        if (memHit3) return memHit3;

        try {
          await this.ensureDiskCacheSubdir('metadata');
          const diskHit = await this.readDiskCacheJson<Record<string, any>>(diskPath);
          if (diskHit) {
            memSet(memKey, diskHit, this.registryTtlMs);
            return diskHit;
          }
        } catch {
          // ignore disk cache read errors
        }

        // Only log when we are about to perform a real registry request.
        // Cache hits (memory/disk) should remain silent to avoid console clutter.
        this.logger.debug?.(`Fetching registry metadata for FHIR package ${packageName} from ${this.registryUrl}`);
        const data = await this.fetchJson(url);
        memSet(memKey, data, this.registryTtlMs);
        await this.writeDiskCacheJson(diskPath, data, this.registryTtlMs);
        return data;
      });
    });
  }

  private async getTarballUrl(packageObject: FhirPackageIdentifier): Promise<string> {
    if (this.isRegistryDisabled()) {
      throw new Error(this.formatRegistryDisabledMessage(
        `Cannot download ${packageObject.id}@${packageObject.version}. Required packages must already exist in the package cache (${this.cachePath}).`
      ));
    }

    if (!packageObject.version || packageObject.version.trim().length === 0) {
      throw new Error(`Invalid package version for ${packageObject.id}`);
    }

    // A specific package version is immutable. Prefer a deterministic tarball URL.
    // This avoids extra registry metadata calls, reducing rate-limit pressure.
    const isPrivateRegistry = this.registryUrl !== 'https://packages.fhir.org';
    
    // For private registries, construct the URL using the registry base (don't trust provided tarball URLs)
    if (isPrivateRegistry) {
      return `${this.registryUrl}/${packageObject.id}/-/${packageObject.id}-${packageObject.version}.tgz`;
    }

    // Default registry (packages.fhir.org) also supports the standard npm-style tarball URL format.
    return `${this.registryUrl}/${packageObject.id}/-/${packageObject.id}-${packageObject.version}.tgz`;
  }

  private async downloadFile(url: string, destination: string): Promise<void> {
    const tarballStream = await this.fetchStream(url);
    const fileStream = fs.createWriteStream(destination);
    await finished(tarballStream.pipe(fileStream));
  }

  private async downloadTarball(packageObject: FhirPackageIdentifier): Promise<string> {
    const tempDirectory = createTempDir();
    const tarballPath = path.join(tempDirectory, `${packageObject.id}-${packageObject.version}.tgz`);

    const cached = await this.getOrDownloadDiskCachedTarball(packageObject);
    await fs.copy(cached, tarballPath, { overwrite: true });
    return tarballPath;
  }

  private async getOrDownloadDiskCachedTarball(packageObject: FhirPackageIdentifier): Promise<string> {
    const key = this.getDiskTarballCacheKey(packageObject);
    const memKey = `tarball|${this.cachePath}|${key}`;

    const memHit = memGet<string>(memKey);
    if (memHit && await fs.exists(memHit)) return memHit;

    return await withSingleFlight(inFlightTarball, memKey, async () => {
      const memHit2 = memGet<string>(memKey);
      if (memHit2 && await fs.exists(memHit2)) return memHit2;

      return await this.withDiskLock(this.getDiskTarballCacheKey(packageObject), async () => {
        const diskHit = await this.readDiskTarballCache(packageObject);
        if (diskHit) {
          memSetNoTtl(memKey, diskHit);
          return diskHit;
        }

        const { tgzPath, donePath } = await this.getDiskTarballCachePaths(packageObject);
        const tarballUrl = await this.getTarballUrl(packageObject);
        this.logger.debug?.(`Downloading ${packageObject.id}@${packageObject.version} from ${tarballUrl}`);

        const tmp = `${tgzPath}.${process.pid}.${Date.now()}.tmp`;
        try {
          await this.downloadFile(tarballUrl, tmp);
        } catch (e: any) {
          if (e instanceof FhirPackageInstallError) throw e;
          throw new FhirPackageInstallError({
            packageId: packageObject.id,
            version: packageObject.version ?? 'unknown',
            registryUrl: this.registryUrl,
            cachePath: this.cachePath,
            step: 'download-tarball',
            tarballUrl,
            cause: e,
          });
        }

        try {
          await fs.move(tmp, tgzPath, { overwrite: false });
        } catch (e: any) {
          // Another process may have won the race. Prefer the existing file.
          if (e?.code !== 'EEXIST') {
            await fs.remove(tmp).catch(() => undefined);
            throw e;
          }
          await fs.remove(tmp).catch(() => undefined);
        }

        // Mark completion so crashes don't leave a half-written cache entry.
        await this.writeDiskTarballDoneMarker(donePath);

        memSetNoTtl(memKey, tgzPath);
        return tgzPath;
      });
    });
  }

  /**
   * Extracts a tarball to a temporary directory and generates a new `.fpi.index.json` file.
   * The tarball can be a file path or a stream.
   * @param src The source tarball, either a file path or a Readable stream.
   * @returns The path to the temporary directory where the package was extracted.
   */
  private async extractTarball(src: string | Readable, options?: { packageObject?: FhirPackageIdentifier }): Promise<string> {
    const tarballStream: Readable = typeof src === 'string' ? fs.createReadStream(src) : src;

    const pkgObj = options?.packageObject;
    let cachedIndex: PackageIndex | null = null;
    if (pkgObj?.id && pkgObj?.version) {
      try {
        const memKey = this.getIndexMemKey(pkgObj);
        cachedIndex = memGet<PackageIndex>(memKey);
        if (!cachedIndex) {
          const diskPath = this.getDiskIndexCachePath(pkgObj);
          await this.ensureDiskCacheSubdir('indexes');
          cachedIndex = await this.readDiskCacheJson<PackageIndex>(diskPath);
          if (cachedIndex) {
            memSetNoTtl(memKey, cachedIndex);
          }
        }
      } catch {
        cachedIndex = null;
      }
    }
    const shouldParseForIndex = !cachedIndex;

    const indexEntries: FileInPackageIndex[] = [];
    const handleEntryPromises: Promise<void>[] = [];

    const tempDirectory = createTempDir();
    this.logger.debug?.(`Extracting package to ${tempDirectory}`);
    const extract = tar.extract();

    // Inactivity timeout: reset whenever we see extraction progress (data or entry completion).
    // This avoids timing out on very large packages (e.g., *examples*) that can legitimately take a long time.
    let timeoutHandle: NodeJS.Timeout | undefined;
    let rejectTimeout: ((err: any) => void) | undefined;
    const armInactivityTimeout = () => {
      if (!Number.isFinite(this.extractTimeoutMs) || this.extractTimeoutMs <= 0) {
        return;
      }
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      timeoutHandle = setTimeout(() => {
        try {
          try {
            tarballStream.destroy(new Error('Tarball extraction timeout'));
          } catch {
            // ignore
          }
          try {
            extract.destroy(new Error('Tarball extraction timeout'));
          } catch {
            // ignore
          }
        } finally {
          const err: any = new Error(`Tarball extraction made no progress for ${this.extractTimeoutMs}ms`);
          err.code = 'ETIMEDOUT';
          rejectTimeout?.(err);
        }
      }, this.extractTimeoutMs);
    };
    const touchProgress = () => armInactivityTimeout();

    // Start the inactivity timer immediately and keep it alive while bytes flow.
    armInactivityTimeout();
    tarballStream.on('data', touchProgress);
    tarballStream.on('error', touchProgress);

    // Progress logs for very large packages (e.g., *examples*)
    let completedEntries = 0;
    const progressLogIntervalMs = 30000;
    const progressLogHandle = setInterval(() => {
      this.logger.debug?.(`Extracting package... completed ${completedEntries} entries so far`);
    }, progressLogIntervalMs);
    // Don't keep the process alive only for progress logging
    (progressLogHandle as any).unref?.();
  
    extract.on('entry', (header, stream, next) => {
      const fullPath = path.join(tempDirectory, header.name);
      const folderInTarball = path.dirname(header.name);
      const fileName = path.basename(header.name);

      touchProgress();
  
      try {
        if (header.type === 'directory') {
          fs.ensureDirSync(fullPath);
          touchProgress();
          stream.resume();
          stream.on('end', () => {
            completedEntries++;
            touchProgress();
            next();
          });
          stream.on('error', (err) => {
            extract.emit('error', err);
            next();
          });
          return;
        }

        if (header.type !== 'file') {
          // Drain unknown entry types to avoid stalling extraction
          touchProgress();
          stream.resume();
          stream.on('end', () => {
            completedEntries++;
            touchProgress();
            next();
          });
          stream.on('error', (err) => {
            extract.emit('error', err);
            next();
          });
          return;
        }

        // Always ensure directory exists
        fs.ensureDirSync(path.dirname(fullPath));

        // IMPORTANT: tar-stream requires us to fully consume the entry stream
        // before calling next(), otherwise extraction can hang.
        stream.on('data', touchProgress);
        const writePromise = pipeline(stream, fs.createWriteStream(fullPath));

        writePromise
          .then(() => {
            // Only rate-limit/parallelize the *parsing*, not the draining.
            if (
              shouldParseForIndex &&
              folderInTarball === 'package' &&
              fileName.endsWith('.json') &&
              fileName !== 'package.json' &&
              !fileName.endsWith('.index.json')
            ) {
              handleEntryPromises.push(
                limit(async () => {
                  const contentBuffer = await fs.readFile(fullPath, 'utf8');
                  try {
                    const content = JSON.parse(contentBuffer) as PackageResource;
                    const indexEntry = extractResourceIndexEntry(fileName, content);
                    indexEntries.push(indexEntry);
                  } catch (err) {
                    let errText = String(err);
                    if (!(err instanceof Error) && typeof err !== 'string') {
                      try {
                        errText = JSON.stringify(err);
                      } catch {
                        // fallback to String(err)
                      }
                    }
                    this.logger.warn(`Failed to parse ${fileName}: ${err instanceof Error ? err.message : errText}`);
                  }
                  touchProgress();
                })
              );
            }
          })
          .catch((err) => {
            extract.emit('error', err);
          })
          .finally(() => {
            completedEntries++;
            touchProgress();
            next();
          });
      } catch (err) {
        // Ensure we don't stall extraction if something throws synchronously
        try {
          stream.resume();
        } catch {
          // ignore
        }
        extract.emit('error', err);
        next();
      }
    });

    const extractionPromise = (async () => {
      await pipeline(
        tarballStream,
        zlib.createGunzip(),
        extract
      );

      await Promise.all(handleEntryPromises);
    })();

    const inactivityTimeoutPromise = new Promise<void>((_, reject) => {
      rejectTimeout = reject;
    });

    try {
      await Promise.race([extractionPromise, inactivityTimeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      tarballStream.off('data', touchProgress);
      tarballStream.off('error', touchProgress);
      clearInterval(progressLogHandle);
    }
  
    const indexJson: PackageIndex = {
      'index-version': 2,
      files: shouldParseForIndex ? indexEntries : (cachedIndex?.files || [])
    };
    await fs.writeJSON(path.join(tempDirectory, 'package', '.fpi.index.json'), indexJson);

    // If we computed an index for a known package version, persist to memory + per-cachePath disk (best-effort)
    if (shouldParseForIndex && pkgObj?.id && pkgObj?.version) {
      try {
        const memKey = this.getIndexMemKey(pkgObj);
        memSetNoTtl(memKey, indexJson);
        const diskPath = this.getDiskIndexCachePath(pkgObj);
        await this.ensureDiskCacheSubdir('indexes');
        await this.writeDiskCacheJsonNoTtl(diskPath, indexJson);
      } catch {
        // ignore
      }
    }
  
    this.logger.debug?.('Extracted to a temporary directory');
    return tempDirectory;
  }

  private async downloadAndExtractTarball(packageObject: FhirPackageIdentifier): Promise<string> {
    const cachedTgzPath = await this.getOrDownloadDiskCachedTarball(packageObject);
    try {
      return await this.extractTarball(cachedTgzPath, { packageObject });
    } catch (e: any) {
      if (e instanceof FhirPackageInstallError) throw e;
      let tarballUrl: string | undefined;
      try {
        tarballUrl = await this.getTarballUrl(packageObject);
      } catch {
        tarballUrl = undefined;
      }
      throw new FhirPackageInstallError({
        packageId: packageObject.id,
        version: packageObject.version ?? 'unknown',
        registryUrl: this.registryUrl,
        cachePath: this.cachePath,
        step: 'extract-tarball',
        tarballUrl,
        cause: e,
      });
    }
  }

  /**
   * Caches the package in the FHIR package cache directory.
   * If the package is already installed, it will not be reinstalled.
   * @param packageObject The package identifier object
   * @param src The source path of the package to be cached
   * @param move Whether to move the package to the cache or copy it. Defaults to **true**.
   * @returns The path to the cached package directory
   */
  private async cachePackage(packageObject: FhirPackageIdentifier, src: string, move: boolean = true): Promise<string> {
    let finalPath = await this.getPackageDirPath(packageObject);
    if (!await fs.exists(path.join(src, 'package'))) {
      finalPath = path.join(finalPath, 'package');
    }
    const isInstalled = await this.isInstalled(packageObject, { deep: false });
    if (!isInstalled) {
      // try to move the temp dir to the cache, this will fail if pkg was already installed by a parallel process
      try {
        const action = move ? fs.move : fs.copy;
        await action(src, finalPath, { overwrite: false });
        this.logger.info(`Installed ${packageObject.id}@${packageObject.version} in the FHIR package cache: ${finalPath}`);
      }
      catch (e: any) {
        // Another process may have installed the package concurrently.
        if (e?.code === 'EEXIST') {
          this.logger.warn(`Package ${packageObject.id}@${packageObject.version} already installed by another process`);
          return finalPath;
        }
        if (e instanceof FhirPackageInstallError) throw e;
        throw new FhirPackageInstallError({
          packageId: packageObject.id,
          version: packageObject.version ?? 'unknown',
          registryUrl: this.registryUrl,
          cachePath: this.cachePath,
          step: 'cache-package',
          cause: e,
        });
      }
    }
    return finalPath;
  }

  /**
   * Extracts the version of the package from a raw package identifier string.
   * Supported formats: `name@version`, `name#version`, or just `name`
   * @param packageId Raw package identifier string
   * @returns The version part or 'latest' if not supplied
   */
  private getVersionFromPackageString(packageId: string): string {
    const byPound = packageId.split('#');
    const byAt = packageId.split('@');
    if (byPound.length === 2) return byPound[1];
    if (byAt.length === 2) return byAt[1];
    return 'latest';
  }

  public async isInstalled(
    packageId: FhirPackageIdentifier | string,
    options?: { deep?: boolean }
  ): Promise<boolean> {
    const deep = options?.deep !== false;

    // Avoid resolving "latest" via registry for unversioned string checks.
    if (typeof packageId === 'string') {
      const packageIdStr = packageId.trim();
      if (packageIdStr.length === 0) {
        return false;
      }
      const hasExplicitVersion = packageIdStr.includes('#') || packageIdStr.includes('@');
      if (!hasExplicitVersion) {
        const installedVersions = await this.getInstalledVersions(packageIdStr);
        if (installedVersions.length === 0) return false;
        const latestInstalled = installedVersions[0];
        return await this.isInstalled({ id: packageIdStr, version: latestInstalled }, { deep });
      }
    }

    const packageObject = typeof packageId === 'string' ? await this.toPackageObject(packageId) : packageId;
    const dirPath = await this.getPackageDirPath(packageObject);
    if (!await fs.exists(dirPath)) {
      return false;
    }
    if (!await this.packageManifestExists(packageObject)) {
      return false;
    }
    if (!deep) {
      return true;
    }

    try {
      const missing = await this.collectMissingPackages(packageObject);
      return missing.length === 0;
    } catch (err: any) {
      // Deep validation errors should not be silently swallowed.
      // If we can't reliably validate dependencies due to infra / IO / parsing errors,
      // surface the failure to the caller.
      const code = err?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Treat common filesystem race conditions as "not installed".
        return false;
      }
      throw err;
    }
  }

  public async getPackageIndexFile(packageId: FhirPackageIdentifier | string): Promise<PackageIndex> {
    const indexPath = await this.getPackageIndexPath(packageId);
    if (await fs.exists(indexPath)) {
      return await fs.readJSON(indexPath, { encoding: 'utf8' });
    }
    return await this.generatePackageIndex(packageId);
  }

  public async checkLatestPackageDist(packageName: string): Promise<string> {
    if (this.isRegistryDisabled()) {
      throw new Error(this.formatRegistryDisabledMessage(
        `Cannot resolve latest version for ${packageName}. Pin an explicit version in configuration.`
      ));
    }

    // Latest is derived from the cached unversioned registry metadata (package document).
    // This keeps caching policy consistent and avoids maintaining a second, redundant cache.
    try {
      const packageData = await this.getPackageDataFromRegistry(packageName);
      const latest = packageData['dist-tags']?.latest;
      if (!latest) {
        throw new Error(`Package ${packageName} not found or has no latest version tag`);
      }
      return latest;
    } catch (onlineError: any) {
      this.logger.warn(
        `Failed to fetch latest version for ${packageName} from registry: ${onlineError?.message || onlineError}`
      );

      const installedVersions = await this.getInstalledVersions(packageName);
      if (installedVersions.length === 0) {
        throw new Error(
          `Failed to resolve latest version for ${packageName} from registry (${onlineError?.message || onlineError}). ` +
          `No installed versions found in cache (${this.cachePath}).`
        );
      }

      const latestInstalled = installedVersions[0];
      this.logger.warn(`Using latest installed version for ${packageName}: ${latestInstalled}`);
      return latestInstalled;
    }
  }

  public async toPackageObject(packageId: string | FhirPackageIdentifier): Promise<FhirPackageIdentifier> {
    let packageVersion: string;
    let packageName: string;
    if (typeof packageId === 'string') {
      const packageIdStr = packageId.trim();
      if (packageIdStr.length === 0) {
        throw new Error('Invalid package identifier: empty string');
      }
      packageName = packageIdStr.split('#')[0].split('@')[0];
      packageVersion = this.getVersionFromPackageString(packageIdStr);
    } else {
      packageName = packageId.id;
      packageVersion = packageId.version || 'latest';
    }
    if (packageVersion === 'latest') {
      if (this.isRegistryDisabled()) {
        throw new Error(this.formatRegistryDisabledMessage(
          `Cannot use the "latest" version feature for ${packageName}. Pin an explicit version (e.g., ${packageName}@x.y.z).`
        ));
      }
      packageVersion = await this.checkLatestPackageDist(packageName);
    }
    return { id: packageName, version: packageVersion };
  }

  private async readManifestFile(packageFolder: string): Promise<PackageManifest> {
    const manifestPath = path.join(packageFolder, 'package.json');
    return await fs.readJSON(manifestPath, { encoding: 'utf8' });
  }

  public async getManifest(packageId: string | FhirPackageIdentifier): Promise<PackageManifest> {
    const packageObj = typeof packageId === 'string' 
      ? await this.toPackageObject(packageId)
      : packageId;
    const manifestFile = await this.readManifestFile(path.join(await this.getPackageDirPath(packageObj), 'package'));
    if (manifestFile) {
      return manifestFile;
    }

    this.logger.warn(`Could not find package manifest for ${packageObj.id}${packageObj.version ? '@' + packageObj.version : ''}`);
    return { name: packageObj.id, version: packageObj.version || 'unknown' };
  }

  /**
   * Get the path to the FHIR package cache directory.
   * This directory is used to store downloaded and extracted FHIR packages.
   * If the directory does not exist, it will be created.
   * @returns {string} The path to the FHIR package cache directory
   */
  public getCachePath(): string {
    return this.cachePath;
  }

  /**
   * Get the logger instance used by this FhirPackageInstaller.
  */

  public getLogger(): Logger {
    return this.logger;
  }

  /**
   * Scan cache directory for installed versions of a package
   * @param packageName Package name to search for
   * @returns Array of installed versions sorted in descending order (latest first)
   */
  private async getInstalledVersions(packageName: string): Promise<string[]> {
    try {
      const cacheDirs = await fs.readdir(this.cachePath);
      const versions: string[] = [];
      
      for (const dirName of cacheDirs) {
        if (dirName.startsWith(`${packageName}#`)) {
          const version = dirName.substring(packageName.length + 1);
          versions.push(version);
        }
      }
      
      // Sort versions in descending order (latest first) using semver
      return versions.sort((a, b) => semver.rcompare(a, b));
    } catch (e) {
      this.logger.warn(`Failed to scan cache for package ${packageName}: ${e}`);
      return [];
    }
  }

  /**
   * Resolve an implicit package dependency to an effective version that is installed and manifest-valid.
   *
   * Candidate selection (online):
   *  1) dist-tags.latest
   *  2) next 2 most recent registry versions (semver desc)
   *
   * If the registry is disabled/unavailable, fall back to the latest installed, manifest-valid version.
   */
  private async resolveImplicitPackageVersionWithFallbacks(packageName: string): Promise<string> {
    const cacheKey = `implicit-effective|${this.registryUrl}|${this.cachePath}|${packageName}`;
    const cached = implicitEffectiveVersionCache.get(cacheKey);
    if (cached) return cached;

    return await withSingleFlight(inFlightImplicitEffectiveVersion, cacheKey, async () => {
      const cached2 = implicitEffectiveVersionCache.get(cacheKey);
      if (cached2) return cached2;

      const resolveFromInstalled = async (detail: string): Promise<string> => {
        this.logger.warn?.(detail);
        const installedVersions = await this.getInstalledVersions(packageName);
        const attempted: string[] = [];
        const causes: string[] = [];
        for (const v of installedVersions) {
          attempted.push(v);
          try {
            const ok = await this.isInstalled({ id: packageName, version: v }, { deep: false });
            if (ok) {
              implicitEffectiveVersionCache.set(cacheKey, v);
              return v;
            }
          } catch (e: any) {
            causes.push(`${v}: ${e?.message || String(e)}`);
          }
        }
        throw new ImplicitPackageResolutionError({
          packageId: packageName,
          attemptedVersions: attempted,
          registryUrl: this.registryUrl,
          cachePath: this.cachePath,
          causes
        });
      };

      // Registry disabled mode: never attempt downloads.
      if (this.isRegistryDisabled()) {
        return await resolveFromInstalled(
          `Registry disabled; using latest installed version for implicit package ${packageName} (if available)`
        );
      }

      // Online-first candidate gathering (using the existing cached registry metadata).
      let candidates: string[] = [];
      try {
        const packageData = await this.getPackageDataFromRegistry(packageName);
        const latest = packageData['dist-tags']?.latest as string | undefined;
        const versionsObj = (packageData.versions || {}) as Record<string, any>;
        const allVersions = Object.keys(versionsObj)
          .filter((v) => typeof v === 'string' && semver.valid(v))
          .sort((a, b) => semver.rcompare(a, b));

        const unique: string[] = [];
        const pushUnique = (v: string | undefined) => {
          if (!v || typeof v !== 'string') return;
          if (!unique.includes(v)) unique.push(v);
        };

        pushUnique(latest);
        for (const v of allVersions) {
          pushUnique(v);
          if (unique.length >= 3) break;
        }
        candidates = unique;
      } catch (e: any) {
        // Registry unavailable: use latest installed that is manifest-valid.
        return await resolveFromInstalled(
          `Failed to fetch registry metadata for implicit package ${packageName}: ${e?.message || String(e)}. ` +
          'Falling back to latest installed version (if available).'
        );
      }

      const attemptedVersions: string[] = [];
      const causes: string[] = [];
      for (const version of candidates) {
        attemptedVersions.push(version);
        const pkgObj = { id: packageName, version };
        try {
          const alreadyOk = await this.isInstalled(pkgObj, { deep: false });
          if (alreadyOk) {
            implicitEffectiveVersionCache.set(cacheKey, version);
            return version;
          }

          await this.install(pkgObj);
          const okAfterInstall = await this.isInstalled(pkgObj, { deep: false });
          if (okAfterInstall) {
            implicitEffectiveVersionCache.set(cacheKey, version);
            return version;
          }
          causes.push(`${version}: install completed but manifest missing`);
        } catch (e: any) {
          causes.push(`${version}: ${e?.message || String(e)}`);
        }
      }

      throw new ImplicitPackageResolutionError({
        packageId: packageName,
        attemptedVersions,
        registryUrl: this.registryUrl,
        cachePath: this.cachePath,
        causes
      });
    });
  }

  /**
   * Get implicit dependencies for a given package
   * @param packageObject The package to check for implicit dependencies
   * @returns Promise resolving to record of implicit dependencies
   */
  private async getImplicitDependencies(packageObject: FhirPackageIdentifier): Promise<Record<string, string>> {
    const implicitDeps: Record<string, string> = {};
    
    // Prevent recursion - if we're already resolving implicit deps for this package, return empty
    const packageKey = `${packageObject.id}@${packageObject.version}`;
    if (this.resolvingImplicitDeps.has(packageKey)) {
      return implicitDeps;
    }
    
    // Check if this package triggers implicit dependencies
    const implicitPackageIds = IMPLICIT_DEPENDENCIES_MAP[packageObject.id];
    if (!implicitPackageIds || implicitPackageIds.length === 0) {
      return implicitDeps;
    }
    
    // Mark this package as being resolved to prevent recursion
    this.resolvingImplicitDeps.add(packageKey);
    
    try {
      // Resolve versions for each implicit dependency.
      // If any implicit package can't be resolved (and isn't installed), we must fail startup.
      for (const implicitPackageId of implicitPackageIds) {
        const version = await this.resolveImplicitPackageVersionWithFallbacks(implicitPackageId);
        implicitDeps[implicitPackageId] = version;
      }
    } finally {
      // Always remove from tracking set
      this.resolvingImplicitDeps.delete(packageKey);
    }
    
    return implicitDeps;
  }

  /**
   * Get explicit dependencies from package.json only (internal use)
   * @param packageObject The package to get explicit dependencies for
   * @returns Promise resolving to record of explicit dependencies only
   */
  private async getExplicitDependencies(packageObject: FhirPackageIdentifier): Promise<Record<string, string>> {
    const deps = (await this.getManifest(packageObject))?.dependencies || {};
    // special case: some packages refer to hl7.fhir.r4.core as version 4.0.0 instead of 4.0.1
    if (deps && deps['hl7.fhir.r4.core'] === '4.0.0') {
      deps['hl7.fhir.r4.core'] = '4.0.1';
    }
    return deps;
  }

  /**
   * Get all dependencies for a package, including both explicit dependencies from package.json 
   * and automatic implicit dependencies for core FHIR packages.
   * 
   * For core FHIR packages (hl7.fhir.r3.core, hl7.fhir.r4.core, hl7.fhir.r5.core), 
   * this automatically includes essential terminology and extension packages.
   * 
   * @param packageObject The package to get dependencies for
   * @returns Promise resolving to record of all dependencies (explicit + implicit)
   */
  public async getDependencies(packageObject: FhirPackageIdentifier): Promise<Record<string, string>> {
    // Get explicit dependencies from package.json
    const explicitDeps = await this.getExplicitDependencies(packageObject);
    
    // Get implicit dependencies if this is a core package  
    const implicitDeps = await this.getImplicitDependencies(packageObject);
    
    // Merge dependencies, with explicit taking precedence over implicit
    return { ...implicitDeps, ...explicitDeps };
  }

  public async install(packageId: string | FhirPackageIdentifier): Promise<boolean> {
    let packageObject: FhirPackageIdentifier;
    if (typeof packageId === 'string') {
      packageId = packageId.trim();
      if (packageId.length === 0) {
        throw new Error('Invalid package identifier: empty string');
      }
      packageObject = await this.toPackageObject(packageId);
    } else {
      packageObject = packageId;
    }

    // Registry disabled mode: never attempt downloads.
    // All required packages (including transitive + implicit deps) must already exist.
    if (this.isRegistryDisabled()) {
      const missing = await this.collectMissingPackages(packageObject);
      if (missing.length > 0) {
        const preview = missing.slice(0, 10).join(', ');
        const suffix = missing.length > 10 ? ` (and ${missing.length - 10} more)` : '';
        throw new Error(this.formatRegistryDisabledMessage(
          `Required packages are missing or incomplete in cache (${this.cachePath}). Missing: ${preview}${suffix}`
        ));
      }
      return true;
    }
    
    // Prevent circular installations
    const packageKey = `${packageObject.id}@${packageObject.version}`;
    if (this.installingPackages.has(packageKey)) {
      return true;
    }
    
    // Only check that *this package* is present/complete.
    // Transitive dependency installation is handled by installPackageDependencies().
    const installedShallow = await this.isInstalled(packageObject, { deep: false });
    if (!installedShallow) {
      const dirPath = await this.getPackageDirPath(packageObject);
      if (await fs.exists(dirPath)) {
        // Clean up partial/corrupt installs so we can reinstall cleanly.
        await fs.remove(dirPath);
      }
      const tempPath = await this.downloadAndExtractTarball(packageObject);
      await this.cachePackage(packageObject, tempPath);
    }
    
    // Mark as installing before dependency installation
    this.installingPackages.add(packageKey);
    try {
      await this.installPackageDependencies(packageObject);
      return true;
    } finally {
      // Always remove from installing set
      this.installingPackages.delete(packageKey);
    }
  }

  private async installPackageDependencies(packageObject: FhirPackageIdentifier): Promise<void>{
    try {
      await this.getPackageIndexFile(packageObject);
    } catch (e: any) {
      if (e instanceof FhirPackageInstallError) throw e;
      throw new FhirPackageInstallError({
        packageId: packageObject.id,
        version: packageObject.version ?? 'unknown',
        registryUrl: this.registryUrl,
        cachePath: this.cachePath,
        step: 'generate-index',
        cause: e,
      });
    }
    
    // Get all dependencies (explicit + implicit) using the updated getDependencies method
    const allDeps = await this.getDependencies(packageObject);
    
    for (const dep in allDeps) {
      if (this.skipExamples && dep.includes('examples')) {
        continue;
      } else {
        await this.install(`${dep}@${allDeps[dep]}`);
      }
    }
  }

  /**
   * Installs a package from a local file or directory.
   * The package can be a tarball file or a directory containing the package files.
   * @param src The path to the local package file or directory.
   * @param options Options for installing the package.
   * @returns A promise that resolves to true if the package was installed successfully,
   * or false if it was already installed.
   */
  public async installLocalPackage(src: string, options?: InstallPackageOptions): Promise<boolean> {
    src = src.trim();
    if (src.length === 0) {
      throw new Error('Invalid path: empty string');
    }
    if (!await fs.exists(src)) {
      throw new Error(`Invalid path: ${src} does not exist`);
    }

    const fullPath = path.isAbsolute(src) ? src : path.resolve(src);
    const isDirectory = (await fs.lstat(fullPath)).isDirectory();
    let finalPath: string;

    if (isDirectory) {
      this.logger.info(`Installing package from directory: ${fullPath}`);
      finalPath = fullPath;
    } else {
      this.logger.info(`Installing package from file: ${fullPath}`);
      finalPath = await this.extractTarball(fullPath);
    }
  
    let packageObject: FhirPackageIdentifier;
    if (options?.packageId) {
      packageObject = await this.toPackageObject(options.packageId);
    } else {
      const potentialPackagePath = path.join(finalPath, 'package');
      const manifestFilePath = await fs.exists(potentialPackagePath) ? potentialPackagePath : finalPath;
      const manifest = await this.readManifestFile(manifestFilePath);
      packageObject = { id: manifest.name, version: manifest.version };
    }
      
    const alreadyInstalled = await this.isInstalled(packageObject, { deep: false });
    if (alreadyInstalled && !options?.override) {
      this.logger.info(`Package ${packageObject.id}@${packageObject.version} is already installed`);
      return false;
    } else {
      await fs.remove(await this.getPackageDirPath(packageObject));
    }

    const installedPath = await this.cachePackage(packageObject, finalPath, !isDirectory); // if the source is a file, we can move the temp dir to the cache
    await this.generatePackageIndex(packageObject);
    this.logger.info(`Installed ${packageObject.id}@${packageObject.version} in the FHIR package cache: ${installedPath}`);
  
    if (options?.installDependencies) {
      await this.installPackageDependencies(packageObject);
    }

    return true;
  }

  /**
   * Downloads a package tarball and optionally extracts it to a destination directory.
   * 
   * Behavior:
   * - If `extract` is false or omitted: downloads the tarball as a .tgz file to the destination directory.
   * - If `extract` is true: downloads and extracts the package into a subdirectory of the destination path.
   *
   * @param packageId A package identifier string or a FhirPackageIdentifier object.
   * @param options Options controlling the download and extraction behavior.
   * @returns 
   * - If `extract` is false: the full path to the downloaded tarball file.
   * - If `extract` is true: the full path to the extracted package directory.
   */
  public async downloadPackage(
    packageId: string | FhirPackageIdentifier,
    options?: DownloadPackageOptions): Promise<string> 
  {
    const { destination = '.', overwrite = false, extract = false } = options || {} as DownloadPackageOptions;

    const packageObject = await this.toPackageObject(packageId);
    const packageName = `${packageObject.id}@${packageObject.version}`;
    
    let finalPath = destination && path.isAbsolute(destination)
      ? destination
      : path.join(path.resolve(destination ||'.'));
    if (extract) {
      finalPath = path.join(finalPath, await this.toDirName(packageObject));
    } else {
      finalPath = path.join(finalPath, `${packageObject.id}-${packageObject.version}.tgz`);
    }
    this.logger.info(`Downloading ${(extract ? 'and extracting ' : '')}${packageName} to: ${finalPath}`);

    if (extract) {
      const tempDirectory = await this.downloadAndExtractTarball(packageObject);
      await fs.move(tempDirectory, finalPath, { overwrite });
    } else {
      const tempDirectory = await this.downloadTarball(packageObject);
      await fs.move(tempDirectory, finalPath, { overwrite });
    }
    this.logger.info(`Downloaded ${packageName} to: ${finalPath}`);
    return finalPath;
  }
}

/**
 * Default instance export for convenience
 */
const fpi = new FhirPackageInstaller();
export default fpi;

export type {
  PackageResource,
  DownloadPackageOptions,
  InstallPackageOptions,
  FpiConfig
} from './types';

export type {
  PackageIndex,
  PackageManifest,
  FileInPackageIndex
} from '@outburn/types';

