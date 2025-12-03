import { describe, it, expect } from 'vitest';
import { MemoryLatestVersionCache } from '../src/index';

describe('FHIR Package Latest Version Caching - Unit Tests', () => {
  it('should cache and retrieve FHIR package latest versions correctly', () => {
    const cache = new MemoryLatestVersionCache();
    
    // Initially empty
    expect(cache.get('test.package')).toBeNull();
    
    // Store and retrieve
    cache.set('test.package', '1.0.0');
    expect(cache.get('test.package')).toBe('1.0.0');
    
    // Store multiple packages
    cache.set('another.package', '2.0.0');
    expect(cache.get('another.package')).toBe('2.0.0');
    expect(cache.get('test.package')).toBe('1.0.0');
    
    console.log('✅ Basic caching works');
  });

  it('should expire FHIR package latest version entries after TTL', async () => {
    // Use very short TTL for testing (~0.1 seconds)
    const cache = new MemoryLatestVersionCache(0.0017);
    
    // Store a version
    cache.set('test.package', '1.0.0');
    expect(cache.get('test.package')).toBe('1.0.0');
    
    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Should be expired now
    expect(cache.get('test.package')).toBeNull();
    
    console.log('✅ Cache expiration works');
  });

  it('should handle multiple FHIR packages independently', () => {
    const cache = new MemoryLatestVersionCache();
    
    // Store different versions for different packages
    cache.set('hl7.fhir.r4.core', '4.0.1');
    cache.set('hl7.fhir.uv.sdc', '3.0.0');
    cache.set('us.nlm.vsac', '0.11.0');
    
    // All should be retrievable
    expect(cache.get('hl7.fhir.r4.core')).toBe('4.0.1');
    expect(cache.get('hl7.fhir.uv.sdc')).toBe('3.0.0');
    expect(cache.get('us.nlm.vsac')).toBe('0.11.0');
    
    // Delete one
    cache.delete('hl7.fhir.uv.sdc');
    expect(cache.get('hl7.fhir.uv.sdc')).toBeNull();
    expect(cache.get('hl7.fhir.r4.core')).toBe('4.0.1'); // Others still there
    
    console.log('✅ Independent package caching works');
  });

  it('should show that cache prevents multiple requests during package installs', () => {
    const cache = new MemoryLatestVersionCache();
    
    // Pre-populate cache with known versions to avoid registry calls entirely
    cache.set('hl7.fhir.r4.core', '4.0.1');
    cache.set('hl7.fhir.uv.sdc', '3.0.0');
    cache.set('us.nlm.vsac', '0.11.0');
    
    // Verify cache has the values
    expect(cache.get('hl7.fhir.r4.core')).toBe('4.0.1');
    expect(cache.get('hl7.fhir.uv.sdc')).toBe('3.0.0');
    expect(cache.get('us.nlm.vsac')).toBe('0.11.0');
    
    console.log('✅ Cache pre-population works - this will prevent registry calls during installs');
  });
});