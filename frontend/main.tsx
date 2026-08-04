import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { registerCoffeeBondServiceWorker } from './lib/pwa';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

window.addEventListener('load', () => {
  void registerCoffeeBondServiceWorker().catch((error) => {
    if (import.meta.env.DEV) console.warn('Coffee Bond service worker registration failed.', error);
  });
});
