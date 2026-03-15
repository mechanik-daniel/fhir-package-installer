import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import { FhirPackageInstaller } from 'fhir-package-installer';
import type { Logger } from '@outburn/types';

import { createLocalRegistryServer, createTgzBuffer } from './local-registry-server';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const TIMEOUT = 240000;

describe('Implicit package previous-versions fallback (regression)', () => {
  const customCachePath = path.join(path.resolve('.'), 'test', '.test-cache-implicit-fallback-prev');

  const registryPackages = {
    'hl7.fhir.r4.core': {
      latest: '4.0.1',
      versions: { '4.0.1': { tgz: Buffer.alloc(0) as any } },
    },
    'hl7.fhir.uv.extensions.r4': {
      latest: '2.0.0',
      versions: { '2.0.0': { tgz: Buffer.alloc(0) as any } },
    },
    'hl7.terminology.r4': {
      latest: '7.1.0',
      versions: {
        // Latest is advertised in metadata but tarball fetch fails.
        '7.1.0': { tgz: Buffer.alloc(0) as any, tarballStatus: 404 },
        '7.0.0': { tgz: Buffer.alloc(0) as any },
        '6.9.0': { tgz: Buffer.alloc(0) as any },
      },
    },
  };

  const registry = createLocalRegistryServer(registryPackages);

  let fpi!: FhirPackageInstaller;

  beforeAll(async () => {
    await registry.start();

    // Minimal valid package tarballs.
    registryPackages['hl7.fhir.r4.core'].versions['4.0.1'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.fhir.r4.core', version: '4.0.1', dependencies: {} }),
      'package/StructureDefinition-r4-core.json': JSON.stringify({
        resourceType: 'StructureDefinition',
        id: 'r4-core',
        url: 'http://example.org/r4/core',
        name: 'R4Core',
        version: '4.0.1',
        kind: 'resource',
        type: 'Patient',
      }),
    });

    registryPackages['hl7.fhir.uv.extensions.r4'].versions['2.0.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({
        name: 'hl7.fhir.uv.extensions.r4',
        version: '2.0.0',
        dependencies: {},
      }),
      'package/StructureDefinition-ext-r4.json': JSON.stringify({
        resourceType: 'StructureDefinition',
        id: 'ext-r4',
        url: 'http://example.org/ext/r4',
        name: 'ExtR4',
        version: '2.0.0',
        kind: 'resource',
        type: 'Patient',
      }),
    });

    registryPackages['hl7.terminology.r4'].versions['7.0.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.terminology.r4', version: '7.0.0', dependencies: {} }),
      'package/CodeSystem-term-r4.json': JSON.stringify({
        resourceType: 'CodeSystem',
        id: 'term-r4',
        url: 'http://example.org/term/r4',
        name: 'TermR4',
        version: '7.0.0',
        content: 'complete',
      }),
    });

    registryPackages['hl7.terminology.r4'].versions['6.9.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.terminology.r4', version: '6.9.0', dependencies: {} }),
      'package/CodeSystem-term-r4.json': JSON.stringify({
        resourceType: 'CodeSystem',
        id: 'term-r4',
        url: 'http://example.org/term/r4',
        name: 'TermR4',
        version: '6.9.0',
        content: 'complete',
      }),
    });

    await fs.remove(customCachePath);

    fpi = new FhirPackageInstaller({
      cachePath: customCachePath,
      skipExamples: true,
      allowHttp: true,
      registryUrl: registry.getBaseUrl(),
      logger: noopLogger,
    });
  }, 20000);

  afterAll(async () => {
    await registry.stop();
  }, 20000);

  it(
    'falls back to the most recent previous version when dist-tags.latest tarball fails',
    async () => {
      const r4CorePackage = { id: 'hl7.fhir.r4.core', version: '4.0.1' };

      // Expected behavior:
      // - install succeeds by falling back from 7.1.0 -> 7.0.0
      // - dependency closure reports the effective implicit version (7.0.0)
      await fpi.install(r4CorePackage);

      const deps = await fpi.getDependencies(r4CorePackage);
      expect(deps['hl7.terminology.r4']).toBe('7.0.0');
      expect(deps['hl7.fhir.uv.extensions.r4']).toBe('2.0.0');

      expect(await fpi.isInstalled({ id: 'hl7.terminology.r4', version: '7.0.0' })).toBe(true);
      expect(await fpi.isInstalled({ id: 'hl7.terminology.r4', version: '7.1.0' })).toBe(false);
    },
    TIMEOUT
  );
});
