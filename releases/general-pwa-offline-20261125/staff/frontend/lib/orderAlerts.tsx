import React, { useEffect, useRef, useSyncExternalStore } from 'react';

// One shared, locally generated loop. Web Audio keeps the cadence independent of
// background-tab timer throttling; no network audio or business writes are used.
let context: AudioContext | null = null;
let loop: AudioBufferSourceNode | null = null;
let blocked = true;
let muted = false; // Session/device scope, shared by the existing controller.
let audioIntent = 0;
const pending = new Map<symbol, number>();
const listeners = new Set<() => void>();

// Both operational checks and pending alerts use identical samples and volume.
function createAlertBuffer(context: AudioContext) {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 1.6), context.sampleRate);
  const samples = buffer.getChannelData(0);
  for (const [start, frequency] of [[0, 660], [0.25, 880]]) {
    for (let i = 0; i < context.sampleRate * 0.2; i++) {
      const t = i / context.sampleRate;
      const envelope = Math.min(t / 0.012, 1) * Math.max(0, 1 - t / 0.2);
      samples[Math.floor(start * context.sampleRate) + i] =
        0.45 * envelope * Math.sin(2 * Math.PI * frequency * t);
    }
  }
  return buffer;
}

let preview: AudioBufferSourceNode | null = null;
async function playAudioCheck(duration: number) {
  const intent = audioIntent;
  await unlockAudio();
  if (intent !== audioIntent || !context || context.state !== 'running') return;
  if (preview) {
    preview.stop();
    preview.disconnect();
    preview = null;
  }
  // The real alert is already playing this exact sound; do not layer another
  // copy over it or stop it when the operational check would finish.
  if (loop) return;
  const source = context.createBufferSource();
  source.buffer = createAlertBuffer(context);
  source.loop = true;
  source.connect(context.destination);
  source.onended = () => {
    source.disconnect();
    if (preview === source) preview = null;
  };
  preview = source;
  source.start();
  source.stop(context.currentTime + duration);
}

async function enableAudioWithConfirmation({ confirmation = true }: { confirmation?: boolean } = {}) {
  ++audioIntent;
  const wasMuted = muted;
  muted = false;
  reconcileAudio(); // Recheck actual context state before reporting a successful enable.
  if (wasMuted) listeners.forEach(listener => listener());
  // The compact switch unlocks without running the explicit Test sound action.
  if (confirmation) await playAudioCheck(0.5);
  else await unlockAudio();
}

function muteAudio() {
  ++audioIntent;
  muted = true;
  if (preview) { preview.stop(); preview.disconnect(); preview = null; }
  reconcileAudio();
  listeners.forEach(listener => listener());
}

export function TestAlertSoundButton() {
  return <button type="button" onClick={() => void playAudioCheck(2.8)}
    className="min-h-[48px] shrink-0 rounded-xl border border-amber-900 px-4 py-3 text-sm font-black text-amber-950">
    🔊 Test alert sound
  </button>;
}

function reconcileAudio() {
  const nextBlocked = context?.state !== 'running';
  if (blocked !== nextBlocked) {
    blocked = nextBlocked;
    listeners.forEach(listener => listener());
  }
  const shouldSound = !muted && !blocked && [...pending.values()].some(count => count > 0);
  if (!shouldSound && loop) {
    loop.stop();
    loop.disconnect();
    loop = null;
  }
  if (!shouldSound || loop || !context) return;

  const buffer = createAlertBuffer(context);
  if (preview) { preview.stop(); preview.disconnect(); preview = null; }
  loop = context.createBufferSource();
  loop.buffer = buffer;
  loop.loop = true;
  loop.connect(context.destination);
  loop.start();
}

async function unlockAudio() {
  try {
    if (!context || context.state === 'closed') {
      const AudioContextClass = window.AudioContext
        || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      context = new AudioContextClass();
      context.onstatechange = reconcileAudio;
    }
    // Call resume synchronously inside the trusted gesture, before awaiting.
    if (context.state !== 'running') await context.resume();
    reconcileAudio();
  } catch {
    // A failed/denied resume remains visibly blocked and can be retried.
    reconcileAudio();
  }
}

// Mounted by the eager staff shell, before the lazy order/KOT routes load.
export function useOrderAlertAudioUnlock() {
  useEffect(() => {
    const unlock = (event: Event) => {
      // Explicit sound controls own their gesture; a prior mute survives other clicks.
      if (event.isTrusted && !muted
        && !(event.target as Element | null)?.closest?.('[data-order-sound-control]')) void unlockAudio();
    };
    const events = ['pointerdown', 'touchend', 'keydown', 'click'];
    events.forEach(name => window.addEventListener(name, unlock, true));
    return () => events.forEach(name => window.removeEventListener(name, unlock, true));
  }, []);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useRepeatingOrderAlert(pendingCount: number) {
  const owner = useRef(Symbol('order-alert'));
  const audioState = useSyncExternalStore(subscribe, () => (blocked ? 1 : 0) | (muted ? 2 : 0), () => 1);
  const audioMuted = Boolean(audioState & 2);
  const audioBlocked = Boolean(audioState & 1) || audioMuted;
  useEffect(() => {
    pending.set(owner.current, pendingCount);
    reconcileAudio();
  }, [pendingCount]);
  useEffect(() => {
    const key = owner.current;
    return () => { pending.delete(key); reconcileAudio(); };
  }, []);
  return { audioBlocked, audioMuted, audioEnabled: !audioBlocked && !audioMuted,
    enableAudio: enableAudioWithConfirmation, muteAudio };
}

export function OrderAlertBanner({ pendingCount, action }: { pendingCount: number; action: string }) {
  const { audioBlocked, enableAudio } = useRepeatingOrderAlert(pendingCount);
  return (
    <div role="status" className={`mb-5 flex min-w-0 flex-col gap-3 rounded-2xl border-2 p-4 sm:flex-row sm:items-center sm:justify-between ${audioBlocked || pendingCount > 0 ? 'border-amber-500 bg-amber-50 text-amber-950' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
      <div className="min-w-0 text-sm font-bold">
        <p className="font-black">{audioBlocked ? 'Order alert sound is off' : pendingCount > 0 ? 'Order alert sounding' : 'Order alerts enabled'}</p>
        <p>{pendingCount > 0 ? `${pendingCount} awaiting action. ${action}` : 'Sound will repeat when new orders arrive.'}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
      <TestAlertSoundButton />
      {audioBlocked && (
        <button type="button" onPointerDown={() => void enableAudio()} onClick={() => void enableAudio()} className="min-h-[48px] shrink-0 rounded-xl bg-amber-900 px-4 py-3 text-sm font-black text-white">
          Tap to enable order alerts
        </button>
      )}
      </div>
    </div>
  );
}
