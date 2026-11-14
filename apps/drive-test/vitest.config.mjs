import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    miniflare: {
      compatibilityDate: '2026-11-09',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations('./test-migrations'),
        DRIVE_MIGRATIONS: await readD1Migrations('../drive/migrations'),
      },
    },
  })],
}));
