// Dev page only: `pnpm --filter @machines/render dev`. The package itself is consumed as source.
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'dev',
  server: { port: 5186 },
});
