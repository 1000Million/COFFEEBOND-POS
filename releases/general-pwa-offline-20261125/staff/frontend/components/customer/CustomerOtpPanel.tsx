import React, { useEffect, useRef, useState } from 'react';
import { ConfirmationResult, RecaptchaVerifier } from 'firebase/auth';
import { CheckCircle2, Loader2, Phone } from 'lucide-react';
import {
  CustomerProfile,
  invalidateCustomerVerification,
  sendCustomerOtp,
  verifyCustomerOtp,
} from '../../lib/customerAuth';
import { OFFLINE_ACTION_MESSAGE, requireOnlineAction } from '../../lib/connectivity';

type Props = {
  mobile: string;
  onMobileChange: (mobile: string) => void;
  onVerified: (profile: CustomerProfile) => void;
  verifiedPhone?: string | null;
};

const RESEND_SECONDS = 45;

export default function CustomerOtpPanel({
  mobile,
  onMobileChange,
  onVerified,
  verifiedPhone,
}: Props) {
  const recaptchaRef = useRef<HTMLDivElement>(null);
  const verifierRef = useRef<RecaptchaVerifier | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (seconds <= 0) return undefined;
    const timer = window.setInterval(() => setSeconds(value => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [seconds]);

  useEffect(() => () => verifierRef.current?.clear(), []);

  const send = async () => {
    if (!recaptchaRef.current || busy || (confirmation && seconds > 0)) return;
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    setBusy(true);
    setError(null);
    verifierRef.current?.clear();
    try {
      const result = await sendCustomerOtp(mobile, recaptchaRef.current);
      verifierRef.current = result.verifier;
      setConfirmation(result.confirmation);
      setSeconds(RESEND_SECONDS);
      setOtp('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not send the SMS code.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!confirmation || busy) return;
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const profile = await verifyCustomerOtp(confirmation, otp);
      onVerified(profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The SMS code could not be verified.');
    } finally {
      setBusy(false);
    }
  };

  const changeNumber = async () => {
    await invalidateCustomerVerification();
    verifierRef.current?.clear();
    verifierRef.current = null;
    setConfirmation(null);
    setOtp('');
    setSeconds(0);
    setError(null);
    onMobileChange('');
  };

  if (verifiedPhone) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-black text-emerald-800">
            <CheckCircle2 size={17} />
            Mobile verified · +91 ••••••{verifiedPhone.slice(-4)}
          </span>
          <button type="button" onClick={changeNumber} className="text-xs font-black text-emerald-900 underline">
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cb-customer-otp-panel">
      <label className="text-xs font-black uppercase tracking-wider text-neutral-500">
        Mobile verification
        <span className="mt-2 flex h-12 items-center rounded-xl border border-[#e4d7c8] bg-[#fffdfb] px-3">
          <span className="mr-2 inline-flex items-center gap-1 border-r border-[#e4d7c8] pr-2 text-sm font-black text-[#5c4033]">
            <Phone size={15} /> +91
          </span>
          <input
            value={mobile}
            onChange={(event) => {
              const next = event.target.value.replace(/\D/g, '').slice(0, 10);
              onMobileChange(next);
              if (confirmation) {
                verifierRef.current?.clear();
                verifierRef.current = null;
                setConfirmation(null);
                setOtp('');
                setSeconds(0);
              }
            }}
            disabled={Boolean(confirmation)}
            placeholder="10-digit mobile number"
            inputMode="numeric"
            autoComplete="tel"
            className="cb-customer-otp-input min-w-0 flex-1 bg-transparent text-sm font-bold outline-none disabled:text-neutral-500"
          />
        </span>
      </label>
      {!confirmation ? (
        <>
          <button
            type="button"
            onClick={send}
            data-requires-online="true"
            disabled={busy || mobile.length !== 10}
            className="mt-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#3b261d] px-4 py-3 text-sm font-black text-white disabled:bg-neutral-300"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            Send OTP
          </button>
          <p className="mt-2 text-xs text-neutral-500">
            An SMS verification code will be sent to this number. Standard SMS rates may apply.
          </p>
        </>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
          <input
            value={otp}
            onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="6-digit OTP"
            inputMode="numeric"
            autoComplete="one-time-code"
            className="h-12 rounded-xl border border-[#e4d7c8] px-3 text-center text-lg font-black tracking-[0.3em] outline-none focus:border-[#5c4033]"
          />
          <button
            type="button"
            onClick={verify}
            data-requires-online="true"
            disabled={busy || otp.length !== 6}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#3b261d] px-5 py-3 text-sm font-black text-white disabled:bg-neutral-300"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            Verify OTP
          </button>
          <div className="flex items-center justify-between gap-3 text-xs font-bold sm:col-span-2">
            <button type="button" data-requires-online="true" onClick={send} disabled={seconds > 0 || busy} className="min-h-11 text-[#5c4033] disabled:text-neutral-400">
              {seconds > 0 ? `Resend in ${seconds}s` : 'Resend OTP'}
            </button>
            <button type="button" onClick={changeNumber} className="text-neutral-600 underline">
              Change number
            </button>
          </div>
        </div>
      )}
      <div ref={recaptchaRef} aria-hidden="true" />
      {error && <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{error}</p>}
    </div>
  );
}
