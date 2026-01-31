import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { FhirPackageInstaller } from 'fhir-package-installer';
import type { Logger } from '@outburn/types';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const skipLive = process.env.FPI_SKIP_LIVE_REGISTRY === '1';

(skipLive ? describe.skip : describe)('Live Registry Download (packages.fhir.org)', () => {
  it(
    'can download a real package tarball from the official registry',
    { timeout: 2 * 60_000 },
    async () => {
      // Pick a relatively small package to keep this test quick.
      // (Still exercises real network + tarball endpoint.)
      const pkg = { id: 'hl7.fhir.uv.sdc', version: '3.0.0' };

      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fpi-live-download-'));
      const cachePath = path.join(root, 'cache');
      const dest = path.join(root, 'out');

      try {
        await fs.ensureDir(dest);
        const fpi = new FhirPackageInstaller({ cachePath, logger: noopLogger });
        const tgzPath = await fpi.downloadPackage(pkg, { destination: dest, extract: false, overwrite: true });
        expect(await fs.exists(tgzPath)).toBe(true);
        const stat = await fs.stat(tgzPath);
        expect(stat.size).toBeGreaterThan(0);
      } finally {
        await fs.remove(root).catch(() => undefined);
      }
    }
  );
});
