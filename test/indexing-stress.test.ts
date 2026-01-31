import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import pLimit from 'p-limit';
import { FhirPackageInstaller } from 'fhir-package-installer';
import type { Logger } from '@outburn/types';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const skipStress = process.env.FPI_SKIP_SYNTH_STRESS === '1';

(skipStress ? describe.skip : describe)('Indexing Stress (synthetic large package)', () => {
  it(
    'can index a very large package without too-many-open-files errors',
    { timeout: 5 * 60_000 },
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fpi-index-stress-'));
      const cachePath = path.join(root, 'cache');
      const pkg = { id: 'stress.pkg', version: '1.0.0' };
      const pkgDir = path.join(cachePath, `${pkg.id}#${pkg.version}`, 'package');

      const fileCount = Math.max(1, Number(process.env.FPI_STRESS_FILE_COUNT ?? '5000'));
      const writeConcurrency = Math.max(1, Number(process.env.FPI_STRESS_WRITE_CONCURRENCY ?? '50'));

      try {
        await fs.ensureDir(pkgDir);
        await fs.writeJSON(path.join(pkgDir, 'package.json'), {
          name: pkg.id,
          version: pkg.version,
          dependencies: {},
        });

        const limit = pLimit(writeConcurrency);
        await Promise.all(
          Array.from({ length: fileCount }, (_, i) =>
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

        const fpi = new FhirPackageInstaller({ cachePath, logger: noopLogger });
        const index = await fpi.getPackageIndexFile(pkg);

        expect(index.files.length).toBe(fileCount);
        expect(await fs.exists(path.join(pkgDir, '.fpi.index.json'))).toBe(true);
      } finally {
        await fs.remove(root);
      }
    }
  );
});
