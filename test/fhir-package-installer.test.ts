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

  const silentFpi = new FhirPackageInstaller({ logger: noopLogger });
  const customCachePath = path.join(__dirname, '.test-cache');
  const customCacheFpi = new FhirPackageInstaller({
    cachePath: customCachePath
  });

  beforeAll(async () => {
    // cleanup before running tests
    await fs.remove(customCachePath);
  });

  it('should return correct package directory path', () => {
    const expectedPath = path.join(fpi.getCachePath(), 'fake-package#1.0.0');
    expect(fpi.getPackageDirPath(fakePackage)).toBe(expectedPath);
  });

  it('should return correct package directory path (custom)', () => {
    const expectedPath = path.join(customCachePath, 'fake-package#1.0.0');
    expect(customCacheFpi.getPackageDirPath(fakePackage)).toBe(expectedPath);
  });

  it('should throw ENOENT on getPackageIndexFile for fake package', async () => {
    await expect(silentFpi.getPackageIndexFile(fakePackage)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should return false for isInstalled on fake package', () => {
    expect(fpi.isInstalled(fakePackage)).toBe(false);
  });

  it('should return false for isInstalled on deleted real package', () => {
    expect(customCacheFpi.isInstalled(testPkg)).toBe(false);
  });

  it('should correctly detect latest available version of test package', async () => {
    const latest = await fpi.checkLatestPackageDist(testPkg.id);
    expect(latest).toBe(testPkg.version);
  });

  it('should install the test package successfully', async () => {
    const result = await customCacheFpi.install(testPkg);
    expect(result).toBe(true);
  }, 240000); // 240 seconds timeout for installation

  it('should get a valid package index file after install', async () => {
    const index = await customCacheFpi.getPackageIndexFile(testPkg);
    expect(index).toMatchObject({
      'index-version': 2,
    });
  });

  it('should get a valid manifest file after install', async () => {
    const manifest = await customCacheFpi.getManifest(testPkg);
    expect(manifest.name).toBe(testPkg.id);
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
  });

  it('should get true for isInstalled on all dependencies of test package', async () => {
    expect({
      'hl7.fhir.r4.core': customCacheFpi.isInstalled({ id: 'hl7.fhir.r4.core', version: '4.0.1' }),
      'hl7.fhir.r4.examples': customCacheFpi.isInstalled({ id: 'hl7.fhir.r4.examples', version: '4.0.1' })
    }).toMatchObject({
      'hl7.fhir.r4.core': true,
      'hl7.fhir.r4.examples': true
    });
  });
});
