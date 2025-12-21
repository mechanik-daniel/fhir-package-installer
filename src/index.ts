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
import temp from 'temp';
import os from 'os';
import semver from 'semver';
import shallowParse from './shallowParse';

import type {
  FpiConfig,
  FileInPackageIndex,
  PackageIndex,
  PackageManifest,
  PackageResource,
  DownloadPackageOptions,
  InstallPackageOptions,
  ILatestVersionCache
} from './types';
import { MemoryLatestVersionCache } from './types';
import { Logger, FhirPackageIdentifier } from '@outburn/types';

temp.track();

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

/**
 * default logger uses global console methods
 */
const defaultLogger: Logger = {
  info: (msg: any) => console.log(msg),
  warn: (msg: any) => console.warn(msg),
  error: (msg: any) => console.error(msg)
};

/**
 * Default prethrow function does nothing since the regular throw prints to console.log, which is the default logger
 */
const prethrow = (msg: Error | any): Error => {
  if (msg instanceof Error) {
    return msg;
  }
  const error = new Error(msg);
  return error;
};

/**
 * Max number of concurrent file operations (read / write))
 */
const limit = pLimit(Math.max(4, os.cpus().length));

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
  private registryToken?: string; // optional token for private registries
  private fallbackUrlBase = 'https://packages.simplifier.net';
  private requestTimeoutMs = 90000; // 90 seconds
  private extractTimeoutMs = 60000; // 60 seconds
  /**
   * Path to the FHIR package cache directory.
   * This directory is used to store downloaded and extracted FHIR packages.
   * If the directory does not exist, it will be created.
   */
  private cachePath: string = path.join(os.homedir(), '.fhir', 'packages');
  private skipExamples = false; // skip dependency installation of example packages
  private allowHttp = false; // allow HTTP URLs for testing
  private prethrow: (msg: Error | any) => Error = prethrow;
  private latestVersionCache: ILatestVersionCache;
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
      latestVersionCache,
      requestTimeoutMs,
      extractTimeoutMs
    } = config || {} as FpiConfig;
    if (registryUrl) {
      this.registryUrl = registryUrl;
    }
    if (registryToken) {
      this.registryToken = registryToken;
    }
    if (cachePath) {
      this.cachePath = cachePath;
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
    if (logger) {
      this.logger = logger;
      this.prethrow = (msg: Error | any) => {
        if (!(msg instanceof Error)) {
          msg = new Error(msg);
        }
        this.logger.error(msg.message);
        this.logger.error(JSON.stringify(msg, null, 2));
        return msg;
      };
    };
    if (skipExamples) {
      this.skipExamples = skipExamples;
    }
    
    // Initialize latest version cache (use provided one or create new default)
    this.latestVersionCache = latestVersionCache || new MemoryLatestVersionCache();
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
    try {
      return path.join(this.cachePath, await this.toDirName(packageId));
    } catch (e) {
      throw this.prethrow(e);
    }
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
    this.logger.info(`Generating new .fpi.index.json file for package ${pckIdObj.id}@${pckIdObj.version}...`);
    const packagePath = await this.getPackageDirPath(pckIdObj);
    const indexPath = await this.getPackageIndexPath(pckIdObj);
    try {
      const fileList = await fs.readdir(path.join(packagePath, 'package'));
      const files = await Promise.all(
        fileList.filter(
          file => file.endsWith('.json') && file !== 'package.json' && !file.endsWith('.index.json')
        ).map(
          file => limit(
            async () => {
              const content = shallowParse(await fs.readFile(path.join(packagePath, 'package', file), { encoding: 'utf8' }));
              const indexEntry = extractResourceIndexEntry(file, content as PackageResource);
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
      return indexJson;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
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
    if (this.registryToken) {
      const registryHostname = new URL(this.registryUrl).hostname;
      const urlHostname = new URL(url).hostname;
      
      if (url.startsWith(this.registryUrl) || urlHostname === registryHostname) {
        options.headers = {
          'Authorization': `Bearer ${this.registryToken}`
        };
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
          this.logger.info(`Following redirect from ${url} to ${displayUrl}`);
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
    
    try {
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
            this.logger.info(`Following redirect from ${url} to ${displayUrl}`);
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
            reject(new Error(`Failed to fetch ${url} (status ${res.statusCode})`));
          }
        });

        req.setTimeout(this.requestTimeoutMs, () => {
          const timeoutErr: any = new Error(`Request timed out after ${this.requestTimeoutMs}ms while fetching ${url}`);
          timeoutErr.code = 'ETIMEDOUT';
          req.destroy(timeoutErr);
        });

        req.on('error', reject);
      }));      
    } catch (e) {
      this.logger.error(`Failed to fetch stream from ${url}`);
      throw e;
    }
  }  

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
    onTimeout?: () => void
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return await promise;
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        try {
          onTimeout?.();
        } finally {
          const err: any = new Error(`${label} timed out after ${timeoutMs}ms`);
          err.code = 'ETIMEDOUT';
          reject(err);
        }
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async getPackageDataFromRegistry(packageName: string): Promise<Record<string, any>> {
    return await this.fetchJson(`${this.registryUrl}/${packageName}/`);
  }

  private async getTarballUrl(packageObject: FhirPackageIdentifier): Promise<string> {
    const isPrivateRegistry = this.registryUrl !== 'https://packages.fhir.org';
    
    // Always fetch package metadata for validation and version information
    let packageData: Record<string, any>;
    try {
      packageData = await this.getPackageDataFromRegistry(packageObject.id);
    } catch {
      throw new Error(`Package ${packageObject.id} not found in the registry at ${this.registryUrl}.`);
    }
    
    // Validate that the specific version exists
    if (!packageObject.version || !packageData.versions?.[packageObject.version]) {
      throw new Error(`Package ${packageObject.id}@${packageObject.version} not found in the registry at ${this.registryUrl}.`);
    }
    
    // For private registries, construct the URL using the registry base (don't trust provided tarball URLs)
    if (isPrivateRegistry) {
      return `${this.registryUrl}/${packageObject.id}/-/${packageObject.id}-${packageObject.version}.tgz`;
    }
    
    // For the default registry, try to get the tarball URL from package metadata
    const url = packageData.versions[packageObject.version!]?.dist?.tarball ?? packageData.versions[packageObject.version!]?.url;
    if (!url) {
      return `${this.fallbackUrlBase}/${packageObject.id}/-/${packageObject.id}-${packageObject.version}.tgz`;
    }
    return url;
  }

  private async downloadFile(url: string, destination: string): Promise<void> {
    try {
      const tarballStream = await this.fetchStream(url);
      const fileStream = fs.createWriteStream(destination);
      await finished(tarballStream.pipe(fileStream));
    } catch (e) {
      this.logger.error(`Failed to download file from ${url}`);
      throw e;
    }
  }

  private async downloadTarball(packageObject: FhirPackageIdentifier): Promise<string> {
    const tempDirectory = temp.mkdirSync();
    const tarballPath = path.join(tempDirectory, `${packageObject.id}-${packageObject.version}.tgz`);
    const tarballUrl = await this.getTarballUrl(packageObject);
    
    this.logger.info(`Downloading ${packageObject.id}@${packageObject.version} from ${tarballUrl}`);
    try {
      await this.downloadFile(tarballUrl, tarballPath);
    } catch (e) {
      this.logger.error(`Failed to download package ${packageObject.id}@${packageObject.version} from ${tarballUrl}`);
      throw e;
    }
    return tarballPath;
  }

  /**
   * Extracts a tarball to a temporary directory and generates a new `.fpi.index.json` file.
   * The tarball can be a file path or a stream.
   * @param src The source tarball, either a file path or a Readable stream.
   * @returns The path to the temporary directory where the package was extracted.
   */
  private async extractTarball(src: string | Readable): Promise<string> {
    const tarballStream: Readable = typeof src === 'string' ? fs.createReadStream(src) : src;
    
    const indexEntries: FileInPackageIndex[] = [];
    const handleEntryPromises: Promise<void>[] = [];

    const tempDirectory = temp.mkdirSync();
    this.logger.info(`Extracting package to ${tempDirectory}`);
    const extract = tar.extract();
  
    extract.on('entry', (header, stream, next) => {
      const fullPath = path.join(tempDirectory, header.name);
      const folderInTarball = path.dirname(header.name);
      const fileName = path.basename(header.name);
  
      try {
        if (header.type === 'directory') {
          fs.ensureDirSync(fullPath);
          stream.resume();
          stream.on('end', () => next());
          stream.on('error', (err) => {
            extract.emit('error', err);
            next();
          });
          return;
        }

        if (header.type !== 'file') {
          // Drain unknown entry types to avoid stalling extraction
          stream.resume();
          stream.on('end', () => next());
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
        const writePromise = pipeline(stream, fs.createWriteStream(fullPath));

        writePromise
          .then(() => {
            // Only rate-limit/parallelize the *parsing*, not the draining.
            if (
              folderInTarball === 'package' &&
              fileName.endsWith('.json') &&
              fileName !== 'package.json' &&
              !fileName.endsWith('.index.json')
            ) {
              handleEntryPromises.push(
                limit(async () => {
                  const contentBuffer = await fs.readFile(fullPath, 'utf8');
                  try {
                    const content = shallowParse(contentBuffer) as PackageResource;
                    const indexEntry = extractResourceIndexEntry(fileName, content);
                    indexEntries.push(indexEntry);
                  } catch (err) {
                    console.error(`Failed to parse ${fileName}:`, err);
                  }
                })
              );
            }
          })
          .catch((err) => {
            extract.emit('error', err);
          })
          .finally(() => {
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

    await this.withTimeout(
      extractionPromise,
      this.extractTimeoutMs,
      'Tarball extraction',
      () => {
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
      }
    );
  
    const indexJson: PackageIndex = {
      'index-version': 2,
      files: indexEntries
    };
    await fs.writeJSON(path.join(tempDirectory, 'package', '.fpi.index.json'), indexJson);
  
    this.logger.info('Extracted to a temporary directory');
    return tempDirectory;
  }

  private async downloadAndExtractTarball(packageObject: FhirPackageIdentifier): Promise<string> {
    const tarballUrl = await this.getTarballUrl(packageObject);
    this.logger.info(`Downloading ${packageObject.id}@${packageObject.version} from ${tarballUrl}`);
    const tarballStream = await this.fetchStream(tarballUrl);
    return await this.extractTarball(tarballStream);
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
    const isInstalled = await this.isInstalled(packageObject);
    if (!isInstalled) {
      // try to move the temp dir to the cache, this will fail if pkg was already installed by a parallel process
      try {
        const action = move ? fs.move : fs.copy;
        await action(src, finalPath, { overwrite: false });
        this.logger.info(`Installed ${packageObject.id}@${packageObject.version} in the FHIR package cache: ${finalPath}`);
      }
      catch {
        this.logger.warn(`Package ${packageObject.id}@${packageObject.version} already installed by another process`);
        return finalPath;
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

  public async isInstalled(packageId: FhirPackageIdentifier | string): Promise<boolean> {
    try {
      return await fs.exists(await this.getPackageDirPath(packageId));      
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  public async getPackageIndexFile(packageId: FhirPackageIdentifier | string): Promise<PackageIndex> {
    try {
      const indexPath = await this.getPackageIndexPath(packageId);
      if (await fs.exists(indexPath)) {
        return await fs.readJSON(indexPath, { encoding: 'utf8' });
      }
      return await this.generatePackageIndex(packageId);
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  public async checkLatestPackageDist(packageName: string): Promise<string> {
    try {
      // Check cache first
      const cachedVersion = this.latestVersionCache.get(packageName);
      if (cachedVersion) {
        return cachedVersion;
      }

      // Cache miss, fetch from registry
      this.logger.info(`Fetching latest version for FHIR package ${packageName} from registry`);
      const packageData = await this.getPackageDataFromRegistry(packageName);
      const latest = packageData['dist-tags']?.latest;
      if (!latest) {
        throw new Error(`Package ${packageName} not found or has no latest version tag`);
      }
      
      // Store in cache
      this.latestVersionCache.set(packageName, latest);
      return latest;
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  public async toPackageObject(packageId: string | FhirPackageIdentifier): Promise<FhirPackageIdentifier> {
    try {
      let packageVersion: string;
      let packageName: string;
      if (typeof packageId === 'string') {
        const packageIdStr = packageId.trim();
        if (packageIdStr.length === 0) {
          this.logger.error('Invalid package identifier: empty string');
          throw new Error('Invalid package identifier: empty string');
        }
        packageName = packageIdStr.split('#')[0].split('@')[0];
        packageVersion = this.getVersionFromPackageString(packageIdStr);
      } else {
        packageName = packageId.id;
        packageVersion = packageId.version || 'latest';
      }
      if (packageVersion === 'latest') {
        try {
          packageVersion = await this.checkLatestPackageDist(packageName);
        } catch (e) {
          this.logger.error(`Failed to fetch latest version for package ${packageName}`);
          throw this.prethrow(e);
        }
      }
      return { id: packageName, version: packageVersion };
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  private async readManifestFile(packageFolder: string): Promise<PackageManifest> {
    const manifestPath = path.join(packageFolder, 'package.json');
    return await fs.readJSON(manifestPath, { encoding: 'utf8' });
  }

  public async getManifest(packageId: string | FhirPackageIdentifier): Promise<PackageManifest> {
    try {
      const packageObj = typeof packageId === 'string' 
        ? await this.toPackageObject(packageId)
        : packageId;
      const manifestFile = await this.readManifestFile(path.join(await this.getPackageDirPath(packageObj), 'package'));
      if (manifestFile) {
        return manifestFile;
      } else {
        this.logger.warn(`Could not find package manifest for ${packageObj.id}@${packageObj.version}`);
        return { name: packageObj.id, version: packageObj.version || 'unknown' };
      }
    } catch (e) {
      throw this.prethrow(e);
    }
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
   * Resolve the latest version for an implicit package dependency
   * Tries online registry first, then falls back to latest cached version
   * @param packageName The implicit package name
   * @returns Resolved version or throws if no version found
   */
  private async resolveLatestImplicitPackageVersion(packageName: string): Promise<string> {
    // First try to get the latest version from registry (using existing cache)
    try {
      const latest = await this.checkLatestPackageDist(packageName);
      return latest;
    } catch (onlineError: any) {
      this.logger.warn(`Failed to fetch latest version for implicit package ${packageName} from registry: ${onlineError?.message || onlineError}`);
      
      // Fallback to latest cached version
      const installedVersions = await this.getInstalledVersions(packageName);
      if (installedVersions.length === 0) {
        throw new Error(`No version of implicit package ${packageName} found in cache. Cannot determine version to use.`);
      }
      
      const latestCached = installedVersions[0]; // Already sorted with latest first
      this.logger.warn(`Using cached version for implicit package ${packageName}: ${latestCached}`);
      
      // Update the cache with this fallback version so other operations can reuse it
      this.latestVersionCache.set(packageName, latestCached);
      
      return latestCached;
    }
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
      
      // Resolve versions for each implicit dependency
      for (const implicitPackageId of implicitPackageIds) {
        try {
          const version = await this.resolveLatestImplicitPackageVersion(implicitPackageId);
          implicitDeps[implicitPackageId] = version;
        } catch (e: any) {
          this.logger.warn(`Failed to resolve implicit dependency ${implicitPackageId}: ${e?.message || e}`);
          // Continue with other implicit dependencies rather than failing completely
        }
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
    try {
      const deps = (await this.getManifest(packageObject))?.dependencies || {};
      // special case: some packages refer to hl7.fhir.r4.core as version 4.0.0 instead of 4.0.1
      if (deps && deps['hl7.fhir.r4.core'] === '4.0.0') {
        deps['hl7.fhir.r4.core'] = '4.0.1';
      }
      return deps;
    } catch (e) {
      throw this.prethrow(e);
    }    
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
    try {
      // Get explicit dependencies from package.json
      const explicitDeps = await this.getExplicitDependencies(packageObject);
      
      // Get implicit dependencies if this is a core package  
      const implicitDeps = await this.getImplicitDependencies(packageObject);
      
      // Merge dependencies, with explicit taking precedence over implicit
      return { ...implicitDeps, ...explicitDeps };
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  public async install(packageId: string | FhirPackageIdentifier): Promise<boolean> {
    try {
      let packageObject: FhirPackageIdentifier;
      if (typeof packageId === 'string') {
        packageId = packageId.trim();
        if (packageId.length === 0) {
          this.logger.error('Invalid package identifier: empty string');
          throw new Error('Invalid package identifier: empty string');
        }
        packageObject = await this.toPackageObject(packageId);
      } else {
        packageObject = packageId;
      }
      
      // Prevent circular installations
      const packageKey = `${packageObject.id}@${packageObject.version}`;
      if (this.installingPackages.has(packageKey)) {
        return true;
      }
      
      const alreadyInstalled = await this.isInstalled(packageObject);
      if (!alreadyInstalled) {
        try {
          const tempPath = await this.downloadAndExtractTarball(packageObject);
          await this.cachePackage(packageObject, tempPath);
        } catch (e) {
          this.logger.error(`Failed to install package ${packageObject.id}@${packageObject.version}`);
          throw this.prethrow(e);
        }
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
    } catch (e) {
      throw this.prethrow(e);
    }
  }

  private async installPackageDependencies(packageObject: FhirPackageIdentifier): Promise<void>{
    await this.getPackageIndexFile(packageObject);
    
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
    try {
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
        
      const alreadyInstalled = await this.isInstalled(packageObject);
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
    } catch (e) {
      throw this.prethrow(e);
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
    try {
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
  
      try {
        if (extract) {
          const tempDirectory = await this.downloadAndExtractTarball(packageObject);
          await fs.move(tempDirectory, finalPath, { overwrite });
        } else {
          const tempDirectory = await this.downloadTarball(packageObject);
          await fs.move(tempDirectory, finalPath, { overwrite });
        }
        this.logger.info(`Downloaded ${packageName} to: ${finalPath}`);
      } catch (e) {
        this.logger.error(`Failed to download package ${packageName}`);
        throw this.prethrow(e);
      }
      return finalPath;
    }
    catch (e) {
      throw this.prethrow(e);
    }
  }
}

/**
 * Default instance export for convenience
 */
const fpi = new FhirPackageInstaller();
export default fpi;

export type {
  PackageIndex,
  PackageManifest,
  FileInPackageIndex,
  PackageResource,
  DownloadPackageOptions,
  InstallPackageOptions,
  FpiConfig,
  ILatestVersionCache
} from './types';

export { MemoryLatestVersionCache } from './types';
