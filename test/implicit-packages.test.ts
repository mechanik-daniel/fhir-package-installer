import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { FhirPackageInstaller } from 'fhir-package-installer';
import type { Logger } from '@outburn/types';

import { createLocalRegistryServer, createTgzBuffer } from './local-registry-server';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const TIMEOUT = 240000; // 240 seconds timeout for installation

describe('Implicit Packages Feature', () => {
  const customCachePath = path.join(path.resolve('.'), 'test', '.test-cache-implicit');
  const planningCachePath = path.join(path.resolve('.'), 'test', '.test-cache-implicit-planning');

  const registryPackages = {
    'hl7.fhir.r4.core': {
      latest: '4.0.1',
      versions: { '4.0.1': { tgz: Buffer.alloc(0) as any } },
    },
    'hl7.fhir.r5.core': {
      latest: '5.0.0',
      versions: { '5.0.0': { tgz: Buffer.alloc(0) as any } },
    },
    'hl7.fhir.uv.sdc': {
      latest: '3.0.0',
      versions: {
        '3.0.0': {
          tgz: Buffer.alloc(0) as any,
          dependencies: { 'hl7.fhir.r4.core': '4.0.1' },
        }
      },
    },
    'hl7.terminology.r4': {
      latest: '3.1.0',
      versions: { '3.1.0': { tgz: Buffer.alloc(0) as any } },
    },
    'hl7.fhir.uv.extensions.r4': {
      latest: '2.0.0',
      versions: { '2.0.0': { tgz: Buffer.alloc(0) as any } },
    },
    'hl7.terminology.r5': {
      latest: '4.0.0',
      versions: { '4.0.0': { tgz: Buffer.alloc(0) as any } },
    },
    'hl7.fhir.uv.extensions.r5': {
      latest: '3.0.0',
      versions: { '3.0.0': { tgz: Buffer.alloc(0) as any } },
    },
  };

  const registry = createLocalRegistryServer(registryPackages);
  
  let testFpi!: FhirPackageInstaller;

  beforeAll(async () => {
    await registry.start();

    // Build tiny tarballs. Only package.json + one JSON resource is enough to exercise install/index.
    registryPackages['hl7.fhir.r4.core'].versions['4.0.1'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.fhir.r4.core', version: '4.0.1', dependencies: {} }),
      'package/StructureDefinition-r4-core.json': JSON.stringify({ resourceType: 'StructureDefinition', id: 'r4-core', url: 'http://example.org/r4/core', name: 'R4Core', version: '4.0.1', kind: 'resource', type: 'Patient' }),
    });
    registryPackages['hl7.fhir.r5.core'].versions['5.0.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.fhir.r5.core', version: '5.0.0', dependencies: {} }),
      'package/StructureDefinition-r5-core.json': JSON.stringify({ resourceType: 'StructureDefinition', id: 'r5-core', url: 'http://example.org/r5/core', name: 'R5Core', version: '5.0.0', kind: 'resource', type: 'Patient' }),
    });
    registryPackages['hl7.fhir.uv.sdc'].versions['3.0.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.fhir.uv.sdc', version: '3.0.0', dependencies: { 'hl7.fhir.r4.core': '4.0.1' } }),
      'package/StructureDefinition-sdc.json': JSON.stringify({ resourceType: 'StructureDefinition', id: 'sdc', url: 'http://example.org/sdc', name: 'SDC', version: '3.0.0', kind: 'resource', type: 'Questionnaire' }),
    });
    registryPackages['hl7.terminology.r4'].versions['3.1.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.terminology.r4', version: '3.1.0', dependencies: {} }),
      'package/CodeSystem-term-r4.json': JSON.stringify({ resourceType: 'CodeSystem', id: 'term-r4', url: 'http://example.org/term/r4', name: 'TermR4', version: '3.1.0', content: 'complete' }),
    });
    registryPackages['hl7.fhir.uv.extensions.r4'].versions['2.0.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.fhir.uv.extensions.r4', version: '2.0.0', dependencies: {} }),
      'package/StructureDefinition-ext-r4.json': JSON.stringify({ resourceType: 'StructureDefinition', id: 'ext-r4', url: 'http://example.org/ext/r4', name: 'ExtR4', version: '2.0.0', kind: 'resource', type: 'Patient' }),
    });
    registryPackages['hl7.terminology.r5'].versions['4.0.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.terminology.r5', version: '4.0.0', dependencies: {} }),
      'package/CodeSystem-term-r5.json': JSON.stringify({ resourceType: 'CodeSystem', id: 'term-r5', url: 'http://example.org/term/r5', name: 'TermR5', version: '4.0.0', content: 'complete' }),
    });
    registryPackages['hl7.fhir.uv.extensions.r5'].versions['3.0.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.fhir.uv.extensions.r5', version: '3.0.0', dependencies: {} }),
      'package/StructureDefinition-ext-r5.json': JSON.stringify({ resourceType: 'StructureDefinition', id: 'ext-r5', url: 'http://example.org/ext/r5', name: 'ExtR5', version: '3.0.0', kind: 'resource', type: 'Patient' }),
    });

    // cleanup before running tests
    await fs.remove(customCachePath);

    testFpi = new FhirPackageInstaller({
      cachePath: customCachePath,
      skipExamples: true,
      allowHttp: true,
      registryUrl: registry.getBaseUrl(),
      logger: noopLogger,
    });
  }, 20000);

  afterAll(async () => {
    await registry.stop();
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
      expect(deps['hl7.terminology.r4']).toBe('3.1.0');
      expect(deps['hl7.fhir.uv.extensions.r4']).toBe('2.0.0');
      
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
      expect(deps['hl7.terminology.r5']).toBe('4.0.0');
      expect(deps['hl7.fhir.uv.extensions.r5']).toBe('3.0.0');
      
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

    it('should plan implicit dependencies for a transitive core package before those packages are installed', async () => {
      await fs.remove(planningCachePath);

      const planningFpi = new FhirPackageInstaller({
        cachePath: planningCachePath,
        skipExamples: true,
        allowHttp: true,
        registryUrl: registry.getBaseUrl(),
        logger: noopLogger,
      });

      const closure = await (planningFpi as any).collectPlannedDependencyClosure(regularPackage) as Map<string, { id: string; version: string }>;

      expect(Array.from(closure.keys())).toEqual(expect.arrayContaining([
        'hl7.fhir.r4.core#4.0.1',
        'hl7.terminology.r4#3.1.0',
        'hl7.fhir.uv.extensions.r4#2.0.0',
      ]));

      expect(await planningFpi.isInstalled({ id: 'hl7.fhir.r4.core', version: '4.0.1' })).toBe(false);
      expect(await planningFpi.isInstalled({ id: 'hl7.terminology.r4', version: '3.1.0' })).toBe(false);
      expect(await planningFpi.isInstalled({ id: 'hl7.fhir.uv.extensions.r4', version: '2.0.0' })).toBe(false);
    }, TIMEOUT);
  });

  describe('Implicit Dependency Resolution Fallback', () => {
    // Test that implicit dependency resolution doesn't hang when registry is offline
    it('should handle online resolution failure gracefully', async () => {
      const r4CorePackage = { id: 'hl7.fhir.r4.core', version: '4.0.1' };
      
      // First ensure the package is installed (from previous tests)
      const isInstalled = await testFpi.isInstalled(r4CorePackage);
      if (!isInstalled) {
        // Skip this test if the package isn't installed from previous tests
        console.log('Skipping offline test - package not installed from previous tests');
        return;
      }
      
      // Create an FPI with invalid registry URL to force implicit dependency resolution failure
      const offlineFpi = new FhirPackageInstaller({
        registryUrl: 'https://invalid-registry-url.example.com',
        cachePath: customCachePath,
        skipExamples: true,
        logger: noopLogger
      });
      
      // This should work but implicit dependencies might fail to resolve latest versions
      // The key is that it shouldn't hang indefinitely
      const deps = await offlineFpi.getDependencies(r4CorePackage);
      
      // Should at least get explicit dependencies (which for R4 core is empty)
      expect(deps).toBeDefined();
      expect(typeof deps).toBe('object');
      
      console.log('Dependencies with offline registry:', deps);
      console.log('Test completed without hanging - offline fallback working correctly');
    }, 60000); // 60 second timeout for this specific test
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