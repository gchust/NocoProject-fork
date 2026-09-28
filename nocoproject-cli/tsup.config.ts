import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    'echo-agent': 'src/daemon/adapters/echo-agent.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  // Bundle everything so dist/cli.js is a single self-contained file.
  noExternal: [/.*/],
  // The `nocoproject-user` skill (skills/) is bundled as text for `nocoproject user skill install`.
  loader: { '.md': 'text' },
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __ncpCreateRequire } from 'node:module';",
      'const require = __ncpCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
