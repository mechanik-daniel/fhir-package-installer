import path from 'path';
import temp from 'temp';
import fs from 'fs-extra';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Logger } from '@outburn/types';
import { DualModeTestRunner, type TestContext } from './dual-mode-test-runner.js';
import { createLocalRegistryServer, createTgzBuffer } from './local-registry-server';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const debugLogger: Logger = {
  info: (msg) => console.log('[INFO]', msg),
  warn: (msg) => console.warn('[WARN]', msg),
  error: (msg) => console.error('[ERROR]', msg)
};

temp.track();

const TIMEOUT = 240000; // 240 seconds timeout for installation

describe('FHIR Package Installer - Dual Mode Tests (Direct + Artifactory)', () => {
  const testPkg = { id: 'dual.pkg', version: '1.0.0' };
  const customCachePath = path.join(path.resolve('.'), 'test', '.dual-mode-cache');

  const registryPackages = {
    [testPkg.id]: {
      latest: testPkg.version,
      versions: {
        [testPkg.version]: {
          tgz: Buffer.alloc(0) as any,
        },
      },
    },
  };

  const registry = createLocalRegistryServer(registryPackages);

  beforeAll(async () => {
    await registry.start();
    const tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: testPkg.id, version: testPkg.version, dependencies: {} }),
      'package/ValueSet-dual.json': JSON.stringify({ resourceType: 'ValueSet', id: 'dual', url: 'http://example.org/ValueSet/dual', name: 'DualVS', version: '1.0.0' }),
    });
    registryPackages[testPkg.id].versions[testPkg.version].tgz = tgz;

    // Setup mock Artifactory server, proxying to the local registry
    await DualModeTestRunner.setupMockServer({
      upstreamRegistryUrl: registry.getBaseUrl(),
      upstreamTarballBaseUrl: registry.getBaseUrl(),
    });
    
    // Cleanup and recreate cache directories
    await fs.remove(customCachePath);
    await fs.ensureDir(customCachePath);
  }, 30000);

  afterAll(async () => {
    // Teardown mock server
    await DualModeTestRunner.teardownMockServer();
    await registry.stop();
  }, 10000);

  describe('Authentication Tests', () => {
    it('should handle valid authentication correctly', async () => {
      const results = await DualModeTestRunner.runInBothModes(
        async (context: TestContext) => {
          // This should work for both direct (no auth needed) and Artifactory (valid token)
          const latest = await context.fpi.checkLatestPackageDist(testPkg.id);
          expect(latest).toBe(testPkg.version);
          return { success: true, latest };
        },
        { 
          cachePath: path.join(customCachePath, 'auth-test'),
          registryUrl: registry.getBaseUrl(),
          allowHttp: true,
          logger: noopLogger 
        }
      );

      expect(results.direct.success).toBe(true);
      expect(results.artifactory.success).toBe(true);
      expect(results.direct.latest).toBe(testPkg.version);
      expect(results.artifactory.latest).toBe(testPkg.version);
    }, TIMEOUT);

    it('should fail with invalid token (Artifactory only)', async () => {
      // Test invalid authentication - this should only affect Artifactory mode
      const invalidConfig = {
        cachePath: path.join(customCachePath, 'invalid-auth'),
        registryUrl: `${DualModeTestRunner.getMockServer()?.getUrl()}/artifactory/api/npm/fhir-npm-remote`,
        registryToken: 'invalid-token-xyz',
        allowHttp: true, // Enable HTTP for testing
        logger: noopLogger
      };

      const { FhirPackageInstaller } = await import('fhir-package-installer');
      const invalidFpi = new FhirPackageInstaller(invalidConfig);

      await expect(invalidFpi.checkLatestPackageDist(testPkg.id))
        .rejects.toThrow(/(Forbidden|Unauthorized|authentication failed)/i);
    }, TIMEOUT);
  });

  describe('Package Installation Tests', () => {
    it('should install packages successfully in both modes', async () => {
      const results = await DualModeTestRunner.runInBothModes(
        async (context: TestContext) => {
          const result = await context.fpi.install(testPkg);
          const isInstalled = await context.fpi.isInstalled(testPkg);
          
          expect(result).toBe(true);
          expect(isInstalled).toBe(true);
          
          return { installed: true, mode: context.mode };
        },
        { 
          cachePath: path.join(customCachePath, 'install-test'),
          registryUrl: registry.getBaseUrl(),
          allowHttp: true,
          skipExamples: true,
          logger: noopLogger 
        }
      );

      expect(results.direct.installed).toBe(true);
      expect(results.artifactory.installed).toBe(true);
      expect(results.direct.mode).toBe('direct');
      expect(results.artifactory.mode).toBe('artifactory');
    }, TIMEOUT);

    it('should handle package metadata correctly in both modes', async () => {
      const results = await DualModeTestRunner.runInBothModes(
        async (context: TestContext) => {
          // First install the package
          await context.fpi.install(testPkg);
          
          const manifest = await context.fpi.getManifest(testPkg);
          const dependencies = await context.fpi.getDependencies(testPkg);
          
          expect(manifest.name).toBe(testPkg.id);
          expect(manifest.version).toBe(testPkg.version);
          expect(dependencies).toEqual({});
          
          return { manifest, dependencies };
        },
        { 
          cachePath: path.join(customCachePath, 'metadata-test'),
          registryUrl: registry.getBaseUrl(),
          allowHttp: true,
          skipExamples: true,
          logger: noopLogger 
        }
      );

      // Both modes should return identical metadata
      expect(results.direct.manifest).toEqual(results.artifactory.manifest);
      expect(results.direct.dependencies).toEqual(results.artifactory.dependencies);
    }, TIMEOUT);
  });

  describe('Redirect Handling Tests', () => {
    it('should handle redirects properly (mainly for Artifactory)', async () => {
      const results = await DualModeTestRunner.runInBothModes(
        async (context: TestContext) => {
          // Download package which tests redirect handling
          const tempDir = temp.mkdirSync();
          const downloadPath = await context.fpi.downloadPackage(
            testPkg, 
            { destination: tempDir, extract: false }
          );
          
          expect(fs.existsSync(downloadPath)).toBe(true);
          
          // Cleanup
          await fs.remove(tempDir);
          
          return { downloadSuccessful: true, path: downloadPath };
        },
        { 
          cachePath: path.join(customCachePath, 'redirect-test'),
          registryUrl: registry.getBaseUrl(),
          allowHttp: true,
          logger: debugLogger // Use debug logger to see redirect messages
        }
      );

      expect(results.direct.downloadSuccessful).toBe(true);
      expect(results.artifactory.downloadSuccessful).toBe(true);
    }, TIMEOUT);
  });

  describe('Error Handling Tests', () => {
    it('should handle non-existent packages consistently', async () => {
      const fakePackage = { id: 'non.existent.package', version: '1.0.0' };
      
      const results = await DualModeTestRunner.runInBothModes(
        async (context: TestContext) => {
          let errorMessage = '';
          try {
            await context.fpi.install(fakePackage);
          } catch (error) {
            errorMessage = (error as Error).message;
          }
          
          expect(errorMessage).toContain('not found');
          return { errorHandled: true, errorMessage };
        },
        { 
          cachePath: path.join(customCachePath, 'error-test'),
          registryUrl: registry.getBaseUrl(),
          allowHttp: true,
          logger: noopLogger 
        }
      );

      expect(results.direct.errorHandled).toBe(true);
      expect(results.artifactory.errorHandled).toBe(true);
      // Both should contain similar error messages
      expect(results.direct.errorMessage).toContain('not found');
      expect(results.artifactory.errorMessage).toContain('not found');
    }, TIMEOUT);
  });

  describe('Package Index Tests', () => {
    it('should generate identical package indexes in both modes', async () => {
      const results = await DualModeTestRunner.runInBothModes(
        async (context: TestContext) => {
          // First install the package
          await context.fpi.install(testPkg);
          
          const index = await context.fpi.getPackageIndexFile(testPkg);
          
          expect(index).toMatchObject({
            'index-version': 2,
          });
          expect(Array.isArray(index.files)).toBe(true);
          expect(index.files.length).toBeGreaterThan(0);
          
          return { 
            indexVersion: index['index-version'],
            fileCount: index.files.length,
            firstFile: index.files[0]
          };
        },
        { 
          cachePath: path.join(customCachePath, 'index-test'),
          registryUrl: registry.getBaseUrl(),
          allowHttp: true,
          skipExamples: true,
          logger: noopLogger 
        }
      );

      // Indexes should be identical
      expect(results.direct.indexVersion).toBe(results.artifactory.indexVersion);
      expect(results.direct.fileCount).toBe(results.artifactory.fileCount);
      expect(results.direct.firstFile).toEqual(results.artifactory.firstFile);
    }, TIMEOUT);
  });
});
