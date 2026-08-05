import React, { ReactNode, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Loader2,
  LogOut,
  Pencil,
  ShoppingBag,
  UserCircle2,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import coffeeBondLogo from '../../assets/coffee-bond-logo.png';
import {
  CustomerProfile,
  signOutCustomer,
  updateCustomerProfile,
} from '../../lib/customerAuth';
import { lastCustomerOrderTrackingToken } from '../../lib/customerOrderPersistence';
import { OFFLINE_ACTION_MESSAGE, requireOnlineAction } from '../../lib/connectivity';
import { CUSTOMER_HOME_PATH, CUSTOMER_MY_ORDERS_PATH, customerStatusPath } from '../../lib/customerRoutes';

type Props = {
  title: string;
  profile: CustomerProfile | null;
  authRestored: boolean;
  onProfileUpdated?: (profile: CustomerProfile) => void;
  onSignedOut?: () => void;
  rightSlot?: ReactNode;
  sticky?: boolean;
  /**
   * Supplied by screens that already expose a My Orders destination in the bottom
   * navigation. When present, the signed-out header control becomes a plain account
   * button that raises this callback instead of linking to /my-orders, so the home
   * screen has exactly one direct My Orders link.
   *
   * When omitted (order status, and any screen without the bottom navigation) the
   * control stays a link to My Orders, so account access is never lost.
   */
  onSignedOutAccountPress?: () => void;
};

function maskedPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? `+91 •••••• ${digits.slice(-4)}` : 'Verified mobile';
}

export default function CustomerHeader({
  title,
  profile,
  authRestored,
  onProfileUpdated,
  onSignedOut,
  rightSlot,
  sticky = false,
  onSignedOutAccountPress,
}: Props) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [defaultOrderType, setDefaultOrderType] = useState<'PICKUP' | 'DINE_IN'>('PICKUP');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const currentOrderToken = lastCustomerOrderTrackingToken();

  useEffect(() => {
    setDisplayName(profile?.displayName || '');
    setDefaultOrderType(profile?.defaultOrderType || 'PICKUP');
  }, [profile]);

  useEffect(() => {
    if (!accountOpen) {
      setEditing(false);
      setMessage('');
      setError('');
    }
  }, [accountOpen]);

  const saveProfile = async () => {
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    const nextName = displayName.trim().replace(/\s+/g, ' ');
    if (!nextName || nextName.length > 80) {
      setError('Enter a name between 1 and 80 characters.');
      return;
    }
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await updateCustomerProfile({
        displayName: nextName,
        defaultOrderType,
      });
      onProfileUpdated?.(result.data);
      setDisplayName(result.data.displayName);
      setDefaultOrderType(result.data.defaultOrderType);
      setEditing(false);
      setMessage('Profile updated.');
    } catch {
      setError('We could not update your profile. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = async () => {
    if (!requireOnlineAction()) {
      setError(OFFLINE_ACTION_MESSAGE);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await signOutCustomer();
      onSignedOut?.();
      setAccountOpen(false);
    } catch {
      setError('We could not sign you out. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <header className={`${sticky ? 'sticky top-0 z-30' : ''} border-b border-[#eadfd3]/80 bg-[#fbf7f1]/95 px-4 pt-[max(env(safe-area-inset-top),0px)] backdrop-blur`}>
        <div className="mx-auto flex min-h-[60px] w-full min-w-0 items-center justify-between gap-2 py-1.5 lg:max-w-6xl">
          <Link to={CUSTOMER_HOME_PATH} className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5e42]/60">
            <img src={coffeeBondLogo} alt="" className="h-9 w-9 shrink-0 rounded-xl bg-white object-contain p-1 shadow-sm" />
            <div className="min-w-0">
              <p className="whitespace-nowrap text-sm font-black uppercase text-[#271a16]">Coffee Bond</p>
              <h1 className="hidden truncate text-[11px] font-bold leading-tight text-[#8b5e42] sm:block">{title}</h1>
            </div>
          </Link>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {!authRestored ? (
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-[#8b5e42]" aria-label="Restoring customer session">
                <Loader2 size={17} className="animate-spin" />
              </span>
            ) : profile ? (
              <button
                type="button"
                onClick={() => setAccountOpen(true)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-left shadow-sm ring-1 ring-[#e7ddd3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5e42]/60 sm:w-auto sm:max-w-[148px] sm:justify-start sm:gap-2 sm:px-2.5"
                aria-label="Open customer account"
              >
                <UserCircle2 size={20} className="shrink-0 text-[#8b5e42]" />
                <span className="hidden min-w-0 sm:block">
                  <span className="block truncate text-xs font-black text-[#2d2019]">{profile.displayName || 'My account'}</span>
                  <span className="block truncate text-[10px] font-bold text-emerald-700">{maskedPhone(profile.normalisedPhone)}</span>
                </span>
              </button>
            ) : onSignedOutAccountPress ? (
              /* The bottom navigation owns the My Orders destination, but it is
                 mobile-only (lg:hidden). So below lg the header is a plain account
                 control, and from lg — where the bar is gone — it becomes the My
                 Orders link again. Exactly one visible entry at every breakpoint. */
              <>
                <button
                  type="button"
                  onClick={onSignedOutAccountPress}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-xs font-black text-[#5c4033] shadow-sm ring-1 ring-[#e7ddd3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5e42]/60 lg:hidden"
                  aria-label="Customer account"
                >
                  <UserCircle2 size={17} />
                </button>
                <Link
                  to={CUSTOMER_MY_ORDERS_PATH}
                  className="hidden h-11 items-center gap-1.5 rounded-full bg-white px-3 text-xs font-black text-[#5c4033] shadow-sm ring-1 ring-[#e7ddd3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5e42]/60 lg:inline-flex"
                  aria-label="Customer account and My Orders"
                >
                  <UserCircle2 size={17} />
                  <span>Account</span>
                </Link>
              </>
            ) : (
              <Link
                to={CUSTOMER_MY_ORDERS_PATH}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-xs font-black text-[#5c4033] shadow-sm ring-1 ring-[#e7ddd3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5e42]/60 sm:w-auto sm:gap-1.5 sm:px-3"
                aria-label="Customer account and My Orders"
              >
                <UserCircle2 size={17} />
                <span className="hidden sm:inline">Account</span>
              </Link>
            )}
            {rightSlot}
          </div>
        </div>
      </header>

      {accountOpen && profile && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-start sm:justify-end sm:p-4">
          <button
            type="button"
            aria-label="Close customer account"
            onClick={() => setAccountOpen(false)}
            className="absolute inset-0 bg-black/35"
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="customer-account-title"
            className="relative z-10 max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl bg-[#fffdf9] p-5 shadow-2xl sm:w-[380px] sm:rounded-3xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                  <CheckCircle2 size={22} />
                </div>
                <div className="min-w-0">
                  <h2 id="customer-account-title" className="truncate text-lg font-black text-[#2d2019]">
                    {profile.displayName || 'My account'}
                  </h2>
                  <p className="text-xs font-bold text-emerald-700">{maskedPhone(profile.normalisedPhone)}</p>
                </div>
              </div>
              <button type="button" onClick={() => setAccountOpen(false)} className="flex h-11 w-11 items-center justify-center rounded-full bg-[#f5ede5] text-[#5c4033]" aria-label="Close customer account">
                <X size={17} />
              </button>
            </div>

            {message && <p role="status" className="mt-4 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800">{message}</p>}
            {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{error}</p>}

            {editing ? (
              <div className="mt-5 space-y-3">
                <label className="block text-xs font-black uppercase tracking-wider text-neutral-500">
                  Name
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value.slice(0, 80))}
                    className="mt-2 h-12 w-full rounded-xl border border-[#e4d7c8] bg-white px-3 text-sm font-bold normal-case tracking-normal outline-none focus:border-[#5c4033]"
                    autoComplete="name"
                  />
                </label>
                <label className="block text-xs font-black uppercase tracking-wider text-neutral-500">
                  Verified mobile
                  <input
                    value={maskedPhone(profile.normalisedPhone)}
                    readOnly
                    aria-readonly="true"
                    className="mt-2 h-12 w-full rounded-xl border border-[#e4d7c8] bg-neutral-100 px-3 text-sm font-bold normal-case tracking-normal text-neutral-500"
                  />
                </label>
                <label className="block text-xs font-black uppercase tracking-wider text-neutral-500">
                  Default order type
                  <select
                    value={defaultOrderType}
                    onChange={(event) => setDefaultOrderType(event.target.value as 'PICKUP' | 'DINE_IN')}
                    className="mt-2 h-12 w-full rounded-xl border border-[#e4d7c8] bg-white px-3 text-sm font-bold normal-case tracking-normal outline-none focus:border-[#5c4033]"
                  >
                    <option value="PICKUP">Takeaway / pickup</option>
                    <option value="DINE_IN">Dine in</option>
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button type="button" onClick={() => setEditing(false)} disabled={saving} className="min-h-12 rounded-xl bg-[#f5ede5] px-4 text-sm font-black text-[#5c4033]">
                    Cancel
                  </button>
                  <button type="button" data-requires-online="true" onClick={saveProfile} disabled={saving} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#3b261d] px-4 text-sm font-black text-white disabled:bg-neutral-300">
                    {saving && <Loader2 size={16} className="animate-spin" />}
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-5 space-y-2">
                <Link to={CUSTOMER_MY_ORDERS_PATH} onClick={() => setAccountOpen(false)} className="flex min-h-12 items-center justify-between rounded-2xl bg-white px-4 text-sm font-black text-[#2d2019] ring-1 ring-[#e7ddd3]">
                  <span className="inline-flex items-center gap-2"><ClipboardList size={18} /> My Orders</span>
                  <ChevronRight size={16} />
                </Link>
                {currentOrderToken && (
                  <Link to={customerStatusPath(currentOrderToken)} onClick={() => setAccountOpen(false)} className="flex min-h-12 items-center justify-between rounded-2xl bg-white px-4 text-sm font-black text-[#2d2019] ring-1 ring-[#e7ddd3]">
                    <span className="inline-flex items-center gap-2"><ShoppingBag size={18} /> Current Order</span>
                    <ChevronRight size={16} />
                  </Link>
                )}
                <button type="button" onClick={() => setEditing(true)} className="flex min-h-12 w-full items-center justify-between rounded-2xl bg-white px-4 text-sm font-black text-[#2d2019] ring-1 ring-[#e7ddd3]">
                  <span className="inline-flex items-center gap-2"><Pencil size={18} /> Edit Profile</span>
                  <ChevronRight size={16} />
                </button>
                <button type="button" data-requires-online="true" onClick={handleSignOut} disabled={saving} className="flex min-h-12 w-full items-center justify-between rounded-2xl bg-red-50 px-4 text-sm font-black text-red-800 disabled:opacity-60">
                  <span className="inline-flex items-center gap-2"><LogOut size={18} /> Sign Out</span>
                  {saving && <Loader2 size={16} className="animate-spin" />}
                </button>
                <p className="px-2 pt-2 text-xs leading-relaxed text-neutral-500">
                  Signing out protects your orders. Your basket stays saved on this device.
                </p>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
