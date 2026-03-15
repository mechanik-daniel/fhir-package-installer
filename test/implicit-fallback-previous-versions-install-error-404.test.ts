import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs-extra';
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

describe('Rich install errors (implicit-fallback-previous-versions)', () => {
  const cachePath = createTempDir();

  const pkg = { id: 'test.install.404', version: '1.0.0' };

  const registryPackages = {
    [pkg.id]: {
      latest: pkg.version,
      versions: {
        [pkg.version]: {
          // Version is present in metadata, but tarball fetch fails.
          tgz: Buffer.alloc(0) as any,
          tarballStatus: 404,
        },
      },
    },
  };

  const registry = createLocalRegistryServer(registryPackages);

  let fpi!: FhirPackageInstaller;

  beforeAll(async () => {
    await registry.start();
    await fs.remove(cachePath);

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
    'includes package@version + registryUrl + tarball URL on 404 tarball download',
    async () => {
      let thrown: unknown;
      try {
        await fpi.install(pkg);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeTruthy();
      const msg = thrown instanceof Error ? thrown.message : String(thrown);

      expect(msg).toContain(`${pkg.id}@${pkg.version}`);
      expect(msg).toContain(`registryUrl=${registry.getBaseUrl()}`);
      expect(msg).toContain(`/${pkg.id}/-/${pkg.id}-${pkg.version}.tgz`);
      expect(msg).toContain('step=download-tarball');
    },
    TIMEOUT
  );
});
