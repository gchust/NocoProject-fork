import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Markdown imports are text, as in the tsup bundle (`loader: { '.md': 'text' }`).
  plugins: [
    {
      name: 'markdown-as-text',
      transform: (code, id) => (id.endsWith('.md') ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined),
    },
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
