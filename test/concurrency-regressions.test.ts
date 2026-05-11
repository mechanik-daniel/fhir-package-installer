import crypto from 'crypto';
import path from 'path';
import fs from 'fs-extra';
import { describe, it, expect, vi } from 'vitest';

import { FhirPackageInstaller } from '../src/index';
import { createTempDir } from './temp-dir';
import type { Logger } from '@outburn/types';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const asPackageObject = (value: unknown): { id: string; version: string } => value as { id: string; version: string };

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