import path from 'path';
import fs from 'fs-extra';
import { describe, it, expect, beforeAll } from 'vitest';

import fpi, { FhirPackageInstaller } from 'fhir-package-installer';
import type { ILogger } from 'fhir-package-installer';

const noopLogger: ILogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('fhir-package-installer module', () => {
  const fakePackage = { id: 'fake-package', version: '1.0.0' };
  const testPkg = { id: 'hl7.fhir.uv.sdc', version: '3.0.0' };
  const tstPkgHash = `${testPkg.id}#${testPkg.version}`;
  const tstPkgAt = `${testPkg.id}@${testPkg.version}`;
  
  const heavyPackage = { id: 'us.nlm.vsac', version: '0.11.0' };

  const silentFpi = new FhirPackageInstaller({ logger: noopLogger });
  const customCachePath = path.join(path.resolve('.'), 'test', '.test-cache');
  const customCacheFpi = new FhirPackageInstaller({
    cachePath: customCachePath
  });

  beforeAll(async () => {
    // cleanup before running tests
    await fs.remove(customCachePath);
  });

  it('should return correct fake package directory path (default cache)', async () => {
    const expectedPath = path.join(fpi.getCachePath(), 'fake-package#1.0.0');
    expect(await fpi.getPackageDirPath(fakePackage)).toBe(expectedPath);
  });

  it('should return correct package directory path (custom cache)', async () => {
    const expectedPath = path.join(customCachePath, 'fake-package#1.0.0');
    expect(await customCacheFpi.getPackageDirPath(fakePackage)).toBe(expectedPath);
  });

  it('should throw ENOENT on getPackageIndexFile for fake package', async () => {
    await expect(silentFpi.getPackageIndexFile(fakePackage))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
  

  it('should return false for isInstalled on fake package', async () => {
    expect(await fpi.isInstalled(fakePackage)).toBe(false);
  });

  it('should return false for isInstalled on deleted real package', async () => {
    expect(await customCacheFpi.isInstalled(testPkg)).toBe(false);
    expect(await customCacheFpi.isInstalled(tstPkgHash)).toBe(false);
    expect(await customCacheFpi.isInstalled(tstPkgAt)).toBe(false);
  });

  it('should correctly detect latest available version of test package', async () => {
    const latest = await fpi.checkLatestPackageDist(testPkg.id);
    expect(latest).toBe(testPkg.version);
  });

  it('should install the test package successfully', async () => {
    const result = await customCacheFpi.install(testPkg);
    expect(result).toBe(true);
    expect(await customCacheFpi.isInstalled(testPkg)).toBe(true);
  }, 240000); // 240 seconds timeout for installation

  it('should install the heavy package successfully', async () => {
    const result = await customCacheFpi.install(heavyPackage);
    expect(result).toBe(true);
    expect(await customCacheFpi.isInstalled(heavyPackage)).toBe(true);
  }, 240000); // 240 seconds timeout for installation

  it('should get a valid package index file after install', async () => {
    const index = await customCacheFpi.getPackageIndexFile(tstPkgAt);
    expect(index).toMatchObject({
      'index-version': 2,
    });
    const index2 = await customCacheFpi.getPackageIndexFile(heavyPackage);
    expect(index2).toMatchObject({
      'index-version': 2,
    });
  });

  it('should get a valid manifest file after install', async () => {
    const manifest = await customCacheFpi.getManifest(tstPkgHash);
    expect(manifest.name).toBe(testPkg.id);
    const manifest2 = await customCacheFpi.getManifest(heavyPackage);
    expect(manifest2.name).toBe(heavyPackage.id);
  });

  it('should parse a package string to a valid package object', async () => {
    const obj = await fpi.toPackageObject('pkg.name@1.0.0');
    expect(obj).toEqual({ id: 'pkg.name', version: '1.0.0' });
  });

  it('should get valid dependencies from the test package', async () => {
    const deps = await customCacheFpi.getDependencies(testPkg);
    expect(deps).toMatchObject({
      'hl7.fhir.r4.core': '4.0.1',
      'hl7.fhir.r4.examples': '4.0.1'
    });
    const deps2 = await customCacheFpi.getDependencies(heavyPackage);
    expect(deps2).toMatchObject({
      'hl7.fhir.r4.core' : '4.0.1'
    });
  });

  it('should get true for isInstalled on all dependencies of test package', async () => {
    expect({
      'hl7.fhir.r4.core': await customCacheFpi.isInstalled({ id: 'hl7.fhir.r4.core', version: '4.0.1' }),
      'hl7.fhir.r4.examples': await customCacheFpi.isInstalled({ id: 'hl7.fhir.r4.examples', version: '4.0.1' })
    }).toMatchObject({
      'hl7.fhir.r4.core': true,
      'hl7.fhir.r4.examples': true
    });
  });
});
