import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import { FhirPackageInstaller } from '../src/index';
import type { Logger } from '@outburn/types';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('Implicit latest version disk cache', () => {
  const cachePath = path.join(path.resolve('.'), 'test', '.test-cache-implicit-latest-disk');
  const registryUrl = 'https://packages.fhir.org';

  const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
  const getRegistryMetadataCacheFilePath = (pkg: string): string => {
    const key = `registry-meta|${registryUrl}|${pkg}`;
    return path.join(cachePath, '.fpi.cache', 'metadata', `${sha256Hex(key)}.json`);
  };

  beforeEach(async () => {
    await fs.remove(cachePath);
  });

  afterEach(async () => {
    await fs.remove(cachePath);
    vi.restoreAllMocks();
  });

  it('should write a cache file and allow another instance to reuse it without registry calls', async () => {
    const implicitPackageName = 'hl7.fhir.uv.extensions.r4.testcase.write-reuse';
    const cacheFilePath = getRegistryMetadataCacheFilePath(implicitPackageName);
    const fpi1 = new FhirPackageInstaller({
      cachePath,
      logger: noopLogger,
    });

    const fpi1Internal = fpi1 as unknown as { fetchJson: (...args: unknown[]) => Promise<unknown> };
    const mockFetchJson1 = vi.fn().mockResolvedValue({
      'dist-tags': { latest: '1.2.3' },
    });
    fpi1Internal.fetchJson = mockFetchJson1;

    const v1 = await fpi1.checkLatestPackageDist(implicitPackageName);
    expect(v1).toBe('1.2.3');
    expect(mockFetchJson1).toHaveBeenCalledTimes(1);

    // Disk metadata cache file should exist and contain the value + expiry
    expect(await fs.exists(cacheFilePath)).toBe(true);
    const disk1 = await fs.readJSON(cacheFilePath, { encoding: 'utf8' });
    expect(typeof disk1.expiresAt).toBe('number');
    expect(disk1.expiresAt).toBeGreaterThan(Date.now());
    expect(disk1.data?.['dist-tags']?.latest).toBe('1.2.3');

    // Second instance: if it hits the registry, we fail the test
    const fpi2 = new FhirPackageInstaller({
      cachePath,
      logger: noopLogger,
    });

    const fpi2Internal = fpi2 as unknown as { fetchJson: (...args: unknown[]) => Promise<unknown> };
    const mockFetchJson2 = vi.fn().mockRejectedValue(new Error('Registry should not be called'));
    fpi2Internal.fetchJson = mockFetchJson2;

    const v2 = await fpi2.checkLatestPackageDist(implicitPackageName);
    expect(v2).toBe('1.2.3');
    expect(mockFetchJson2).toHaveBeenCalledTimes(0);
  });

  it('should refresh the cache when the on-disk entry is expired', async () => {
    const implicitPackageName = 'hl7.fhir.uv.extensions.r4.testcase.expired-refresh';
    const cacheFilePath = getRegistryMetadataCacheFilePath(implicitPackageName);
    await fs.ensureDir(path.dirname(cacheFilePath));
    await fs.writeJSON(cacheFilePath, {
      data: { 'dist-tags': { latest: '9.9.9' } },
      expiresAt: Date.now() - 1000, // expired
    });

    const fpi = new FhirPackageInstaller({
      cachePath,
      logger: noopLogger,
    });

    const fpiInternal = fpi as unknown as { fetchJson: (...args: unknown[]) => Promise<unknown> };
    const mockFetchJson = vi.fn().mockResolvedValue({
      'dist-tags': { latest: '2.3.4' },
    });
    fpiInternal.fetchJson = mockFetchJson;

    const v = await fpi.checkLatestPackageDist(implicitPackageName);
    expect(v).toBe('2.3.4');
    expect(mockFetchJson).toHaveBeenCalledTimes(1);

    const disk = await fs.readJSON(cacheFilePath, { encoding: 'utf8' });
    expect(disk.data?.['dist-tags']?.latest).toBe('2.3.4');
    expect(disk.expiresAt).toBeGreaterThan(Date.now());
  });
});
