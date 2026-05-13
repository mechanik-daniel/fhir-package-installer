import crypto from 'crypto';
import path from 'path';
import fs from 'fs-extra';
import { describe, it, expect, vi } from 'vitest';

import { FhirPackageInstaller } from '../src/index';
import { createLocalRegistryServer, createTgzBuffer } from './local-registry-server';
import { createTempDir } from './temp-dir';
import type { Logger } from '@outburn/types';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const asPackageObject = (value: unknown): { id: string; version: string } => value as { id: string; version: string };

const writeInstalledPackage = async (
  cachePath: string,
  id: string,
  version: string,
  deps?: Record<string, string>
) => {
  const pkgDir = path.join(cachePath, `${id}#${version}`, 'package');
  await fs.ensureDir(pkgDir);
  await fs.writeJSON(path.join(pkgDir, 'package.json'), {
    name: id,
    version,
    dependencies: deps || {},
  });
};

describe('concurrency regressions', () => {
  it('keeps waiting for a live package install lock instead of bypassing it after request timeout', async () => {
    const cachePath = createTempDir();
    const installer = new FhirPackageInstaller({
      cachePath,
      requestTimeoutMs: 500,
      logger: noopLogger,
    });
    const packageObject = { id: 'example.pkg', version: '1.0.0' };
    const lockKey = `package-install|${packageObject.id}#${packageObject.version}`;
    const lockPath = path.join(
      cachePath,
      '.fpi.cache',
      'locks',
      `${crypto.createHash('sha256').update(lockKey).digest('hex')}.lock`
    );

    await fs.ensureDir(path.dirname(lockPath));
    await fs.writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, 'utf8');

    const heartbeat = setInterval(() => {
      fs.utimes(lockPath, new Date(), new Date()).catch(() => undefined);
    }, 100);

    try {
      const startedAt = Date.now();
      const completionTimePromise = (installer as any).withPackageInstallLock(packageObject, async () => Date.now());

      await new Promise((resolve) => setTimeout(resolve, 1300));
      await fs.remove(lockPath);

      const completionTime = await completionTimePromise;
      expect(completionTime - startedAt).toBeGreaterThanOrEqual(1200);
    } finally {
      clearInterval(heartbeat);
      await fs.remove(lockPath).catch(() => undefined);
      await fs.remove(cachePath).catch(() => undefined);
    }
  });

  it('waits for a peer to finish materializing a dependency before failing manifest lookup', async () => {
    const cachePath = createTempDir();
    const installer = new FhirPackageInstaller({
      cachePath,
      requestTimeoutMs: 500,
      logger: noopLogger,
    });
    const packageObject = { id: 'hl7.terminology.r4', version: '7.1.0' };
    const lockKey = `package-install|${packageObject.id}#${packageObject.version}`;
    const lockPath = path.join(
      cachePath,
      '.fpi.cache',
      'locks',
      `${crypto.createHash('sha256').update(lockKey).digest('hex')}.lock`
    );
    const packageDir = path.join(cachePath, `${packageObject.id}#${packageObject.version}`, 'package');

    await fs.ensureDir(path.dirname(lockPath));
    await fs.ensureDir(packageDir);
    await fs.writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, 'utf8');

    const heartbeat = setInterval(() => {
      fs.utimes(lockPath, new Date(), new Date()).catch(() => undefined);
    }, 100);

    const materializeTimeout = setTimeout(async () => {
      await fs.writeJSON(path.join(packageDir, 'package.json'), {
        name: packageObject.id,
        version: packageObject.version,
        dependencies: {},
      });
      await fs.remove(lockPath).catch(() => undefined);
    }, 250);

    try {
      await expect(installer.getManifest(packageObject)).resolves.toMatchObject({
        name: packageObject.id,
        version: packageObject.version,
      });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(materializeTimeout);
      await fs.remove(lockPath).catch(() => undefined);
      await fs.remove(cachePath).catch(() => undefined);
    }
  });

  it('waits for a locked explicit dependency manifest before recomputing implicit latest from lossy planning metadata', async () => {
    const cachePath = createTempDir();
    const registryPackages = {
      'hl7.terminology.r4': {
        latest: '7.1.0',
        versions: {
          '7.1.0': { tgz: Buffer.alloc(0) as any },
        },
      },
      'hl7.fhir.uv.extensions.r4': {
        latest: '5.2.0',
        versions: {
          '5.2.0': { tgz: Buffer.alloc(0) as any },
          '5.3.0-ballot-tc1': { tgz: Buffer.alloc(0) as any, tarballStatus: 404 },
        },
      },
    };
    const registry = createLocalRegistryServer(registryPackages);

    await registry.start();

    registryPackages['hl7.terminology.r4'].versions['7.1.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.terminology.r4', version: '7.1.0', dependencies: {} }),
    });
    registryPackages['hl7.fhir.uv.extensions.r4'].versions['5.2.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.fhir.uv.extensions.r4', version: '5.2.0', dependencies: {} }),
    });

    const installer = new FhirPackageInstaller({
      cachePath,
      allowHttp: true,
      requestTimeoutMs: 2000,
      registryUrl: registry.getBaseUrl(),
      logger: noopLogger,
    });

    const rootPackage = { id: 'il.hdp.fhir.r4', version: '0.4.5' };
    const extensionsPackage = { id: 'hl7.fhir.uv.extensions.r4', version: '5.3.0-ballot-tc1' };
    const lockKey = `package-install|${extensionsPackage.id}#${extensionsPackage.version}`;
    const lockPath = path.join(
      cachePath,
      '.fpi.cache',
      'locks',
      `${crypto.createHash('sha256').update(lockKey).digest('hex')}.lock`
    );
    const packageDir = path.join(cachePath, `${extensionsPackage.id}#${extensionsPackage.version}`, 'package');

    await writeInstalledPackage(cachePath, rootPackage.id, rootPackage.version, {
      'il.core.fhir.r4': '0.20.4',
    });
    await writeInstalledPackage(cachePath, 'il.core.fhir.r4', '0.20.4', {
      'hl7.fhir.r4.core': '4.0.1',
      'hl7.fhir.uv.extensions.r4': '5.3.0-ballot-tc1',
    });
    await writeInstalledPackage(cachePath, 'hl7.fhir.r4.core', '4.0.1');

    await fs.ensureDir(path.dirname(lockPath));
    await fs.ensureDir(packageDir);
    await fs.writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, 'utf8');

    const heartbeat = setInterval(() => {
      fs.utimes(lockPath, new Date(), new Date()).catch(() => undefined);
    }, 100);

    const materializeTimeout = setTimeout(async () => {
      await fs.writeJSON(path.join(packageDir, 'package.json'), {
        name: extensionsPackage.id,
        version: extensionsPackage.version,
        dependencies: {
          'hl7.fhir.r4.core': '4.0.1',
          'hl7.terminology.r4': '6.5.0',
        },
      });
      await fs.remove(lockPath).catch(() => undefined);
    }, 1200);

    try {
      const deps = await installer.getDependencies(
        { id: 'hl7.fhir.r4.core', version: '4.0.1' },
        { rootPackage }
      );

      expect(deps['hl7.terminology.r4']).toBe('6.5.0');
      expect(deps['hl7.terminology.r4']).not.toBe('7.1.0');
    } finally {
      clearInterval(heartbeat);
      clearTimeout(materializeTimeout);
      await fs.remove(lockPath).catch(() => undefined);
      await registry.stop();
      await fs.remove(cachePath).catch(() => undefined);
    }
  });

  it('reuses the winning implicit dependency candidate instead of falling back after a concurrent publish race', async () => {
    const installer = new FhirPackageInstaller({
      cachePath: createTempDir(),
      logger: noopLogger,
    });

    const getPackageDataFromRegistry = vi
      .spyOn(installer as any, 'getPackageDataFromRegistry')
      .mockResolvedValue({
        'dist-tags': { latest: '7.1.0' },
        versions: {
          '7.1.0': {},
          '7.0.1': {},
          '6.9.0': {},
        },
      });

    const hasReadableManifest = vi
      .spyOn(installer as any, 'hasReadableManifest')
      .mockResolvedValue(false);

    const install = vi
      .spyOn(installer as any, 'install')
      .mockImplementation(async (...args: unknown[]) => {
        const packageObject = asPackageObject(args[0]);
        if (packageObject.version === '7.1.0') {
          const error = new Error('dest already exists.') as Error & { code?: string };
          error.code = 'EEXIST';
          throw error;
        }

        throw new Error(`unexpected fallback install: ${packageObject.version}`);
      });

    const isStrictlyMaterialized = vi
      .spyOn(installer as any, 'isStrictlyMaterialized')
      .mockImplementation(async (...args: unknown[]) => asPackageObject(args[0]).version === '7.1.0');

    const resolvedVersion = await (installer as any).resolveImplicitPackageVersionWithFallbacks('hl7.terminology.r4');

    expect(resolvedVersion).toBe('7.1.0');
    expect(getPackageDataFromRegistry).toHaveBeenCalledWith('hl7.terminology.r4');
    expect(hasReadableManifest).toHaveBeenCalled();
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith({ id: 'hl7.terminology.r4', version: '7.1.0' });
    expect(isStrictlyMaterialized).toHaveBeenCalledWith({ id: 'hl7.terminology.r4', version: '7.1.0' });
  });
});