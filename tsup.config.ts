import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'types/index': 'src/types/index.ts'
  },
  dts: true,
  format: ['cjs', 'esm'],
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  target: 'node18',
  minify: false,
  treeshake: true,
  skipNodeModulesBundle: true,
  noExternal: ['p-limit', 'yocto-queue'],
  splitting: false,
  outExtension({ format }) {
    if (format === 'esm') return { js: '.mjs' };
    return { js: '.cjs' };
  }
});
