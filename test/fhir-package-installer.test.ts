import path from 'path';
import fs from 'fs-extra';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import {
  getCachePath,
  getPackageDirPath,
  getPackageIndexFile,
  isInstalled,
  setLogger,
  install,
  checkLatestPackageDist,
  getManifest,
  toPackageObject,
  getDependencies
} from '../src/index';

import { ILogger } from '../src/types/Logger';

describe('fhir-package-installer module', () => {
  const fakePackage = { id: 'fake-package', version: '1.0.0' };
  const fumePkg = { id: 'fume.outburn.r4', version: '0.1.1' };
  const fumePkgDir = getPackageDirPath(fumePkg);

  beforeAll(async () => {
    // cleanup before running tests
    await fs.remove(fumePkgDir);
  });

  it('should return correct package directory path', () => {
    const expectedPath = path.join(getCachePath(), 'fake-package#1.0.0');
    expect(getPackageDirPath(fakePackage)).toBe(expectedPath);
  });

  it('should throw ENOENT on getPackageIndexFile for fake package', async () => {
    const noopLogger: ILogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    setLogger(noopLogger);

    await expect(getPackageIndexFile(fakePackage)).rejects.toMatchObject({ errno: -4058 });

    setLogger(); // reset logger
  });

  it('should return false for isInstalled on fake package', () => {
    expect(isInstalled(fakePackage)).toBe(false);
  });

  it('should return false for isInstalled on deleted real package', () => {
    expect(isInstalled(fumePkg)).toBe(false);
  });

  it('should correctly detect latest available version of fume package', async () => {
    const latest = await checkLatestPackageDist(fumePkg.id);
    expect(latest).toBe(fumePkg.version);
  });

  it('should install the fume package successfully', async () => {
    const result = await install(fumePkg);
    expect(result).toBe(true);
  });

  it('should get a valid package index file after install', async () => {
    const index = await getPackageIndexFile(fumePkg);
    expect(index).toMatchObject({
      'index-version': 2,
    });
  });

  it('should get a valid manifest file after install', async () => {
    const manifest = await getManifest(fumePkg);
    expect(manifest.name).toBe(fumePkg.id);
  });

  it('should parse a package string to a valid package object', async () => {
    const obj = await toPackageObject('pkg.name@1.0.0');
    expect(obj).toEqual({ id: 'pkg.name', version: '1.0.0' });
  });

  it('should get valid dependencies from the fume package', async () => {
    const deps = await getDependencies(fumePkg);
    expect(deps).toMatchObject({
      'il.core.fhir.r4': '0.16.1'
    });
  });

  afterAll(async () => {
    // optional cleanup
    await fs.remove(fumePkgDir);
  });
});
