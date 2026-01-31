import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMockArtifactoryServer } from 'fhir-package-installer/mock-artifactory-server';
import https from 'https';
import http from 'http';
import { createLocalRegistryServer, createTgzBuffer } from './local-registry-server';

describe('Mock Artifactory Server', () => {
  let mockServer: ReturnType<typeof createMockArtifactoryServer>;
  const pkg = { id: 'hl7.fhir.uv.sdc', version: '3.0.0' };
  const port = 3334;

  const registryPackages = {
    [pkg.id]: {
      latest: pkg.version,
      versions: {
        [pkg.version]: {
          tgz: Buffer.alloc(0) as any,
        },
      },
    },
  };

  const registry = createLocalRegistryServer(registryPackages);

  beforeAll(async () => {
    await registry.start();
    registryPackages[pkg.id].versions[pkg.version].tgz = await createTgzBuffer({
      'package/package.json': JSON.stringify({ name: pkg.id, version: pkg.version, dependencies: {} }),
      'package/ValueSet-sdc.json': JSON.stringify({ resourceType: 'ValueSet', id: 'sdc', url: 'http://example.org/ValueSet/sdc', name: 'SDC', version: pkg.version }),
    });

    mockServer = createMockArtifactoryServer(port, {
      upstreamRegistryUrl: registry.getBaseUrl(),
      upstreamTarballBaseUrl: registry.getBaseUrl(),
    });
    await mockServer.start();
  });

  afterAll(async () => {
    await mockServer.stop();
    await registry.stop();
  });

  it('should reject requests without authorization', async () => {
    const response = await makeRequest(`http://localhost:${port}/artifactory/api/npm/fhir-npm-remote/${pkg.id}/`);
    expect(response.statusCode).toBe(401);
  });

  it('should reject requests with invalid token', async () => {
    const response = await makeRequest(
      `http://localhost:${port}/artifactory/api/npm/fhir-npm-remote/${pkg.id}/`,
      'Bearer invalid-token'
    );
    expect(response.statusCode).toBe(403);
  });

  it('should accept requests with valid token and proxy to upstream registry', async () => {
    const response = await makeRequest(
      `http://localhost:${port}/artifactory/api/npm/fhir-npm-remote/${pkg.id}/`,
      'Bearer test-token'
    );
    expect(response.statusCode).toBe(200);
    
    const data = JSON.parse(response.data);
    expect(data.name).toBe(pkg.id);
    expect(data.versions).toBeDefined();
    
    // Check that tarball URLs have been modified to point to our mock server
    const version = Object.keys(data.versions)[0];
    const tarballUrl = data.versions[version].dist.tarball;
    expect(tarballUrl).toContain(`localhost:${port}`);
  }, 30000);

  it('should handle tarball download requests with redirects', async () => {
    const response = await makeRequest(
      `http://localhost:${port}/artifactory/api/npm/fhir-npm-remote/${pkg.id}/-/${pkg.id}-${pkg.version}.tgz`,
      'Bearer test-token'
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain(registry.getBaseUrl());
  });
});

function makeRequest(url: string, authorization?: string): Promise<{
  statusCode: number;
  data: string;
  headers: Record<string, string>;
}> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: authorization ? { 'Authorization': authorization } : {}
    };

    const req = (urlObj.protocol === 'https:' ? https : http).request(options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          data,
          headers: res.headers as Record<string, string>
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}
