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

const STRICT_LEGACY_PACKAGE_INDEX_KEYS = new Set([
  'filename',
  'resourceType',
  'id',
  'url',
  'version',
  'kind',
  'type',
  'supplements',
  'content',
]);

type LivePackageIndex = {
  'index-version': number;
  files: Array<Record<string, unknown>>;
};

const skipLive = process.env.FPI_SKIP_LIVE_REGISTRY === '1';

(skipLive ? describe.skip : describe)('Live Registry Legacy Index Regression (packages.fhir.org)', () => {
  it(
    'installs il.hdp.fhir.r4@0.5.0 and leaves both package index files in strict-compatible form',
    { timeout: 4 * 60_000 },
    async () => {
      // Keep this pinned to the downstream-reported regression package.
      const pkg = { id: 'il.hdp.fhir.r4', version: '0.5.0' };
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fpi-live-legacy-index-'));
      const cachePath = path.join(root, 'cache');
      const packageDir = path.join(cachePath, `${pkg.id}#${pkg.version}`, 'package');

      try {
        expect(await fs.exists(packageDir)).toBe(false);

        const fpi = new FhirPackageInstaller({
          cachePath,
          registryUrl: 'https://packages.fhir.org',
          requestTimeoutMs: 30_000,
          skipExamples: true,
          logger: noopLogger,
        });

        const installed = await fpi.install(pkg);
        expect(installed).toBe(true);

        const fpiIndexPath = path.join(packageDir, '.fpi.index.json');
        const legacyIndexPath = path.join(packageDir, '.index.json');
        expect(await fs.exists(fpiIndexPath)).toBe(true);
        expect(await fs.exists(legacyIndexPath)).toBe(true);

        const fpiIndex = await fs.readJSON(fpiIndexPath, { encoding: 'utf8' }) as LivePackageIndex;
        const legacyIndex = await fs.readJSON(legacyIndexPath, { encoding: 'utf8' }) as LivePackageIndex;

        expect(fpiIndex['index-version']).toBe(2);
        expect(Array.isArray(fpiIndex.files)).toBe(true);
        expect(fpiIndex.files.length).toBeGreaterThan(0);

        expect(legacyIndex['index-version']).toBe(2);
        expect(Array.isArray(legacyIndex.files)).toBe(true);
        expect(legacyIndex.files.length).toBeGreaterThan(0);

        for (const file of legacyIndex.files) {
          const keys = Object.keys(file);
          expect(keys.length).toBeGreaterThan(0);
          expect(keys.every((key) => STRICT_LEGACY_PACKAGE_INDEX_KEYS.has(key))).toBe(true);
        }
      } finally {
        await fs.remove(root).catch(() => undefined);
      }
    }
  );
});