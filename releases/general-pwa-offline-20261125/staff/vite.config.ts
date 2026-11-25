import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), {
      name:'staff-safe-shell-version',
      generateBundle(_options, bundle) {
        const template=readFileSync(path.resolve(__dirname,'public/sw.js'),'utf8');
        const identity=createHash('sha256').update(template);
        for(const name of Object.keys(bundle).sort()) {const asset=bundle[name];identity.update(name);identity.update(asset.type==='chunk'?asset.code:asset.source);}
        const version=identity.digest('hex').slice(0,24);
        this.emitFile({type:'asset',fileName:'sw.js',source:template.replace("const CACHE_VERSION = 'v3-safe-drafts';",`const CACHE_VERSION = 'v3-${version}';`).replace('/* OFFLINE_BUILD_ASSETS */', Object.keys(bundle).filter(n => /\.(js|css)$/.test(n)).map(n => JSON.stringify('/'+n)).join(',') + ',')});
      },
    }],
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
