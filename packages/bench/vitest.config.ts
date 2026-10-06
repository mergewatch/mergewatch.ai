import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // cli.ts is the argv/stdout shell around runner.ts; its behaviour is
      // covered through runBench() rather than by spawning the process.
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/cli.ts'],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
      },
    },
  },
});
