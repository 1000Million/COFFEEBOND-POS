/**
 * React entry point for the dedicated customer ordering origin.
 *
 * Mirrors frontend/main.tsx but boots CustomerApp, which mounts only the customer
 * ordering routes. The service worker registered here resolves to the customer
 * origin's own /sw.js with its own cache namespace; the staff worker on
 * pos.coffeebond.in is a different file on a different origin and is untouched.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import CustomerApp from './CustomerApp';
import './index.css';
// Customer-only design tokens. Imported here and nowhere else, so these styles
// cannot reach the staff POS bundle.
import './customer.css';
import { registerCoffeeBondServiceWorker } from './lib/pwa';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <CustomerApp />
  </React.StrictMode>
);

window.addEventListener('load', () => {
  void registerCoffeeBondServiceWorker().catch((error) => {
    if (import.meta.env.DEV) console.warn('Coffee Bond customer service worker registration failed.', error);
  });
});
