import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
  const workerSource = path.resolve(__dirname, 'public/sw.js');
  let shellVersion: string | undefined;

  // Keep the deployed content-addressed cache identity. The PWA plugin owns the
  // single emitted /sw.js; this hook only computes its cache version.
  const shellIdentity: Plugin = {
    name: 'staff-safe-shell-version',
    generateBundle(_options, bundle) {
      const identity = createHash('sha256').update(readFileSync(workerSource, 'utf8'));
      for (const name of Object.keys(bundle).sort()) {
        const asset = bundle[name];
        identity.update(name);
        identity.update(asset.type === 'chunk' ? asset.code : asset.source);
      }
      shellVersion = `v3-${identity.digest('hex').slice(0, 24)}`;
    },
  };

  const stampWorkerVersion: Plugin = {
    name: 'staff-stamp-safe-worker-version',
    transform(code, id) {
      if (path.resolve(id.split('?')[0]) !== workerSource) return null;
      if (!shellVersion) this.error('The Staff shell version must be computed before building its service worker.');
      const marker = /const CACHE_VERSION\s*=\s*['"]v3-safe-drafts['"];?/;
      if (!marker.test(code)) this.error('The guarded service-worker cache version marker is missing.');
      return {
        code: code.replace(marker, `const CACHE_VERSION = ${JSON.stringify(shellVersion)};`),
        map: null,
      };
    },
  };

  return {
    plugins: [
      react(),
      tailwindcss(),
      shellIdentity,
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'public',
        filename: 'sw.js',
        // frontend/lib/pwa.ts owns registration and the active-till safety quorum.
        injectRegister: null,
        registerType: 'prompt',
        // Keep the existing Coffee Bond /pos standalone identity and icons.
        manifest: false,
        injectManifest: {
          globPatterns: [
            'assets/**/*.{js,css,woff,woff2,png,jpg,jpeg,webp,svg}',
            'index.html',
            'offline.html',
            'manifest*.webmanifest',
            'pwa/*.{png,ico}',
          ],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          rollupFormat: 'iife',
          minify: false,
          sourcemap: false,
          buildPlugins: { rollup: [stampWorkerVersion] },
        },
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './frontend'),
        '@bond-preview': path.resolve(__dirname, './frontend/lib/bondLoyaltyPreviewDisabled.ts'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
