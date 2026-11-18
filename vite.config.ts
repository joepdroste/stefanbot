import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  envDir: '..',
  envPrefix: 'DISCORD_CLIENT_ID',
  build: { outDir: '../dist', emptyOutDir: true },
});
