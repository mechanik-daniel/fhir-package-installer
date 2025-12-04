import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FhirPackageInstaller } from 'fhir-package-installer';
import { MemoryLatestVersionCache, type ILatestVersionCache, type ILogger } from 'fhir-package-installer';

describe('FHIR Package Latest Version Caching', () => {
  let fpi: FhirPackageInstaller;
  let cache: ILatestVersionCache;
  let mockLogger: ILogger;
  
  // Mock logger that captures log calls for assertions
  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    
    cache = new MemoryLatestVersionCache(5); // 5 minutes TTL
    fpi = new FhirPackageInstaller({
      logger: mockLogger,
      latestVersionCache: cache
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('MemoryLatestVersionCache', () => {
    it('should store and retrieve cached latest versions of FHIR packages', () => {
      const cache = new MemoryLatestVersionCache();
      
      // Initially empty
      expect(cache.get('test.package')).toBeNull();
      
      // Store a version
      cache.set('test.package', '1.0.0');
      expect(cache.get('test.package')).toBe('1.0.0');
      
      // Store another package
      cache.set('another.package', '2.0.0');
      expect(cache.get('another.package')).toBe('2.0.0');
      expect(cache.get('test.package')).toBe('1.0.0'); // First one still there
    });

    it('should expire FHIR package latest version entries after TTL', async () => {
      // Use very short TTL for testing (0.1 seconds = 6 seconds in milliseconds / 60)
      const shortCache = new MemoryLatestVersionCache(0.0017); // ~0.1 seconds
      
      shortCache.set('test.package', '1.0.0');
      expect(shortCache.get('test.package')).toBe('1.0.0');
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 150)); // 150ms
      
      expect(shortCache.get('test.package')).toBeNull();
    });

    it('should clear all FHIR package latest version entries', () => {
      const cache = new MemoryLatestVersionCache();
      
      cache.set('package1', '1.0.0');
      cache.set('package2', '2.0.0');
      
      expect(cache.get('package1')).toBe('1.0.0');
      expect(cache.get('package2')).toBe('2.0.0');
      
      cache.clear();
      
      expect(cache.get('package1')).toBeNull();
      expect(cache.get('package2')).toBeNull();
    });

    it('should delete specific FHIR package latest version entries', () => {
      const cache = new MemoryLatestVersionCache();
      
      cache.set('package1', '1.0.0');
      cache.set('package2', '2.0.0');
      
      expect(cache.get('package1')).toBe('1.0.0');
      expect(cache.get('package2')).toBe('2.0.0');
      
      cache.delete('package1');
      
      expect(cache.get('package1')).toBeNull();
      expect(cache.get('package2')).toBe('2.0.0');
    });
  });

  describe('FhirPackageInstaller caching integration', () => {
    it('should use cache on subsequent calls', async () => {
      // Mock the registry call to return a consistent result
      const fpiInternal = fpi as unknown as { fetchJson: (...args: unknown[]) => Promise<unknown> };
      const originalFetchJson = fpiInternal.fetchJson.bind(fpi);
      const mockFetchJson = vi.fn().mockResolvedValue({
        'dist-tags': { latest: '3.0.0' }
      });
      fpiInternal.fetchJson = mockFetchJson;

      const packageName = 'hl7.fhir.uv.sdc';
      
      // First call should hit the registry
      const version1 = await fpi.checkLatestPackageDist(packageName);
      expect(version1).toBe('3.0.0');
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(`Fetching latest version for FHIR package ${packageName} from registry`);
      
      // Second call should use cache
      const version2 = await fpi.checkLatestPackageDist(packageName);
      expect(version2).toBe('3.0.0');
      expect(mockFetchJson).toHaveBeenCalledTimes(1); // Still only 1 call
      // No additional logging expected for cache hits (reduced logging)
      
      // Restore original method
      fpiInternal.fetchJson = originalFetchJson;
    }, 10000);

    it('should bypass cache after TTL expiration', async () => {
      // Use a short-lived cache for this test
      const shortCache = new MemoryLatestVersionCache(0.0017); // ~0.1 seconds
      const fpiWithShortCache = new FhirPackageInstaller({
        logger: mockLogger,
        latestVersionCache: shortCache
      });

      // Mock the registry calls
      const fpiShortInternal = fpiWithShortCache as unknown as { fetchJson: (...args: unknown[]) => Promise<unknown> };
      const originalFetchJson = fpiShortInternal.fetchJson.bind(fpiWithShortCache);
      const mockFetchJson = vi.fn()
        .mockResolvedValueOnce({ 'dist-tags': { latest: '3.0.0' } })  // First call
        .mockResolvedValueOnce({ 'dist-tags': { latest: '3.0.1' } }); // Second call after expiry
      fpiShortInternal.fetchJson = mockFetchJson;

      const packageName = 'hl7.fhir.uv.sdc';
      
      // First call
      const version1 = await fpiWithShortCache.checkLatestPackageDist(packageName);
      expect(version1).toBe('3.0.0');
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      
      // Wait for cache expiry
      await new Promise(resolve => setTimeout(resolve, 150)); // 150ms
      
      // Second call should hit registry again due to expiry
      const version2 = await fpiWithShortCache.checkLatestPackageDist(packageName);
      expect(version2).toBe('3.0.1');
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
      
      // Restore original method
      fpiShortInternal.fetchJson = originalFetchJson;
    }, 10000);

    it('should cache different packages independently', async () => {
      // Mock the registry calls
      const fpiInternal2 = fpi as unknown as { fetchJson: (...args: unknown[]) => Promise<unknown> };
      const originalFetchJson = fpiInternal2.fetchJson.bind(fpi);
      const mockFetchJson = vi.fn()
        .mockImplementation((url: string) => {
          if (url.includes('hl7.fhir.uv.sdc')) {
            return Promise.resolve({ 'dist-tags': { latest: '3.0.0' } });
          } else if (url.includes('hl7.fhir.r4.core')) {
            return Promise.resolve({ 'dist-tags': { latest: '4.0.1' } });
          }
          return Promise.reject(new Error('Unexpected URL'));
        });
      fpiInternal2.fetchJson = mockFetchJson;

      // Fetch versions for different packages
      const version1 = await fpi.checkLatestPackageDist('hl7.fhir.uv.sdc');
      const version2 = await fpi.checkLatestPackageDist('hl7.fhir.r4.core');
      
      expect(version1).toBe('3.0.0');
      expect(version2).toBe('4.0.1');
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
      
      // Both should be cached now
      const version1Cached = await fpi.checkLatestPackageDist('hl7.fhir.uv.sdc');
      const version2Cached = await fpi.checkLatestPackageDist('hl7.fhir.r4.core');
      
      expect(version1Cached).toBe('3.0.0');
      expect(version2Cached).toBe('4.0.1');
      expect(mockFetchJson).toHaveBeenCalledTimes(2); // Still only 2 calls
      
      // Restore original method
      fpiInternal2.fetchJson = originalFetchJson;
    }, 10000);

    it('should work with default cache when none provided', () => {
      const fpiDefault = new FhirPackageInstaller();
      const fpiDefaultInternal = fpiDefault as unknown as { latestVersionCache: ILatestVersionCache };
      // Should not throw and should have a default cache
      expect(fpiDefaultInternal.latestVersionCache).toBeDefined();
      expect(fpiDefaultInternal.latestVersionCache).toBeInstanceOf(MemoryLatestVersionCache);
    });
  });
});