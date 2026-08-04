import { useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Share2, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useConnectivity } from '../contexts/ConnectivityContext';
import { PWA_UPDATE_AVAILABLE_EVENT, activateWaitingServiceWorker } from '../lib/pwa';

const DISMISS_MS = 14 * 24 * 60 * 60 * 1000;
const INSTALL_DISMISSED_AT_KEY = 'coffeeBondPosInstallDismissedAt';
const IOS_INSTALL_DISMISSED_AT_KEY = 'coffeeBondPosIosInstallDismissedAt';
// Customer dismissals are tracked separately so declining one app never suppresses
// the other. The staff keys above are untouched.
const CUSTOMER_INSTALL_DISMISSED_AT_KEY = 'coffeeBondCustomerInstallDismissedAt';
const CUSTOMER_IOS_INSTALL_DISMISSED_AT_KEY = 'coffeeBondCustomerIosInstallDismissedAt';
/** Customers only see an install invitation after they have actually browsed. */
const CUSTOMER_ENGAGEMENT_MS = 20 * 1000;

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

export default function PwaStatusUI() {
  const location = useLocation();
  const { authStatus, staffProfile } = useAuth();
  const { criticalOperationActive } = useConnectivity();
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosInstructions, setShowIosInstructions] = useState(false);
  const [waitingRegistration, setWaitingRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [installing, setInstalling] = useState(false);
  const [customerEngaged, setCustomerEngaged] = useState(false);

  const isCustomerRoute = location.pathname === '/order' || location.pathname.startsWith('/order/');
  const canShowStaffInstall = authStatus === 'ready'
    && Boolean(staffProfile && staffProfile.role !== 'FRANCHISE_VIEWER')
    && !isCustomerRoute
    && !criticalOperationActive
    && !isStandalone();
  // Customers order as guests, so no staff profile is required. The prompt is held
  // back until the customer has spent real time on the ordering app.
  const canShowCustomerInstall = isCustomerRoute
    && customerEngaged
    && !criticalOperationActive
    && !isStandalone();

  useEffect(() => {
    const handleBeforeInstall = (event: Event) => {
      event.preventDefault();
      // The browser fires this once per document. Keep it and decide per audience at
      // render time, so a staff dismissal never hides the customer invitation.
      setInstallPrompt(event as InstallPromptEvent);
    };
    const handleInstalled = () => {
      setInstallPrompt(null);
      setShowIosInstructions(false);
    };
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
    if (!canShowStaffInstall || !isIosOrIpadOs() || recentlyDismissed(IOS_INSTALL_DISMISSED_AT_KEY)) return;
    setShowIosInstructions(true);
  }, [canShowStaffInstall]);

  // Engagement gate: never on first paint, and the timer restarts if the customer
  // leaves the ordering routes.
  useEffect(() => {
    if (!isCustomerRoute) {
      setCustomerEngaged(false);
      return;
    }
    const timer = window.setTimeout(() => setCustomerEngaged(true), CUSTOMER_ENGAGEMENT_MS);
    return () => window.clearTimeout(timer);
  }, [isCustomerRoute]);

  const visiblePrompt = useMemo(() => {
    if (criticalOperationActive) return null;
    if (waitingRegistration && !isCustomerRoute) return 'UPDATE';
    if (waitingRegistration && isCustomerRoute) return 'CUSTOMER_UPDATE';
    if (canShowStaffInstall && installPrompt && !recentlyDismissed(INSTALL_DISMISSED_AT_KEY)) return 'INSTALL';
    if (canShowStaffInstall && showIosInstructions) return 'IOS';
    if (canShowCustomerInstall && installPrompt && !recentlyDismissed(CUSTOMER_INSTALL_DISMISSED_AT_KEY)) return 'CUSTOMER_INSTALL';
    if (canShowCustomerInstall && isIosOrIpadOs() && !recentlyDismissed(CUSTOMER_IOS_INSTALL_DISMISSED_AT_KEY)) return 'CUSTOMER_IOS';
    return null;
  }, [canShowCustomerInstall, canShowStaffInstall, criticalOperationActive, installPrompt, isCustomerRoute, showIosInstructions, waitingRegistration]);

  if (!visiblePrompt) return null;

  if (visiblePrompt === 'UPDATE' && waitingRegistration) {
    return (
      <aside className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[95] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-amber-200 bg-white p-3 shadow-xl" role="status" aria-live="polite">
        <RefreshCw size={19} className="shrink-0 text-amber-700" />
        <p className="min-w-0 flex-1 text-sm font-bold text-neutral-800">A new version is available</p>
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
      <aside className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[95] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-[#dfd0c2] bg-white p-3 shadow-xl" aria-label="Install Coffee Bond POS">
        <Download size={19} className="shrink-0 text-[#5c4033]" />
        <p className="min-w-0 flex-1 text-sm font-bold text-neutral-800">Install Coffee Bond POS</p>
        <button type="button" onClick={() => void install()} disabled={installing} className="min-h-11 rounded-xl bg-[#4a3026] px-3 text-sm font-black text-white disabled:opacity-60">
          {installing ? 'Opening...' : 'Install'}
        </button>
        <button type="button" onClick={() => { rememberDismissal(INSTALL_DISMISSED_AT_KEY); setInstallPrompt(null); }} className="flex h-11 w-11 items-center justify-center rounded-xl text-neutral-600" aria-label="Dismiss install prompt">
          <X size={18} />
        </button>
      </aside>
    );
  }

  if (visiblePrompt === 'CUSTOMER_UPDATE' && waitingRegistration) {
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

  if (visiblePrompt === 'CUSTOMER_INSTALL' && installPrompt) {
    const installCustomerApp = async () => {
      setInstalling(true);
      try {
        await installPrompt.prompt();
        const choice = await installPrompt.userChoice;
        if (choice.outcome === 'dismissed') rememberDismissal(CUSTOMER_INSTALL_DISMISSED_AT_KEY);
        setInstallPrompt(null);
      } finally {
        setInstalling(false);
      }
    };
    return (
      <aside className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[95] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-[#dfd0c2] bg-white p-3 shadow-xl" aria-label="Install the Coffee Bond ordering app">
        <Download size={19} className="shrink-0 text-[#5c4033]" />
        <p className="min-w-0 flex-1 text-sm font-bold text-neutral-800">Add Coffee Bond to your home screen</p>
        <button type="button" onClick={() => void installCustomerApp()} disabled={installing} className="min-h-11 rounded-xl bg-[#4a3026] px-3 text-sm font-black text-white disabled:opacity-60">
          {installing ? 'Opening...' : 'Install'}
        </button>
        <button type="button" onClick={() => { rememberDismissal(CUSTOMER_INSTALL_DISMISSED_AT_KEY); setInstallPrompt(null); }} className="flex h-11 w-11 items-center justify-center rounded-xl text-neutral-600" aria-label="Dismiss install prompt">
          <X size={18} />
        </button>
      </aside>
    );
  }

  if (visiblePrompt === 'CUSTOMER_IOS') {
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
          <button type="button" onClick={() => { rememberDismissal(CUSTOMER_IOS_INSTALL_DISMISSED_AT_KEY); setCustomerEngaged(false); }} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-neutral-600" aria-label="Dismiss Home Screen instructions">
            <X size={18} />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-[95] mx-auto max-w-md rounded-2xl border border-[#dfd0c2] bg-white p-4 shadow-xl" aria-label="Install Coffee Bond POS on iPhone or iPad">
      <div className="flex items-start gap-3">
        <Share2 size={19} className="mt-0.5 shrink-0 text-[#5c4033]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black text-neutral-900">Add Coffee Bond POS to your Home Screen</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs font-semibold leading-relaxed text-neutral-600">
            <li>Open this page in Safari.</li>
            <li>Tap Share.</li>
            <li>Select Add to Home Screen.</li>
            <li>Tap Add.</li>
          </ol>
        </div>
        <button type="button" onClick={() => { rememberDismissal(IOS_INSTALL_DISMISSED_AT_KEY); setShowIosInstructions(false); }} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-neutral-600" aria-label="Dismiss iOS install instructions">
          <X size={18} />
        </button>
      </div>
    </aside>
  );
}
