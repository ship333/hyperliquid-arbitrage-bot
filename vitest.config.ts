import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'tests/**/*.spec.ts',
    ],
    setupFiles: ['src/tests/setup-env.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      exclude: [
        'src/api/server.ts',
        'src/api/routes/**',
        'scripts/**',
      ],
    },
  },
});
