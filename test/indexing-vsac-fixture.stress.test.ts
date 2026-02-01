import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { FhirPackageInstaller } from 'fhir-package-installer';
import type { Logger } from '@outburn/types';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const skipVsac = process.env.FPI_SKIP_VSAC_STRESS === '1';
const keepStressCache = process.env.FPI_KEEP_STRESS_CACHE === '1';

(skipVsac ? describe.skip : describe)('Indexing Stress (VSAC)', () => {
  it(
    'can index VSAC without crashing (Windows open-files regression guard)',
    { timeout: 10 * 60_000 },
    async () => {
      // Keep this cachePath stable across runs so tarballs and extracted packages are reused.
      // This keeps the default test run from re-downloading VSAC every time.
      const cachePath = path.join(path.resolve('.'), 'test', '.test-cache-vsac-stress');
      const pkg = { id: 'us.nlm.vsac', version: '0.11.0' };
      const pkgDir = path.join(cachePath, `${pkg.id}#${pkg.version}`, 'package');

      const indexPath = path.join(pkgDir, '.fpi.index.json');
      const cacheSideDir = path.join(cachePath, '.fpi.cache');
      const indexesDir = path.join(cacheSideDir, 'indexes');

      try {
        await fs.ensureDir(cachePath);
        const installer = new FhirPackageInstaller({ cachePath, logger: noopLogger });
        // Use the standard install flow so dependency installs (if any) are handled and cached.
        // Subsequent runs should reuse cached tarballs and already-extracted packages.
        await installer.install(pkg);

        // Force a full re-index of VSAC (do not reuse previous index artifacts).
        await fs.remove(indexPath).catch(() => undefined);
        await fs.remove(indexesDir).catch(() => undefined);

        const fpi = new FhirPackageInstaller({ cachePath, logger: noopLogger, registryUrl: 'n/a' });
        const index = await fpi.getPackageIndexFile(pkg);

        // VSAC is expected to be large.
        expect(index.files.length).toBeGreaterThan(1000);
        expect(await fs.exists(indexPath)).toBe(true);
      } finally {
        // Keep the main cachePath by default so future runs don't re-download.
        // Still allow opt-in cleanup if a developer wants a pristine run.
        if (keepStressCache) {
          // keep everything
        } else {
          // best-effort: keep tarballs/extracted content, but remove side caches that can grow
          await fs.remove(indexPath).catch(() => undefined);
          await fs.remove(indexesDir).catch(() => undefined);
        }

      }
    }
  );
});
