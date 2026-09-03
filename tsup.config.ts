import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.tsx' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  splitting: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  // Keep deps external: this is a CLI installed with its node_modules.
  external: ['react', 'ink', '@inkjs/ui', 'chokidar', 'zod', 'date-fns', 'commander'],
  onSuccess: 'chmod +x dist/cli.js',
});
