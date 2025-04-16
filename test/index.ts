/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path';
import { getCachePath, getPackageDirPath, getPackageIndexFile, isInstalled, setLogger, install, checkLatestPackageDist, getManifest, toPackageObject, getDependencies } from '../src/index';
import { ILogger } from '../src/types/Logger.js';
import fs from 'fs-extra';

console.log('===================================================');
console.log('================== test script ====================');
console.log('===================================================');
console.log('Running test script...');

const runTests = async () => {
  // Create a fake package object to test the getPackageDirPath function
  const fakePackageObject = {
    id: 'fake-package',
    version: '1.0.0'
  };

  // Get the package directory path using the fake package object
  const fakePackageDirPath = getPackageDirPath(fakePackageObject);

  // Test the package directory path is correct
  if (fakePackageDirPath !== path.join(getCachePath(), 'fake-package#1.0.0')) {
    console.error('Error: fakePackageDirPath is not correct:', fakePackageDirPath);
    process.exit(1);
  } else {
    console.log('Passed: Fake package dir path is correct:', fakePackageDirPath);
  }

  let noopInfoCalled = false;
  let noopErrorCalled = false;

  // Create a noop custom logger
  const noopLogger: ILogger = {
    error: () => { noopErrorCalled = true; },
    warn: () => { },
    info: () => { noopInfoCalled = true; },
  };

  // Register noop logger
  setLogger(noopLogger);

  // Try to get the index file of the fake package
  try {
    const fakePackageIndex = await getPackageIndexFile(fakePackageObject);
    // should have failed
    console.error('Expected an error when fetching the index of a fake package, but got:', fakePackageIndex);
    process.exit(1);
  } catch (error) {
    if (error instanceof Error && (error as any)?.errno === -4058) {
      console.log('Passed: got the expected error when fetching the index of a fake package');
    } else {
      console.error('Error: expected an ENOENT error when fetching the index of a fake package, but got:', error);
      process.exit(1);
    }
  }

  // Check that the noop logger was called
  if (!noopInfoCalled || !noopErrorCalled) {
    console.error('Error: Custom logger was not called as expected, check the implementation of setLogger()');
    process.exit(1);
  } else {
    console.log('Passed: Custom logger was called as expected');
    setLogger(); // Reset to default logger
    noopErrorCalled = false;
    noopInfoCalled = false;
  }

  const fakePkgInstalled = isInstalled(fakePackageObject); // should return false;
  if (fakePkgInstalled) {
    console.error('Error: fakePkgInstalled should be false, but got:', fakePkgInstalled);
    process.exit(1);
  } else {
    console.log('Passed: isInstalled on fake package returns false as expected');
  }

  // delete fume.outburn.r4 package folders if they exist
  const fumePackageName = 'fume.outburn.r4';
  const fumePkgLatestVersion = '0.1.1';
  const fumePackageObj = {
    id: fumePackageName,
    version: fumePkgLatestVersion
  };
  const fumePackageDirPath = getPackageDirPath(fumePackageObj);
  try {
    await fs.remove(fumePackageDirPath);
  } catch (error) {
    console.error('Error: failed to remove fume package dir:', fumePackageDirPath, error);
    process.exit(1);
  }
  
  // Check if the directory was removed - isInstalled should now return false
  let fumePkgInstalled = isInstalled(fumePackageObj); // should return false;
  if (fumePkgInstalled) {
    console.error('Error: fumePkgInstalled should be false, but got:', fumePkgInstalled);
    process.exit(1);
  }

  // test the checkLatestPackageDist function
  try {
    const fumePkgLatestDist = await checkLatestPackageDist(fumePackageName);
    if (fumePkgLatestDist !== fumePkgLatestVersion) {
      console.error('Error: checkLatestPackageDist for fume package should be', fumePkgLatestVersion, 'but got:', fumePkgLatestDist);
      process.exit(1);
    } else {
      console.log('Passed: checkLatestPackageDist for fume package is correct:', fumePkgLatestVersion);
    }
  } catch (error) {
    console.error('Error: failed to check latest package dist for fume package:', error);
    process.exit(1);
  }
  

  // Now install the package
  fumePkgInstalled = await install(fumePackageObj);
  if (!fumePkgInstalled) {
    console.error('Error: failed to install fume package:', fumePackageName, fumePkgLatestVersion);
    process.exit(1);
  } else {
    console.log('Passed: fume package installed successfully:', fumePackageName, fumePkgLatestVersion);
  }

  // getPackageIndexFile should return a valid index file if the package is installed
  try {
    const fumePackageIndex = await getPackageIndexFile(fumePackageObj);
    if (typeof fumePackageIndex !== 'object' || typeof fumePackageIndex?.['index-version'] !== 'number' || fumePackageIndex?.['index-version'] !== 2) {
      console.error('Error: getPackageIndexFile() for fume package returned an invalid value:', fumePackageIndex);
      process.exit(1);
    } else {
      console.log('Passed: getPackageIndexFile() for fume package returned a valid index file');
    }
  } catch (error) {
    console.error('Error: failed to get package index file for fume package:', error);
    process.exit(1);
  }

  // getManifest should return a valid manifest file
  try {
    const fumePkgManifest = await getManifest(fumePackageObj);
    if (typeof fumePkgManifest !== 'object' || typeof fumePkgManifest?.name !== 'string' || fumePkgManifest?.name !== fumePackageName) {
      console.error('Error: getManifest() for fume package returned an invalid value:', fumePkgManifest);
      process.exit(1);
    }
    console.log('Passed: getManifest() for fume package returned a valid manifest file');
  } catch (error) {
    console.error('Error: failed to get package manifest for fume package:', error);
    process.exit(1);
  }

  // Test the toPackageObject function
  const pkgObjResult = await toPackageObject('pkg.name@1.0.0');
  if (typeof pkgObjResult?.id !== 'string' || typeof pkgObjResult?.version !== 'string' || pkgObjResult.id !== 'pkg.name' || pkgObjResult.version !== '1.0.0') {
    console.error('Error: toPackageObject() returned an invalid value:', pkgObjResult);
    process.exit(1);
  }
  console.log('Passed: toPackageObject() returned a valid package object:', pkgObjResult);

  // getDependencies
  const dependencies = await getDependencies(fumePackageObj);
  if (
    typeof dependencies !== 'object' ||
    Object.keys(dependencies).length === 0 || // should not be empty
    typeof dependencies['il.core.fhir.r4'] !== 'string' || // should have il.core.fhir.r4 as a dependency
    dependencies['il.core.fhir.r4'] !== '0.16.1' // should have version 0.16.1
  ) {
    console.error('Error: getDependencies() returned an invalid value:', dependencies);
    process.exit(1);
  } else {
    console.log('Passed: getDependencies() returned a valid value');
  }

};

runTests();