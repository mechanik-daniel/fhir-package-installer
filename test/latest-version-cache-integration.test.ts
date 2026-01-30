import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { FhirPackageInstaller } from 'fhir-package-installer';
import type { Logger } from '@outburn/types';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('FHIR Package Latest Version Caching (disk)', () => {
  const cachePath = path.join(path.resolve('.'), 'test', '.test-cache-latest-version-disk');
  const packageName = 'hl7.fhir.uv.sdc';
  const cacheFilePath = path.join(cachePath, `.fpi.latest.${packageName}`);

  beforeEach(async () => {
    await fs.remove(cachePath);
  });

  afterEach(async () => {
    await fs.remove(cachePath);
    vi.restoreAllMocks();
  });

  it('should write a shared cache file and reuse it on subsequent calls without registry calls', async () => {
    const fpi = new FhirPackageInstaller({ cachePath, logger: noopLogger });

    const fpiInternal = fpi as unknown as { fetchJson: (...args: unknown[]) => Promise<unknown> };
    const mockFetchJson = vi.fn().mockResolvedValue({ 'dist-tags': { latest: '3.0.0' } });
    fpiInternal.fetchJson = mockFetchJson;

    const v1 = await fpi.checkLatestPackageDist(packageName);
    expect(v1).toBe('3.0.0');
    expect(mockFetchJson).toHaveBeenCalledTimes(1);

    expect(await fs.exists(cacheFilePath)).toBe(true);
    const disk1 = await fs.readJSON(cacheFilePath, { encoding: 'utf8' });
    expect(disk1).toHaveProperty('version', '3.0.0');
    expect(typeof disk1.expiresAt).toBe('number');
    expect(disk1.expiresAt).toBeGreaterThan(Date.now());

    const v2 = await fpi.checkLatestPackageDist(packageName);
    expect(v2).toBe('3.0.0');
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('should allow a second installer instance to reuse the cache without registry calls', async () => {
    const fpi1 = new FhirPackageInstaller({ cachePath, logger: noopLogger });
    const fpi1Internal = fpi1 as unknown as { fetchJson: (...args: unknown[]) => Promise<unknown> };
    const mockFetchJson1 = vi.fn().mockResolvedValue({ 'dist-tags': { latest: '3.0.0' } });
    fpi1Internal.fetchJson = mockFetchJson1;
    expect(await fpi1.checkLatestPackageDist(packageName)).toBe('3.0.0');
    expect(mockFetchJson1).toHaveBeenCalledTimes(1);

    const fpi2 = new FhirPackageInstaller({ cachePath, logger: noopLogger });
    const fpi2Internal = fpi2 as unknown as { fetchJson: (...args: unknown[]) => Promise<unknown> };
    const mockFetchJson2 = vi.fn().mockRejectedValue(new Error('Registry should not be called'));
    fpi2Internal.fetchJson = mockFetchJson2;

    expect(await fpi2.checkLatestPackageDist(packageName)).toBe('3.0.0');
    expect(mockFetchJson2).toHaveBeenCalledTimes(0);
  });

  it('should refresh the cache when the on-disk entry is expired', async () => {
    await fs.ensureDir(cachePath);
    await fs.writeJSON(cacheFilePath, { version: '9.9.9', expiresAt: Date.now() - 1000 });

    const fpi = new FhirPackageInstaller({ cachePath, logger: noopLogger });
    const fpiInternal = fpi as unknown as { fetchJson: (...args: unknown[]) => Promise<unknown> };
    const mockFetchJson = vi.fn().mockResolvedValue({ 'dist-tags': { latest: '3.0.1' } });
    fpiInternal.fetchJson = mockFetchJson;

    const v = await fpi.checkLatestPackageDist(packageName);
    expect(v).toBe('3.0.1');
    expect(mockFetchJson).toHaveBeenCalledTimes(1);

    const disk = await fs.readJSON(cacheFilePath, { encoding: 'utf8' });
    expect(disk).toHaveProperty('version', '3.0.1');
    expect(disk.expiresAt).toBeGreaterThan(Date.now());
  });
});