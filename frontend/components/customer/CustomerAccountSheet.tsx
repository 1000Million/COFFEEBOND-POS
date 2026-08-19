import { useEffect, useRef, useState } from 'react';
import { BadgeCheck, ChevronRight, Coffee, Loader2, LogOut, UserRound, X } from 'lucide-react';
import {
  CustomerProfile,
  signOutCustomer,
  updateCustomerProfile,
} from '../../lib/customerAuth';
import { OFFLINE_ACTION_MESSAGE, requireOnlineAction } from '../../lib/connectivity';

type Props = {
  profile: CustomerProfile;
  onClose: () => void;
  onProfileUpdated?: (profile: CustomerProfile) => void;
  onSignedOut?: () => void;
  /** Opens the existing home-screen My Usual surface. Nothing about Stage 2 is re-implemented here. */
  onOpenMyUsual: () => void;
  /**
   * Opens straight into the profile form. The app never passes this — it exists so the
   * editing state can be rendered and measured on its own, which is otherwise only
   * reachable through a click.
   */
  initialEditing?: boolean;
};

export function maskedPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 4 ? `+91 •••••• ${digits.slice(-4)}` : 'Verified mobile';
}

/**
 * Customer account panel.
 *
 * This is an ACCOUNT surface, not a second navigation menu. It carries only what an
 * account owns:
 *
 *   identity   name, verified state, masked phone
 *   actions    My Usual, Profile
 *   ---------- hairline
 *   Sign out
 *
 * Order content is deliberately absent: the Orders tab surfaces the live order itself,
 * so routing to it from here would make the same destination reachable three ways.
 *
 * Visually it is a sheet rather than a settings list. The name is the largest thing on
 * it; the two actions are flat rows sharing one hairline instead of bordered pills; and
 * sign out sits below the rule, unfilled, so it reads as secondary without needing a
 * heading to say so. Nothing here is a card inside a card.
 *
 * My Usual is a compact row, not a second copy of the home card: it raises
 * onOpenMyUsual so the existing profile-synced Stage 2 surface handles it. Editing
 * still calls the same updateCustomerProfile callable with the same two editable
 * fields — no field is invented here, and no order, cart or payment state is touched.
 *
 * The phone number is never shown in full.
 */
export default function CustomerAccountSheet({
  profile,
  onClose,
  onProfileUpdated,
  onSignedOut,
  onOpenMyUsual,
  initialEditing = false,
}: Props) {
  const [editing, setEditing] = useState(initialEditing);
  const [displayName, setDisplayName] = useState(profile.displayName || '');
  const [defaultOrderType, setDefaultOrderType] = useState<'PICKUP' | 'DINE_IN'>(profile.defaultOrderType || 'PICKUP');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setDisplayName(profile.displayName || '');
    setDefaultOrderType(profile.defaultOrderType || 'PICKUP');
  }, [profile]);

  /* Focus enters the panel on open and Escape closes it, so the sheet behaves like a
     dialog for keyboard and screen-reader users rather than a floating div. */
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const node = panelRef.current;
    node?.addEventListener('keydown', onKeyDown);
    return () => node?.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
      const result = await updateCustomerProfile({ displayName: nextName, defaultOrderType });
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
      onClose();
    } catch {
      setError('We could not sign you out. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cb-customer-layer-modal fixed inset-0 flex items-end justify-center sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="Close customer account"
        onClick={onClose}
        className="cb-customer-sheet-scrim absolute inset-0"
      />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-account-title"
        className="cb-customer-account-sheet relative z-10 max-h-[90dvh] w-full overflow-y-auto sm:w-[380px]"
      >
        <span className="cb-customer-sheet-grabber" aria-hidden="true" />

        {/* Identity. Name first and large; everything else about the account is
            metadata and is styled as such. */}
        <div className="cb-customer-account-identity flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="customer-account-title" className="cb-customer-account-name truncate">
              {profile.displayName || 'My account'}
            </h2>
            <p className="cb-customer-account-verified mt-1.5">
              <BadgeCheck size={14} aria-hidden="true" />
              Verified customer
            </p>
            <p className="cb-customer-account-phone mt-0.5">{maskedPhone(profile.normalisedPhone)}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="cb-customer-icon-button -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
            aria-label="Close customer account"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {message && (
          <p role="status" className="cb-customer-checkout-notice tone-info mt-4 px-3 py-2.5 text-[12.5px] font-bold">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="cb-customer-checkout-notice tone-error mt-4 px-3 py-2.5 text-[12.5px] font-bold">
            {error}
          </p>
        )}

        {editing ? (
          /* No top margin: the identity block's own padding is the single spacer under
             the header, so the list state and the form state open at the same distance. */
          <div className="space-y-3">
            {/* Only the fields the profile callable actually accepts. */}
            <label className="cb-customer-field-label block">
              Name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value.slice(0, 80))}
                className="cb-customer-field mt-2 normal-case tracking-normal"
                autoComplete="name"
              />
            </label>
            <label className="cb-customer-field-label block">
              Verified mobile
              <input
                value={maskedPhone(profile.normalisedPhone)}
                readOnly
                aria-readonly="true"
                className="cb-customer-field is-readonly mt-2 normal-case tracking-normal"
              />
            </label>
            <label className="cb-customer-field-label block">
              Default order type
              <select
                value={defaultOrderType}
                onChange={(event) => setDefaultOrderType(event.target.value as 'PICKUP' | 'DINE_IN')}
                className="cb-customer-field mt-2 normal-case tracking-normal"
              >
                <option value="PICKUP">Takeaway / pickup</option>
                <option value="DINE_IN">Dine in</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={saving}
                className="cb-customer-quiet-button min-h-12 px-4 text-sm font-black"
              >
                Cancel
              </button>
              <button
                type="button"
                data-requires-online="true"
                onClick={saveProfile}
                disabled={saving}
                className="cb-customer-accent-button inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-black"
              >
                {saving && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                Save
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Two flat rows sharing one hairline. No group headings: the rule below
                is what separates the account's actions from leaving it. */}
            <div className="cb-customer-rows">
              <button type="button" onClick={onOpenMyUsual} className="cb-customer-row">
                <Coffee size={20} className="cb-customer-row-icon" aria-hidden="true" />
                <span className="cb-customer-row-title flex-1">My Usual</span>
                <ChevronRight size={18} className="cb-customer-row-chevron" aria-hidden="true" />
              </button>
              <button type="button" onClick={() => setEditing(true)} className="cb-customer-row">
                <UserRound size={20} className="cb-customer-row-icon" aria-hidden="true" />
                <span className="cb-customer-row-title flex-1">Profile</span>
                <ChevronRight size={18} className="cb-customer-row-chevron" aria-hidden="true" />
              </button>
            </div>

            <hr className="cb-customer-rule my-3" />

            <button
              type="button"
              data-requires-online="true"
              onClick={handleSignOut}
              disabled={saving}
              className="cb-customer-row cb-customer-signout disabled:opacity-60"
            >
              <LogOut size={20} className="cb-customer-row-icon" aria-hidden="true" />
              <span className="cb-customer-row-title flex-1">Sign out</span>
              {saving && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            </button>

            <p className="cb-customer-account-note mt-1">Your basket stays saved on this device.</p>
          </>
        )}
      </section>
    </div>
  );
}
