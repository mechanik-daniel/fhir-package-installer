import os from 'os';
import path from 'path';
import { describe, expect, test, beforeEach, afterEach } from 'vitest';

import { FhirPackageInstaller } from '../src/index';

describe('FhirPackageInstaller default cache path', () => {
  const originalMode = process.env.FHIR_PACKAGE_CACHE_MODE;

  beforeEach(() => {
    process.env.FHIR_PACKAGE_CACHE_MODE = 'user';
  });

  afterEach(() => {
    if (typeof originalMode === 'string') {
      process.env.FHIR_PACKAGE_CACHE_MODE = originalMode;
    } else {
      delete process.env.FHIR_PACKAGE_CACHE_MODE;
    }
  });

  test('Uses FHIR spec default when cachePath is undefined', () => {
    const fpi = new FhirPackageInstaller({ cachePath: undefined });
    expect(fpi.getCachePath()).toBe(path.join(os.homedir(), '.fhir', 'packages'));
  });

  test('Uses FHIR spec default when cachePath is empty string', () => {
    const fpi = new FhirPackageInstaller({ cachePath: '' });
    expect(fpi.getCachePath()).toBe(path.join(os.homedir(), '.fhir', 'packages'));
  });

  test('Uses FHIR spec default when cachePath is whitespace', () => {
    const fpi = new FhirPackageInstaller({ cachePath: '   ' });
    expect(fpi.getCachePath()).toBe(path.join(os.homedir(), '.fhir', 'packages'));
  });

  test("Uses FHIR spec default when cachePath is 'n/a'", () => {
    const fpi = new FhirPackageInstaller({ cachePath: 'n/a' });
    expect(fpi.getCachePath()).toBe(path.join(os.homedir(), '.fhir', 'packages'));
  });

  test("Uses FHIR spec default when cachePath is 'N/A'", () => {
    const fpi = new FhirPackageInstaller({ cachePath: 'N/A' });
    expect(fpi.getCachePath()).toBe(path.join(os.homedir(), '.fhir', 'packages'));
  });
});
