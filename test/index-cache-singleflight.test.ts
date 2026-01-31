import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import pLimit from 'p-limit';
import { FhirPackageInstaller } from 'fhir-package-installer';

describe('Shared index cache reuse', () => {
  it('rebuilds .fpi.index.json without re-reading all files when cache exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fpi-index-'));
    const cachePath = path.join(root, 'cache');

    const pkg = { id: 'big.pkg', version: '1.0.0' };

    try {
      await fs.ensureDir(cachePath);

      const pkgDir = path.join(cachePath, `${pkg.id}#${pkg.version}`, 'package');
      await fs.ensureDir(pkgDir);

      await fs.writeJSON(path.join(pkgDir, 'package.json'), {
        name: pkg.id,
        version: pkg.version,
        dependencies: {},
      });

      // Simulate an expensive index scan without adding huge fixtures.
      // Keep this high enough to catch Windows file-handle regressions.
      const count = 2000;
      const limit = pLimit(50);
      await Promise.all(
        Array.from({ length: count }, (_, i) =>
          limit(() =>
            fs.writeJSON(path.join(pkgDir, `ValueSet-${i}.json`), {
              resourceType: 'ValueSet',
              id: `vs-${i}`,
              url: `http://example.org/ValueSet/vs-${i}`,
              name: `VS${i}`,
              version: '1.0.0',
            })
          )
        )
      );

      const fpi = new FhirPackageInstaller({ cachePath });
      const idx1 = await fpi.getPackageIndexFile(pkg);
      expect(idx1.files.length).toBe(count);

      // Verify the persistent index cache record exists on disk.
      const indexesDir = path.join(cachePath, '.fpi.cache', 'indexes');
      const indexCacheEntries = await fs.readdir(indexesDir);
      expect(indexCacheEntries.length).toBeGreaterThan(0);
      const cachedIndexJson = await fs.readJSON(path.join(indexesDir, indexCacheEntries[0]), { encoding: 'utf8' });
      expect(cachedIndexJson).toHaveProperty('index-version');
      expect(cachedIndexJson).not.toHaveProperty('expiresAt');

      const indexPath = path.join(cachePath, `${pkg.id}#${pkg.version}`, 'package', '.fpi.index.json');
      await fs.remove(indexPath);

      const readFileSpy = vi.spyOn(fs, 'readFile');

      const idx2 = await fpi.getPackageIndexFile(pkg);
      expect(idx2.files.length).toBe(count);

      // If the disk index cache is used, generatePackageIndex should not read each JSON file again.
      expect(readFileSpy).toHaveBeenCalledTimes(0);
    } finally {
      vi.restoreAllMocks();
      await fs.remove(root);
    }
  }, 60_000);
});
