/**
 * Interface for caching latest versions of FHIR packages
 */
export interface ILatestVersionCache {
  /**
   * Get the cached latest version for a FHIR package
   * @param packageId The FHIR package identifier (e.g., 'hl7.fhir.r4.core')
   * @returns The cached latest version string or null if not found or expired
   */
  get(packageId: string): string | null;

  /**
   * Set the latest version for a FHIR package in the cache
   * @param packageId The FHIR package identifier
   * @param version The latest version string
   */
  set(packageId: string, version: string): void;

  /**
   * Clear all cached latest version entries
   */
  clear(): void;

  /**
   * Remove a specific latest version entry from the cache
   * @param packageId The FHIR package identifier to remove
   */
  delete(packageId: string): void;
}

/**
 * Cache entry with timestamp for TTL management
 */
interface CacheEntry {
  version: string;
  timestamp: number;
}

/**
 * Simple in-memory cache implementation for FHIR package latest versions with TTL support
 */
export class MemoryLatestVersionCache implements ILatestVersionCache {
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMinutes: number = 5) {
    this.ttlMs = ttlMinutes * 60 * 1000; // Convert minutes to milliseconds
  }

  get(packageId: string): string | null {
    const entry = this.cache.get(packageId);
    if (!entry) {
      return null;
    }

    const now = Date.now();
    if (now - entry.timestamp > this.ttlMs) {
      // Entry has expired, remove it
      this.cache.delete(packageId);
      return null;
    }

    return entry.version;
  }

  set(packageId: string, version: string): void {
    this.cache.set(packageId, {
      version,
      timestamp: Date.now()
    });
  }

  clear(): void {
    this.cache.clear();
  }

  delete(packageId: string): void {
    this.cache.delete(packageId);
  }
}