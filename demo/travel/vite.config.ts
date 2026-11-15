import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  publicDir: false,
  plugins: [
    react(),
    // Airline tails are served from the site root in the app; here they sit beside the page.
    { name: 'relative-tails', transform: (code, id) => (id.endsWith('Tails.tsx') ? code.replaceAll('`/tails/', '`./tails/') : undefined) },
  ],
  resolve: { alias: {} },
  build: { outDir: resolve(root, 'dist/demo/travel'), emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 4000 },
});
