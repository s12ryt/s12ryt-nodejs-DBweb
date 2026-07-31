import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

const port = 3417

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  retries: 0,
  reporter: 'list',
  expect: { timeout: 30_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm build && pnpm --filter @dbweb/api start',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DBWEB_WEB_ROOT: resolve('apps/web/dist'),
      DBWEB_MASTER_KEY: Buffer.alloc(32, 17).toString('base64'),
      DBWEB_ADMIN_USERNAME: 'e2e-admin',
      DBWEB_ADMIN_PASSWORD: 'e2e secure administrator password',
      DBWEB_METADATA_FILE: './test-results/e2e.sqlite',
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
