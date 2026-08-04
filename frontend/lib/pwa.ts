export const PWA_UPDATE_AVAILABLE_EVENT = 'coffee-bond:pwa-update-available';

let refreshRequested = false;

function announceWaitingWorker(registration: ServiceWorkerRegistration): void {
  if (!registration.waiting) return;
  window.dispatchEvent(new CustomEvent(PWA_UPDATE_AVAILABLE_EVENT, {
    detail: { registration },
  }));
}
export function activateWaitingServiceWorker(registration: ServiceWorkerRegistration): void {
  if (!registration.waiting) return;
  refreshRequested = true;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
}

export async function registerCoffeeBondServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  if (!(import.meta.env.PROD || import.meta.env.VITE_ENABLE_PWA_DEV === 'true')) return null;

  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  announceWaitingWorker(registration);

  registration.addEventListener('updatefound', () => {
    const installingWorker = registration.installing;
    if (!installingWorker) return;
    installingWorker.addEventListener('statechange', () => {
      if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
        announceWaitingWorker(registration);
      }
    });
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshRequested) return;
    refreshRequested = false;
    window.location.reload();
  });

  const checkForUpdate = () => {
    if (document.visibilityState === 'visible') void registration.update();
  };
  document.addEventListener('visibilitychange', checkForUpdate);
  window.setInterval(checkForUpdate, 60 * 60 * 1000);

  return registration;
}
