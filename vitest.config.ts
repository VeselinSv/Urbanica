import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const pkg = (name: string) => resolve(__dirname, `packages/${name}/src/index.ts`);
const alias = {
  '@gce/shared': pkg('shared'),
  '@gce/world-generation': pkg('world-generation'),
  '@gce/economy-engine': pkg('economy-engine'),
  '@gce/game-simulation': pkg('game-simulation'),
  '@gce/domain': pkg('domain'),
  '@gce/database': pkg('database'),
};

export default defineConfig({
  test: {
    // Интеграционните файлове споделят една тестова база – изпълняват се последователно.
    fileParallelism: false,
    projects: [
      { resolve: { alias }, test: { name: 'unit', include: ['packages/**/src/**/*.test.ts'], environment: 'node' } },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
          setupFiles: ['tests/integration/setup.ts'],
        },
      },
    ],
  },
});
