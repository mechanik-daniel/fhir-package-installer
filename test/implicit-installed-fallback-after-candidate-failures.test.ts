import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import type { Logger } from '@outburn/types';

import { FhirPackageInstaller } from '../src/index';
import { createLocalRegistryServer, createTgzBuffer } from './local-registry-server';

const warningMessages: string[] = [];

const logger: Logger = {
  info: () => {},
  warn: (message) => {
    warningMessages.push(String(message));
  },
  error: () => {},
};

const writeInstalledPackage = async (
  cachePath: string,
  id: string,
  version: string,
  deps?: Record<string, string>,
  options?: { strictMaterialization?: boolean }
) => {
  const pkgDir = path.join(cachePath, `${id}#${version}`, 'package');
  await fs.ensureDir(pkgDir);
  await fs.writeJSON(path.join(pkgDir, 'package.json'), {
    name: id,
    version,
    dependencies: deps || {},
  });

  if (options?.strictMaterialization) {
    const sentinelFile = 'StructureDefinition-installed.json';
    await fs.writeJSON(path.join(pkgDir, sentinelFile), {
      resourceType: 'StructureDefinition',
      id: `${id}-${version}`,
      url: `http://example.org/${id}/${version}`,
      name: `${id}-${version}`,
      version,
      kind: 'resource',
      type: 'Patient',
    });
    await fs.writeJSON(path.join(pkgDir, '.fpi.index.json'), {
      files: [{ filename: sentinelFile }],
    });
  }
};

const TIMEOUT = 240000;

describe('Implicit package installed-version fallback after candidate failures', () => {
  const cacheRoot = path.join(path.resolve('.'), 'test', '.test-cache-implicit-installed-fallback');
  let cachePath = '';

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
        '7.1.0': { tgz: Buffer.alloc(0) as any, tarballStatus: 404 },
        '7.0.0': { tgz: Buffer.alloc(0) as any, tarballStatus: 404 },
        '6.9.0': { tgz: Buffer.alloc(0) as any, tarballStatus: 404 },
      },
    },
  };

  const registry = createLocalRegistryServer(registryPackages);

  beforeAll(async () => {
    await registry.start();

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
      'package/package.json': JSON.stringify({ name: 'hl7.fhir.uv.extensions.r4', version: '2.0.0', dependencies: {} }),
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
  }, 20000);

  afterAll(async () => {
    await registry.stop();
    await fs.remove(cacheRoot);
  }, 20000);

  beforeEach(async () => {
    warningMessages.length = 0;
    cachePath = path.join(cacheRoot, Math.random().toString(36).slice(2));
    await fs.remove(cachePath);
    await fs.ensureDir(cachePath);

    await writeInstalledPackage(cachePath, 'hl7.fhir.r4.core', '4.0.1');
    await writeInstalledPackage(cachePath, 'hl7.fhir.uv.extensions.r4', '2.0.0', undefined, { strictMaterialization: true });
    await writeInstalledPackage(cachePath, 'hl7.terminology.r4', '6.5.0', undefined, { strictMaterialization: true });
  });

  it('continues with the latest installed implicit package when materializing registry candidates all fail', async () => {
    const fpi = new FhirPackageInstaller({
      cachePath,
      skipExamples: true,
      allowHttp: true,
      registryUrl: registry.getBaseUrl(),
      logger,
    });

    const resolvedVersion = await (fpi as any).resolveImplicitPackageVersionWithFallbacks('hl7.terminology.r4');
    const warningText = warningMessages.join('\n');

    expect(resolvedVersion).toBe('6.5.0');
    expect(warningText).toContain('Failed to materialize implicit package hl7.terminology.r4');
    expect(warningText).toContain('Falling back to latest installed version');
  }, TIMEOUT);

  it('continues with the latest installed implicit package during dependency planning when registry candidates all fail', async () => {
    const fpi = new FhirPackageInstaller({
      cachePath,
      skipExamples: true,
      allowHttp: true,
      registryUrl: registry.getBaseUrl(),
      logger,
    });

    const deps = await fpi.getDependencies(
      { id: 'hl7.fhir.r4.core', version: '4.0.1' },
      { rootPackage: { id: 'hl7.fhir.r4.core', version: '4.0.1' } }
    );
    const warningText = warningMessages.join('\n');

    expect(deps['hl7.terminology.r4']).toBe('6.5.0');
    expect(warningText).toContain('Failed to resolve planning candidates for implicit package hl7.terminology.r4');
    expect(warningText).toContain('Falling back to latest installed version');
  }, TIMEOUT);
});