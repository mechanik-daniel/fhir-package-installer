import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { FhirPackageInstaller, MemoryLatestVersionCache } from 'fhir-package-installer';
import type { ILogger } from 'fhir-package-installer';

const noopLogger: ILogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Create a shared FHIR package latest version cache to prevent multiple registry calls during tests
const sharedCache = new MemoryLatestVersionCache();

const TIMEOUT = 240000; // 240 seconds timeout for installation

describe('Implicit Packages Feature', () => {
  const customCachePath = path.join(path.resolve('.'), 'test', '.test-cache-implicit');
  
  const testFpi = new FhirPackageInstaller({
    cachePath: customCachePath,
    skipExamples: true,
    latestVersionCache: sharedCache,
    logger: noopLogger
  });

  beforeAll(async () => {
    // cleanup before running tests
    await fs.remove(customCachePath);
  }, 20000);

  describe('Core FHIR R4 Package', () => {
    const r4CorePackage = { id: 'hl7.fhir.r4.core', version: '4.0.1' };

    it('should install R4 core package successfully and include implicit dependencies', async () => {
      // Install the package
      const result = await testFpi.install(r4CorePackage);
      expect(result).toBe(true);
      expect(await testFpi.isInstalled(r4CorePackage)).toBe(true);
      
      // Check that it includes implicit dependencies
      const deps = await testFpi.getDependencies(r4CorePackage);
      
      // Should include implicit dependencies
      expect(deps).toHaveProperty('hl7.terminology.r4');
      expect(deps).toHaveProperty('hl7.fhir.uv.extensions.r4');
      
      // Implicit dependencies should have valid version numbers
      expect(deps['hl7.terminology.r4']).toMatch(/^\d+\.\d+\.\d+/);
      expect(deps['hl7.fhir.uv.extensions.r4']).toMatch(/^\d+\.\d+\.\d+/);
      
      console.log('R4 dependencies (including implicit):', deps);
    }, TIMEOUT);
  });

  describe('Core FHIR R5 Package', () => {
    const r5CorePackage = { id: 'hl7.fhir.r5.core', version: '5.0.0' };

    it('should install R5 core package successfully and include implicit dependencies', async () => {
      // Install the package
      const result = await testFpi.install(r5CorePackage);
      expect(result).toBe(true);
      expect(await testFpi.isInstalled(r5CorePackage)).toBe(true);
      
      // Check that it includes implicit dependencies
      const deps = await testFpi.getDependencies(r5CorePackage);
      
      // Should include implicit dependencies
      expect(deps).toHaveProperty('hl7.terminology.r5');
      expect(deps).toHaveProperty('hl7.fhir.uv.extensions.r5');
      
      // Implicit dependencies should have valid version numbers
      expect(deps['hl7.terminology.r5']).toMatch(/^\d+\.\d+\.\d+/);
      expect(deps['hl7.fhir.uv.extensions.r5']).toMatch(/^\d+\.\d+\.\d+/);
      
      console.log('R5 dependencies (including implicit):', deps);
    }, TIMEOUT);
  });

  describe('Non-Core Package', () => {
    const regularPackage = { id: 'hl7.fhir.uv.sdc', version: '3.0.0' };

    it('should install regular package successfully and not add implicit dependencies for non-core packages', async () => {
      // Install the package
      const result = await testFpi.install(regularPackage);
      expect(result).toBe(true);
      expect(await testFpi.isInstalled(regularPackage)).toBe(true);
      
      // Check dependencies
      const deps = await testFpi.getDependencies(regularPackage);
      
      // Should include explicit dependencies but no extra implicit ones
      expect(deps).toHaveProperty('hl7.fhir.r4.core');
      
      // Should NOT include implicit dependencies directly (since this is not a core package)
      // The implicit dependencies will be added when the core package dependencies are resolved
      expect(deps).not.toHaveProperty('hl7.terminology.r4');
      expect(deps).not.toHaveProperty('hl7.fhir.uv.extensions.r4');
      
      console.log('Regular package dependencies:', deps);
    }, TIMEOUT);
  });

  describe('Implicit Dependency Resolution Fallback', () => {
    // Test that fallback to cache works when online resolution fails
    it('should handle online resolution failure gracefully', async () => {
      // Create an FPI with invalid registry URL to force failure
      const offlineFpi = new FhirPackageInstaller({
        registryUrl: 'https://invalid-registry-url.example.com',
        cachePath: customCachePath,
        skipExamples: true,
        latestVersionCache: new MemoryLatestVersionCache(), // Don't use shared cache
        logger: noopLogger
      });

      const r4CorePackage = { id: 'hl7.fhir.r4.core', version: '4.0.1' };
      
      // This should still work because it will fall back to cached versions
      const deps = await offlineFpi.getDependencies(r4CorePackage);
      
      // If there are cached versions, they should be used
      // If no cached versions exist, the implicit dependencies will be skipped with warnings
      expect(deps).toBeDefined();
      console.log('Dependencies with offline registry (fallback to cache):', deps);
    });
  });

  describe('Cache Scanning', () => {
    it('should verify implicit packages functionality works', async () => {
      // Test that the implicit dependencies feature works as expected
      const r4CorePackage = { id: 'hl7.fhir.r4.core', version: '4.0.1' };
      const deps = await testFpi.getDependencies(r4CorePackage);
      
      // The key test: implicit dependencies should be included in getDependencies
      const hasImplicitDeps = 'hl7.terminology.r4' in deps && 'hl7.fhir.uv.extensions.r4' in deps;
      expect(hasImplicitDeps).toBe(true);
      
      console.log('Implicit packages test successful - dependencies include:', Object.keys(deps));
      
      // If cache path was created during previous tests, that's fine too
      if (fs.existsSync(customCachePath)) {
        console.log('Cache path exists:', customCachePath);
      }
    });
  });
});