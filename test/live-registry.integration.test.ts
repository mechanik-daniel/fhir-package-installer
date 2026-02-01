import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import semver from 'semver';
import { FhirPackageInstaller } from 'fhir-package-installer';
import type { Logger } from '@outburn/types';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const skipLive = process.env.FPI_SKIP_LIVE_REGISTRY === '1';

(skipLive ? describe.skip : describe)('Live Registry Integration (packages.fhir.org)', () => {
  it(
    'can resolve a real package latest version from the official registry',
    { timeout: 90_000 },
    async () => {
      const cachePath = await fs.mkdtemp(path.join(os.tmpdir(), 'fpi-live-registry-'));
      try {
        const fpi = new FhirPackageInstaller({
          cachePath,
          registryUrl: 'https://packages.fhir.org',
          requestTimeoutMs: 30_000,
          logger: noopLogger,
        });

        const latest = await fpi.checkLatestPackageDist('hl7.fhir.r4.core');
        expect(typeof latest).toBe('string');
        expect(semver.valid(latest)).not.toBeNull();
      } finally {
        await fs.remove(cachePath);
      }
    }
  );
});
