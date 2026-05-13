import { defineConfig } from 'tsup';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as { version?: string };
const version = pkg?.version ?? '0.0.0';

export default defineConfig({
  entry: ['src/index.ts', 'src/mock-artifactory-server.ts'],
  dts: true,
  format: ['cjs', 'esm'],
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  target: 'node18',
  minify: false,
  treeshake: false,
  skipNodeModulesBundle: true,
  noExternal: ['p-limit', 'yocto-queue'],
  splitting: false,
  define: {
    __FPI_VERSION__: JSON.stringify(version)
  },
  outExtension({ format }) {
    if (format === 'esm') return { js: '.mjs' };
    return { js: '.cjs' };
  }
});
