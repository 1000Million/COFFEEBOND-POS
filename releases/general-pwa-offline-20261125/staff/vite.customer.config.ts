import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Rollup emits the entry using its source filename. Firebase Hosting serves the
 * customer site from /index.html, so the emitted document is renamed after the
 * bundle is written.
 */
function emitCustomerIndexHtml(outDir: string): Plugin {
  return {
    name: 'coffee-bond-customer-index-html',
    closeBundle() {
      const from = path.resolve(__dirname, outDir, 'index-customer.html');
      const to = path.resolve(__dirname, outDir, 'index.html');
      if (fs.existsSync(from)) fs.renameSync(from, to);
    },
  };
}

/**
 * Build configuration for the dedicated customer ordering origin.
 *
 * It shares every source file with the staff build — the customer pages, cart,
 * public menu, add-ons, OTP, checkout, payment and tracking logic are the same
 * modules — but produces its own HTML entry, its own public assets (customer
 * manifest, customer service worker, customer icons) and its own output directory.
 *
 * The staff build (vite.config.ts -> dist/) is untouched by this file.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_');
  const includeBondDemo = (
    mode === 'customer-preview'
    && env.VITE_FIREBASE_PROJECT_ID === 'coffee-bond-pos-preview'
  );
  return {
    plugins: [react(), tailwindcss(), emitCustomerIndexHtml('dist-customer')],
    // Customer manifest, service worker, icons and offline page.
    publicDir: path.resolve(__dirname, './public-customer'),
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './frontend'),
        '@bond-preview': path.resolve(
          __dirname,
          includeBondDemo
            ? './frontend/lib/bondLoyaltyPreview.ts'
            : './frontend/lib/bondLoyaltyPreviewDisabled.ts',
        ),
      },
    },
    define: {
      // Selects the canonical customer-origin route shape at build time, so no
      // hostname sniffing and no hardcoded preview or production origin is needed.
      'import.meta.env.VITE_CUSTOMER_ORIGIN_BUILD': JSON.stringify('true'),
    },
    build: {
      outDir: 'dist-customer',
      emptyOutDir: true,
      rollupOptions: {
        input: path.resolve(__dirname, './index-customer.html'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3001,
      strictPort: true,
    },
  };
});
