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

describe('FHIR Package Latest Version Caching - Disk (Unit-ish)', () => {
  const cachePath = path.join(path.resolve('.'), 'test', '.test-cache-latest-version-disk-unit');
  const packageName = 'hl7.fhir.uv.sdc';
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

  it('should cache registry metadata on disk with expiresAt', async () => {
    const fpi = new FhirPackageInstaller({ cachePath, logger: noopLogger });
    const fpiInternal = fpi as unknown as { fetchJson: (...args: unknown[]) => Promise<unknown> };
    const mockFetchJson = vi.fn().mockResolvedValue({ 'dist-tags': { latest: '3.0.0' } });
    fpiInternal.fetchJson = mockFetchJson;

    expect(await fpi.checkLatestPackageDist(packageName)).toBe('3.0.0');

    const metadataCachePath = getRegistryMetadataCacheFilePath(packageName);
    expect(await fs.exists(metadataCachePath)).toBe(true);
    const disk = await fs.readJSON(metadataCachePath, { encoding: 'utf8' });
    expect(typeof disk.expiresAt).toBe('number');
    expect(disk.data).toHaveProperty('dist-tags');
    expect(disk.data['dist-tags']).toHaveProperty('latest', '3.0.0');
  });
});