import http from 'http';
import type { AddressInfo } from 'net';
import * as tar from 'tar-stream';
import * as zlib from 'zlib';

export type LocalRegistryPackageVersion = {
  tgz: Buffer;
  tarballStatus?: number;
  tarballData?: Buffer;
  tarballErrorBody?: Buffer;
};

export type LocalRegistryPackage = {
  latest: string;
  versions: Record<string, LocalRegistryPackageVersion>;
};

export interface LocalRegistryServerApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  getBaseUrl(): string;
}

export async function createTgzBuffer(files: Record<string, string | Buffer>): Promise<Buffer> {
  const pack = tar.pack();

  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    pack.entry({ name, size: buf.length }, buf);
  }
  pack.finalize();

  const gzip = zlib.createGzip();
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    pack
      .pipe(gzip)
      .on('data', (c) => chunks.push(Buffer.from(c)))
      .on('end', () => resolve())
      .on('error', reject);
  });

  return Buffer.concat(chunks);
}

export function createLocalRegistryServer(
  packages: Record<string, LocalRegistryPackage>,
  port: number = 0
): LocalRegistryServerApi {
  let server: http.Server | undefined;
  let actualPort = port;

  const api: LocalRegistryServerApi = {
    async start() {
      if (server?.listening) return;

      server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url || '/', `http://localhost:${actualPort || 80}`);
          const parts = url.pathname.split('/').filter(Boolean);
          const pkg = parts[0];

          if (!pkg || !packages[pkg]) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
          }

          // Metadata endpoint: /<pkg>/
          if (parts.length === 1) {
            const p = packages[pkg];
            const base = api.getBaseUrl();
            const versions: Record<
              string,
              {
                name: string;
                version: string;
                dist: { tarball: string };
              }
            > = {};
            for (const ver of Object.keys(p.versions)) {
              versions[ver] = {
                name: pkg,
                version: ver,
                dist: {
                  tarball: `${base}/${pkg}/-/${pkg}-${ver}.tgz`,
                },
              };
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                name: pkg,
                'dist-tags': { latest: p.latest },
                versions,
              })
            );
            return;
          }

          // Tarball endpoint: /<pkg>/-/<pkg>-<ver>.tgz
          if (parts.length === 3 && parts[1] === '-' && parts[2].endsWith('.tgz')) {
            const file = parts[2];
            const m = file.match(new RegExp(`^${pkg}-(.+)\\.tgz$`));
            const ver = m?.[1];
            if (!ver || !packages[pkg].versions[ver]) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Tarball not found' }));
              return;
            }
            const version = packages[pkg].versions[ver];
            const status = version.tarballStatus ?? 200;

            if (status !== 200) {
              const body =
                version.tarballErrorBody ?? Buffer.from(JSON.stringify({ error: 'Tarball failed (forced)' }), 'utf8');
              res.writeHead(status, {
                'Content-Type': 'application/json',
                'Content-Length': String(body.length),
              });
              res.end(body);
              return;
            }

            const tgz = version.tarballData ?? version.tgz;
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(tgz.length),
            });
            res.end(tgz);
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        } catch {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, () => resolve());
      });

      const addr = server.address() as AddressInfo;
      actualPort = addr.port;
    },

    async stop() {
      if (!server?.listening) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    },

    getBaseUrl() {
      return `http://localhost:${actualPort}`;
    },
  };

  return api;
}
