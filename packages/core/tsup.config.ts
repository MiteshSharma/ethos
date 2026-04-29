import { defineConfig } from 'tsup';

// Bundle @ethosagent/storage-fs INTO core's dist so npm consumers don't need
// it as a separate runtime dep — storage-fs stays private (workspace-only).
// Everything else (incl. @ethosagent/types) remains external so consumers
// install it themselves.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: ['@ethosagent/storage-fs'],
});
