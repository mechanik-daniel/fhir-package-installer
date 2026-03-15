import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import type { Logger } from '@outburn/types';

import { FhirPackageInstaller } from '../src/index';
import { createLocalRegistryServer } from './local-registry-server';
import { createTempDir } from './temp-dir';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const TIMEOUT = 240000;

describe('Stable repeated implicit resolution errors (avoid downstream ENOENT)', () => {
  const cachePath = createTempDir();

  const registryPackages = {
    'hl7.terminology.r4': {
      latest: '7.1.0',
      versions: {
        '7.1.0': { tgz: Buffer.alloc(0) as any, tarballStatus: 404 },
        '7.0.0': { tgz: Buffer.alloc(0) as any, tarballStatus: 404 },
        '6.9.0': { tgz: Buffer.alloc(0) as any, tarballStatus: 404 },
      },
    },
  };

  const registry = createLocalRegistryServer(registryPackages);

  let fpi!: FhirPackageInstaller;

  beforeAll(async () => {
    await registry.start();
    await fs.remove(cachePath);
    await fs.ensureDir(cachePath);

    // Seed an installed core package manifest so getDependencies() can run
    // without going to the registry for hl7.fhir.r4.core.
    const corePackageDir = path.join(cachePath, 'hl7.fhir.r4.core#4.0.1', 'package');
    await fs.ensureDir(corePackageDir);
    await fs.writeJSON(path.join(corePackageDir, 'package.json'), {
      name: 'hl7.fhir.r4.core',
      version: '4.0.1',
      dependencies: {},
    });

    fpi = new FhirPackageInstaller({
      cachePath,
      skipExamples: true,
      allowHttp: true,
      registryUrl: registry.getBaseUrl(),
      logger: noopLogger,
    });
  }, 20000);

  afterAll(async () => {
    await registry.stop();
    await fs.remove(cachePath);
  }, 20000);

  it(
    'rethrows the implicit resolution failure from getManifest (not raw ENOENT) after implicit resolution fails',
    async () => {
      let resolveErr: unknown;
      try {
        await fpi.getDependencies({ id: 'hl7.fhir.r4.core', version: '4.0.1' });
      } catch (e) {
        resolveErr = e;
      }

      expect(resolveErr).toBeTruthy();
      expect(resolveErr instanceof Error ? resolveErr.name : String(resolveErr)).toBe('ImplicitPackageResolutionError');

      const getManifestErrorMessage = async (): Promise<string> => {
        try {
          await fpi.getManifest({ id: 'hl7.terminology.r4', version: '7.1.0' });
          return 'no-error';
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      };

      const msg1 = await getManifestErrorMessage();
      expect(msg1).toContain('Failed to resolve implicit package hl7.terminology.r4');
      expect(msg1).toContain('attemptedVersions=[');
      expect(msg1).toContain('7.1.0');
      expect(msg1).toContain('7.0.0');
      expect(msg1).toContain('6.9.0');
      expect(msg1).toContain(`registryUrl=${registry.getBaseUrl()}`);
      expect(msg1).toContain(`cachePath=${cachePath}`);
      expect(msg1).not.toContain('ENOENT');

      const msg2 = await getManifestErrorMessage();
      expect(msg2).toBe(msg1);
    },
    TIMEOUT
  );
});
