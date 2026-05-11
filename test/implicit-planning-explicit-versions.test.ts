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

describe('Implicit planning explicit-version override', () => {
  const cachePath = path.join(path.resolve('.'), 'test', '.test-cache-implicit-explicit-override');

  const collectClosureViaCentralDependencies = async (
    fpi: FhirPackageInstaller,
    root: { id: string; version: string }
  ): Promise<string[]> => {
    const closure = new Set<string>();
    const queue: Array<{ id: string; version: string }> = [root];

    while (queue.length > 0) {
      const current = queue.shift() as { id: string; version: string };
      const currentKey = `${current.id}#${current.version}`;
      if (closure.has(currentKey)) {
        continue;
      }

      closure.add(currentKey);
      const deps = await fpi.getDependencies(current, { rootPackage: root });
      for (const [depId, depVersion] of Object.entries(deps)) {
        const depKey = `${depId}#${depVersion}`;
        if (!closure.has(depKey)) {
          queue.push({ id: depId, version: depVersion });
        }
      }
    }

    return Array.from(closure).sort((a, b) => a.localeCompare(b));
  };

  const registryPackages = {
    'root.pkg': {
      latest: '1.0.0',
      versions: {
        '1.0.0': {
          tgz: Buffer.alloc(0) as any,
          dependencies: {
            'il.core.fhir.r4': '0.20.4',
          },
        },
      },
    },
    'il.core.fhir.r4': {
      latest: '0.20.4',
      versions: {
        '0.20.4': {
          tgz: Buffer.alloc(0) as any,
          dependencies: {
            'hl7.fhir.r4.core': '4.0.1',
            'hl7.fhir.uv.extensions.r4': '5.3.0-ballot-tc1',
          },
        },
      },
    },
    'hl7.fhir.r4.core': {
      latest: '4.0.1',
      versions: {
        '4.0.1': { tgz: Buffer.alloc(0) as any },
      },
    },
    'hl7.terminology.r4': {
      latest: '7.1.0',
      versions: {
        '7.1.0': { tgz: Buffer.alloc(0) as any },
        '6.5.0': { tgz: Buffer.alloc(0) as any },
      },
    },
    'hl7.fhir.uv.extensions.r4': {
      latest: '5.2.0',
      versions: {
        '5.2.0': { tgz: Buffer.alloc(0) as any },
        '5.3.0-ballot-tc1': { tgz: Buffer.alloc(0) as any },
      },
    },
  };

  const registry = createLocalRegistryServer(registryPackages);

  let fpi!: FhirPackageInstaller;

  beforeAll(async () => {
    await registry.start();

    registryPackages['root.pkg'].versions['1.0.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({
        name: 'root.pkg',
        version: '1.0.0',
        dependencies: {
          'il.core.fhir.r4': '0.20.4',
        },
      }),
      'package/StructureDefinition-root.json': JSON.stringify({
        resourceType: 'StructureDefinition',
        id: 'root',
        url: 'http://example.org/root',
        name: 'Root',
        version: '1.0.0',
        kind: 'resource',
        type: 'Patient',
      }),
    });

    registryPackages['il.core.fhir.r4'].versions['0.20.4'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({
        name: 'il.core.fhir.r4',
        version: '0.20.4',
        dependencies: {
          'hl7.fhir.r4.core': '4.0.1',
          'hl7.fhir.uv.extensions.r4': '5.3.0-ballot-tc1',
        },
      }),
      'package/StructureDefinition-il-core.json': JSON.stringify({
        resourceType: 'StructureDefinition',
        id: 'il-core',
        url: 'http://example.org/il/core',
        name: 'ILCore',
        version: '0.20.4',
        kind: 'resource',
        type: 'Patient',
      }),
    });

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

    registryPackages['hl7.terminology.r4'].versions['7.1.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.terminology.r4', version: '7.1.0', dependencies: {} }),
      'package/CodeSystem-term-r4-latest.json': JSON.stringify({
        resourceType: 'CodeSystem',
        id: 'term-r4-latest',
        url: 'http://example.org/term/r4/latest',
        name: 'TermR4Latest',
        version: '7.1.0',
        content: 'complete',
      }),
    });

    registryPackages['hl7.terminology.r4'].versions['6.5.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({
        name: 'hl7.terminology.r4',
        version: '6.5.0',
        dependencies: {
          'hl7.fhir.r4.core': '4.0.1',
          'hl7.fhir.uv.extensions.r4': '5.2.0',
        },
      }),
      'package/CodeSystem-term-r4-explicit.json': JSON.stringify({
        resourceType: 'CodeSystem',
        id: 'term-r4-explicit',
        url: 'http://example.org/term/r4/explicit',
        name: 'TermR4Explicit',
        version: '6.5.0',
        content: 'complete',
      }),
    });

    registryPackages['hl7.fhir.uv.extensions.r4'].versions['5.2.0'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: 'hl7.fhir.uv.extensions.r4', version: '5.2.0', dependencies: {} }),
      'package/StructureDefinition-ext-r4-latest.json': JSON.stringify({
        resourceType: 'StructureDefinition',
        id: 'ext-r4-latest',
        url: 'http://example.org/ext/r4/latest',
        name: 'ExtR4Latest',
        version: '5.2.0',
        kind: 'resource',
        type: 'Patient',
      }),
    });

    registryPackages['hl7.fhir.uv.extensions.r4'].versions['5.3.0-ballot-tc1'].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({
        name: 'hl7.fhir.uv.extensions.r4',
        version: '5.3.0-ballot-tc1',
        dependencies: {
          'hl7.fhir.r4.core': '4.0.1',
          'hl7.terminology.r4': '6.5.0',
        },
      }),
      'package/StructureDefinition-ext-r4-explicit.json': JSON.stringify({
        resourceType: 'StructureDefinition',
        id: 'ext-r4-explicit',
        url: 'http://example.org/ext/r4/explicit',
        name: 'ExtR4Explicit',
        version: '5.3.0-ballot-tc1',
        kind: 'resource',
        type: 'Patient',
      }),
    });

    await fs.remove(cachePath);

    fpi = new FhirPackageInstaller({
      cachePath,
      skipExamples: true,
      allowHttp: true,
      registryUrl: registry.getBaseUrl(),
      logger: noopLogger,
    });
  }, 20000);

  afterAll(async () => {
    await registry.stop();
  }, 20000);

  it('prefers transitive explicit terminology and extension versions over implicit latest during install planning and materialization', async () => {
    const closureKeys = await collectClosureViaCentralDependencies(fpi, { id: 'root.pkg', version: '1.0.0' });

    expect(closureKeys).toContain('il.core.fhir.r4#0.20.4');
    expect(closureKeys).toContain('hl7.fhir.r4.core#4.0.1');
    expect(closureKeys).toContain('hl7.terminology.r4#6.5.0');
    expect(closureKeys).toContain('hl7.fhir.uv.extensions.r4#5.3.0-ballot-tc1');
    expect(closureKeys).not.toContain('hl7.terminology.r4#7.1.0');
    expect(closureKeys).not.toContain('hl7.fhir.uv.extensions.r4#5.2.0');

    await fpi.install({ id: 'root.pkg', version: '1.0.0' });
    expect(await fpi.isInstalled({ id: 'root.pkg', version: '1.0.0' })).toBe(true);

    const coreDeps = await fpi.getDependencies(
      { id: 'hl7.fhir.r4.core', version: '4.0.1' },
      { rootPackage: { id: 'root.pkg', version: '1.0.0' } }
    );
    expect(coreDeps['hl7.terminology.r4']).toBe('6.5.0');
    expect(coreDeps['hl7.fhir.uv.extensions.r4']).toBe('5.3.0-ballot-tc1');

    expect(await fpi.isInstalled({ id: 'hl7.terminology.r4', version: '6.5.0' }, { deep: false })).toBe(true);
    expect(await fpi.isInstalled({ id: 'hl7.fhir.uv.extensions.r4', version: '5.3.0-ballot-tc1' }, { deep: false })).toBe(true);
    expect(await fpi.isInstalled({ id: 'hl7.terminology.r4', version: '7.1.0' }, { deep: false })).toBe(false);
    expect(await fpi.isInstalled({ id: 'hl7.fhir.uv.extensions.r4', version: '5.2.0' }, { deep: false })).toBe(false);
  }, 240000);
});
