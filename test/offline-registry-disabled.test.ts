import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';

import { FhirPackageInstaller } from 'fhir-package-installer';
import type { Logger } from '@outburn/types';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {}
};

const writeInstalledPackage = async (cachePath: string, id: string, version: string, deps?: Record<string, string>) => {
  const pkgDir = path.join(cachePath, `${id}#${version}`, 'package');
  await fs.ensureDir(pkgDir);
  await fs.writeJSON(path.join(pkgDir, 'package.json'), {
    name: id,
    version,
    dependencies: deps || {}
  });
};

const writeCorruptInstalledPackage = async (cachePath: string, id: string, version: string) => {
  const pkgDir = path.join(cachePath, `${id}#${version}`, 'package');
  await fs.ensureDir(pkgDir);
  // Intentionally invalid JSON to simulate corruption.
  await fs.writeFile(path.join(pkgDir, 'package.json'), '{ this is not valid json', { encoding: 'utf8' });
};

describe('Registry disabled/offline behaviors', () => {
  const cachePath = path.join(path.resolve('.'), 'test', '.test-cache-registry-disabled');

  beforeEach(async () => {
    await fs.remove(cachePath);
    await fs.ensureDir(cachePath);
  });

  it('fails fast when registryUrl=n/a and a user tries to resolve "latest"', async () => {
    const fpi = new FhirPackageInstaller({ cachePath, registryUrl: 'n/a', logger: noopLogger });
    await expect(fpi.toPackageObject('hl7.fhir.r4.core'))
      .rejects.toThrow(/registry is disabled/i);
    await expect(fpi.toPackageObject({ id: 'hl7.fhir.r4.core' }))
      .rejects.toThrow(/latest/i);
  });

  it('fails startup when registryUrl=n/a and an explicit configured package is missing', async () => {
    const fpi = new FhirPackageInstaller({ cachePath, registryUrl: 'n/a', logger: noopLogger });
    await expect(fpi.install({ id: 'hl7.fhir.uv.sdc', version: '3.0.0' }))
      .rejects.toThrow(/missing or incomplete/i);
  });

  it('implicit packages fall back to latest installed version when registryUrl=n/a', async () => {
    // Minimal core package installed.
    await writeInstalledPackage(cachePath, 'hl7.fhir.r4.core', '4.0.1');

    // Two installed versions for extensions: should pick 2.0.0.
    await writeInstalledPackage(cachePath, 'hl7.fhir.uv.extensions.r4', '1.0.0');
    await writeInstalledPackage(cachePath, 'hl7.fhir.uv.extensions.r4', '2.0.0');

    // Single terminology version.
    await writeInstalledPackage(cachePath, 'hl7.terminology.r4', '3.1.0');

    const fpi = new FhirPackageInstaller({ cachePath, registryUrl: 'n/a', logger: noopLogger, skipExamples: true });

    const deps = await fpi.getDependencies({ id: 'hl7.fhir.r4.core', version: '4.0.1' });
    expect(deps).toHaveProperty('hl7.fhir.uv.extensions.r4', '2.0.0');
    expect(deps).toHaveProperty('hl7.terminology.r4', '3.1.0');
  });

  it('fails when registryUrl=n/a and implicit packages are not present in cache', async () => {
    await writeInstalledPackage(cachePath, 'hl7.fhir.r4.core', '4.0.1');

    const fpi = new FhirPackageInstaller({ cachePath, registryUrl: 'n/a', logger: noopLogger, skipExamples: true });
    await expect(fpi.getDependencies({ id: 'hl7.fhir.r4.core', version: '4.0.1' }))
      .rejects.toThrow(/implicit package/i);
  });

  it('isInstalled validates package.json presence and transitive dependencies', async () => {
    await writeInstalledPackage(cachePath, 'a.pkg', '1.0.0', { 'b.pkg': '1.0.0' });

    const fpi = new FhirPackageInstaller({ cachePath, logger: noopLogger });
    // Shallow: the package itself exists.
    expect(await fpi.isInstalled({ id: 'a.pkg', version: '1.0.0' }, { deep: false })).toBe(true);
    // Deep: dependency is missing.
    expect(await fpi.isInstalled({ id: 'a.pkg', version: '1.0.0' })).toBe(false);

    // Create b.pkg directory but without package.json
    await fs.ensureDir(path.join(cachePath, 'b.pkg#1.0.0', 'package'));
    expect(await fpi.isInstalled({ id: 'a.pkg', version: '1.0.0' }, { deep: false })).toBe(true);
    expect(await fpi.isInstalled({ id: 'a.pkg', version: '1.0.0' })).toBe(false);

    // Add b.pkg manifest, now it should be fully installed.
    await writeInstalledPackage(cachePath, 'b.pkg', '1.0.0');
    expect(await fpi.isInstalled({ id: 'a.pkg', version: '1.0.0' })).toBe(true);
  });

  it('isInstalled (deep) throws for corrupted package manifests', async () => {
    await writeCorruptInstalledPackage(cachePath, 'bad.pkg', '1.0.0');
    const fpi = new FhirPackageInstaller({ cachePath, logger: noopLogger });
    // Shallow check passes (file exists) but deep validation should surface parse failure.
    await expect(fpi.isInstalled({ id: 'bad.pkg', version: '1.0.0' }, { deep: false })).resolves.toBe(true);
    await expect(fpi.isInstalled({ id: 'bad.pkg', version: '1.0.0' }, { deep: true }))
      .rejects.toThrow();
  });

  it('isInstalled (deep) throws for unexpected infra errors (e.g., permissions)', async () => {
    await writeInstalledPackage(cachePath, 'a.pkg', '1.0.0');
    const fpi = new FhirPackageInstaller({ cachePath, logger: noopLogger });

    // Simulate an infrastructure failure during deep validation.
    (fpi as any).collectMissingPackages = async () => {
      const err: any = new Error('Permission denied');
      err.code = 'EACCES';
      throw err;
    };

    await expect(fpi.isInstalled({ id: 'a.pkg', version: '1.0.0' }, { deep: true }))
      .rejects.toMatchObject({ code: 'EACCES' });
  });
});
