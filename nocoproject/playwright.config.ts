import { defineConfig } from '@playwright/test';

const previewUrl = process.env.NP_PREVIEW_URL ?? 'http://127.0.0.1:13100/main';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.test.ts',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  use: { trace: 'off' },
  // The throwaway preview of this checkout (built client + SQLite + demo data). An already running one is reused.
  webServer: {
    command: 'node --import tsx scripts/preview-server.ts',
    url: `${previewUrl}/login`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
