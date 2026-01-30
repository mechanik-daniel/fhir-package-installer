import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { FhirPackageInstaller } from '../src/index';
import type { Logger } from '@outburn/types';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('FHIR Package Latest Version Caching - Disk (Unit-ish)', () => {
  const cachePath = path.join(path.resolve('.'), 'test', '.test-cache-latest-version-disk-unit');
  const packageName = 'hl7.fhir.uv.sdc';
  const cacheFilePath = path.join(cachePath, `.fpi.latest.${packageName}`);

  beforeEach(async () => {
    await fs.remove(cachePath);
  });

  afterEach(async () => {
    await fs.remove(cachePath);
    vi.restoreAllMocks();
  });

  it('should create a cache file with version + expiresAt', async () => {
    const fpi = new FhirPackageInstaller({ cachePath, logger: noopLogger });
    const fpiInternal = fpi as unknown as { fetchJson: (...args: unknown[]) => Promise<unknown> };
    const mockFetchJson = vi.fn().mockResolvedValue({ 'dist-tags': { latest: '3.0.0' } });
    fpiInternal.fetchJson = mockFetchJson;

    expect(await fpi.checkLatestPackageDist(packageName)).toBe('3.0.0');
    expect(await fs.exists(cacheFilePath)).toBe(true);
    const disk = await fs.readJSON(cacheFilePath, { encoding: 'utf8' });
    expect(disk).toHaveProperty('version', '3.0.0');
    expect(typeof disk.expiresAt).toBe('number');
  });
});