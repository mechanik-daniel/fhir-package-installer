/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';

import { FhirPackageInstaller } from 'fhir-package-installer';
import type { Logger } from '@outburn/types';

describe('HTTP options (auth header) URL parsing', () => {
  it('warns when registryUrl is misconfigured (not n/a) and URL parsing fails', async () => {
    const warns: string[] = [];
    const logger: Logger = {
      info: () => undefined,
      warn: (msg: any) => {
        warns.push(String(msg));
      },
      error: () => undefined
    };

    // Intentionally invalid registryUrl that is NOT the special disabled value.
    const fpi = new FhirPackageInstaller({
      registryUrl: 'not a url',
      registryToken: 'secret-token',
      logger
    });

    // Call private method via escape hatch to avoid real network calls.
    const options = (fpi as any).getHttpOptions('https://example.com/some/path');

    // Should proceed without throwing and without auth header.
    expect(options).toBeTruthy();
    expect((options as any).headers?.Authorization).toBeUndefined();

    expect(warns.length).toBeGreaterThan(0);
    expect(warns.join('\n')).toMatch(/Failed to parse URL\(s\) for auth header/i);
    expect(warns.join('\n')).toMatch(/registryUrl='not a url'/i);
  });
});
