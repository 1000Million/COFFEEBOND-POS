import { useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Share2, X } from 'lucide-react';
import { useConnectivity } from '../contexts/ConnectivityContext';
import { PWA_UPDATE_AVAILABLE_EVENT, activateWaitingServiceWorker } from '../lib/pwa';

/**
 * Install and update prompts for the dedicated customer origin.
 *
 * This is a separate component from the staff PwaStatusUI on purpose: the two apps
 * live on different origins, so they share no dismissal state, no install prompt and
 * no service-worker registration. Storage keys are namespaced to the customer app
 * even though origin isolation already guarantees separation.
 *
 * Customers order as guests, so nothing here depends on a staff profile.
 */
const DISMISS_MS = 14 * 24 * 60 * 60 * 1000;
const INSTALL_DISMISSED_AT_KEY = 'coffeeBondOrderInstallDismissedAt';
const IOS_INSTALL_DISMISSED_AT_KEY = 'coffeeBondOrderIosInstallDismissedAt';
/** Never on first paint — the invitation waits until the customer has actually browsed. */
const ENGAGEMENT_MS = 20 * 1000;

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

function recentlyDismissed(key: string): boolean {
  try {
    const dismissedAt = Number(window.localStorage.getItem(key));
    return Number.isFinite(dismissedAt) && Date.now() - dismissedAt < DISMISS_MS;
  } catch {
    return false;
  }
}

function rememberDismissal(key: string): void {
  try {
    window.localStorage.setItem(key, String(Date.now()));
  } catch {
    // Installation guidance remains optional when storage is unavailable.
  }
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

function isIosOrIpadOs(): boolean {
  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(userAgent)
    || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export default function CustomerPwaStatusUI() {
  const { criticalOperationActive } = useConnectivity();
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [waitingRegistration, setWaitingRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [installing, setInstalling] = useState(false);
  const [engaged, setEngaged] = useState(false);

  useEffect(() => {
    const handleBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const handleInstalled = () => setInstallPrompt(null);
    const handleUpdate = (event: Event) => {
      const registration = (event as CustomEvent<{ registration?: ServiceWorkerRegistration }>).detail?.registration;
      if (registration) setWaitingRegistration(registration);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleInstalled);
    window.addEventListener(PWA_UPDATE_AVAILABLE_EVENT, handleUpdate);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleInstalled);
      window.removeEventListener(PWA_UPDATE_AVAILABLE_EVENT, handleUpdate);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setEngaged(true), ENGAGEMENT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const canInvite = engaged && !criticalOperationActive && !isStandalone();

  const visiblePrompt = useMemo(() => {
    // Never interrupt an in-flight checkout, payment or order submission.
    if (criticalOperationActive) return null;
    if (waitingRegistration) return 'UPDATE';
    if (canInvite && installPrompt && !recentlyDismissed(INSTALL_DISMISSED_AT_KEY)) return 'INSTALL';
    if (canInvite && isIosOrIpadOs() && !recentlyDismissed(IOS_INSTALL_DISMISSED_AT_KEY)) return 'IOS';
    return null;
  }, [canInvite, criticalOperationActive, installPrompt, waitingRegistration]);

  if (!visiblePrompt) return null;

  if (visiblePrompt === 'UPDATE' && waitingRegistration) {
    return (
      <aside className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[95] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-amber-200 bg-white p-3 shadow-xl" role="status" aria-live="polite">
        <RefreshCw size={19} className="shrink-0 text-amber-700" />
        <p className="min-w-0 flex-1 text-sm font-bold text-neutral-800">A new Coffee Bond update is ready</p>
        <button type="button" onClick={() => activateWaitingServiceWorker(waitingRegistration)} className="min-h-11 rounded-xl bg-[#4a3026] px-3 text-sm font-black text-white">
          Refresh
        </button>
        <button type="button" onClick={() => setWaitingRegistration(null)} className="flex h-11 w-11 items-center justify-center rounded-xl text-neutral-600" aria-label="Dismiss update">
          <X size={18} />
        </button>
      </aside>
    );
  }

  if (visiblePrompt === 'INSTALL' && installPrompt) {
    const install = async () => {
      setInstalling(true);
      try {
        await installPrompt.prompt();
        const choice = await installPrompt.userChoice;
        if (choice.outcome === 'dismissed') rememberDismissal(INSTALL_DISMISSED_AT_KEY);
        setInstallPrompt(null);
      } finally {
        setInstalling(false);
      }
    };
    return (
      <aside className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[95] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-[#dfd0c2] bg-white p-3 shadow-xl" aria-label="Install the Coffee Bond app">
        <Download size={19} className="shrink-0 text-[#5c4033]" />
        <p className="min-w-0 flex-1 text-sm font-bold text-neutral-800">Install Coffee Bond</p>
        <button type="button" onClick={() => void install()} disabled={installing} className="min-h-11 rounded-xl bg-[#4a3026] px-3 text-sm font-black text-white disabled:opacity-60">
          {installing ? 'Opening...' : 'Install'}
        </button>
        <button type="button" onClick={() => { rememberDismissal(INSTALL_DISMISSED_AT_KEY); setInstallPrompt(null); }} className="flex h-11 w-11 items-center justify-center rounded-xl text-neutral-600" aria-label="Dismiss install prompt">
          <X size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[95] mx-auto max-w-md rounded-2xl border border-[#dfd0c2] bg-white p-4 shadow-xl" aria-label="Add Coffee Bond to your iPhone or iPad Home Screen">
      <div className="flex items-start gap-3">
        <Share2 size={19} className="mt-0.5 shrink-0 text-[#5c4033]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black text-neutral-900">Add Coffee Bond to your Home Screen</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs font-semibold leading-relaxed text-neutral-600">
            <li>Open this page in Safari.</li>
            <li>Tap Share.</li>
            <li>Select Add to Home Screen.</li>
            <li>Tap Add.</li>
          </ol>
        </div>
        <button type="button" onClick={() => { rememberDismissal(IOS_INSTALL_DISMISSED_AT_KEY); setEngaged(false); }} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-neutral-600" aria-label="Dismiss Home Screen instructions">
          <X size={18} />
        </button>
      </div>
    </aside>
  );
}
