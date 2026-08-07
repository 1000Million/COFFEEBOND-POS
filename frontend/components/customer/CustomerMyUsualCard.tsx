import { ComponentType } from 'react';
import { Coffee, Pencil, RefreshCw, Trash2, UtensilsCrossed } from 'lucide-react';
import CustomerProductImage from './CustomerProductImage';

export type MyUsualPreviewLine = {
  key: string;
  /** Live product name where this store sells it, else the readable saved code. */
  name: string;
  quantity: number;
  /** Concise add-on summary built from current add-on data. */
  addOnSummary: string;
  imageUrl: string | null;
  isFood: boolean;
  /**
   * Set when THIS store cannot fulfil the line. The line is still rendered — a
   * blocked line that disappeared would read as a silently reduced usual.
   */
  unavailableReason?: string;
};

type Props = {
  /**
   * SIGNED_OUT is a distinct state, not an empty one: a signed-out customer has no
   * usual to show and must never be offered a permanent save.
   */
  state: 'SIGNED_OUT' | 'EMPTY' | 'LOADING' | 'SAVED';
  lines: MyUsualPreviewLine[];
  /** Formatted total recalculated from live prices at the CURRENT store, or null. */
  totalLabel: string | null;
  /** Hard blocker text — reorder is disabled while present. */
  blockerMessage?: string;
  /** Non-blocking notice, e.g. a price change. */
  noticeMessage?: string;
  busy?: boolean;
  /** Offline disables every server action — reorder, edit and delete alike. */
  offline?: boolean;
  onSignIn: () => void;
  onCreate: () => void;
  onOrder: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

/**
 * "My Usual" home card.
 *
 * Presentation only: it renders what the screen has already revalidated against the
 * live menu and calls back. It computes no price, resolves no availability and
 * touches no cart state. Names, images and the total shown here are always the
 * current ones — nothing stale is displayed.
 */
export default function CustomerMyUsualCard({
  state,
  lines,
  totalLabel,
  blockerMessage,
  noticeMessage,
  busy = false,
  offline = false,
  onSignIn,
  onCreate,
  onOrder,
  onEdit,
  onDelete,
}: Props) {
  if (state === 'SIGNED_OUT') {
    return (
      <section className="cb-customer-usual-empty p-4" aria-labelledby="cb-my-usual-heading">
        <p className="cb-customer-usual-eyebrow text-[11px] font-black uppercase">My Usual</p>
        <h2 id="cb-my-usual-heading" className="mt-1 cb-customer-title text-base font-black">
          Sign in to save your regular coffee and food across your devices.
        </h2>
        <button
          type="button"
          onClick={onSignIn}
          data-requires-online="true"
          className="cb-customer-accent-button mt-3 inline-flex min-h-11 items-center rounded-2xl px-4 text-sm font-black"
        >
          Sign in to create My Usual
        </button>
      </section>
    );
  }

  if (state === 'EMPTY') {
    return (
      <section className="cb-customer-usual-empty p-4" aria-labelledby="cb-my-usual-heading">
        <p className="cb-customer-usual-eyebrow text-[11px] font-black uppercase">My Usual</p>
        <h2 id="cb-my-usual-heading" className="mt-1 cb-customer-title text-base font-black">
          Save your regular coffee and food to your Coffee Bond profile.
        </h2>
        <button
          type="button"
          onClick={onCreate}
          className="cb-customer-accent-button mt-3 inline-flex min-h-11 items-center rounded-2xl px-4 text-sm font-black"
        >
          Create My Usual
        </button>
      </section>
    );
  }

  if (state === 'LOADING') {
    return (
      <section className="cb-customer-usual p-4" aria-labelledby="cb-my-usual-heading" aria-busy="true">
        <p className="cb-customer-usual-eyebrow text-[11px] font-black uppercase">My Usual</p>
        <h2 id="cb-my-usual-heading" className="sr-only">My Usual</h2>
        {/* No fabricated total while the live menu is still loading. */}
        <div className="mt-2 flex items-center gap-2">
          {[0, 1, 2].map(key => (
            <div key={key} className="cb-customer-skeleton h-12 w-12 animate-pulse rounded-2xl motion-reduce:animate-none" />
          ))}
          <div className="cb-customer-skeleton h-4 w-24 animate-pulse rounded-full motion-reduce:animate-none" />
        </div>
      </section>
    );
  }

  const icon = (isFood: boolean): ComponentType<{ size?: number; className?: string }> =>
    (isFood ? UtensilsCrossed : Coffee);

  return (
    <section className="cb-customer-usual p-4" aria-labelledby="cb-my-usual-heading">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="cb-customer-usual-eyebrow text-[11px] font-black uppercase">My Usual</p>
          {/* A usual belongs to the customer's profile, not to a store. The store it
              was first saved from is never surfaced as its owner — the total beside
              this heading is always recalculated for the store selected right now. */}
          <h2 id="cb-my-usual-heading" className="sr-only">My Usual</h2>
        </div>
        {/* A partial sum is never presented as the usual's total. */}
        {totalLabel ? (
          <p className="shrink-0 cb-customer-title text-base font-black" aria-label={`Current total ${totalLabel}`}>
            {totalLabel}
          </p>
        ) : blockerMessage ? (
          <p className="shrink-0 cb-customer-muted text-[12px] font-black uppercase">Review required</p>
        ) : null}
      </div>

      {/* Up to three thumbnails, laid out as a fixed collage — never a scroller. */}
      <div className="mt-3 flex items-center gap-2">
        <div className="flex shrink-0 items-center gap-1.5">
          {lines.slice(0, 3).map(line => (
            <CustomerProductImage
              key={line.key}
              src={line.imageUrl}
              alt=""
              icon={icon(line.isFood)}
              // Brand brown, not the surface beige: the fallback must be visible
              // against the muted thumbnail background rather than vanish into it.
              iconClassName="text-[#5c4033]"
              className="cb-customer-usual-thumb h-12 w-12"
            />
          ))}
        </div>
        {/* EVERY saved line is listed — a blocked one is labelled, never omitted. */}
        <ul className="min-w-0 flex-1 space-y-0.5">
          {lines.map(line => (
            <li key={line.key} className="min-w-0 cb-customer-title text-[12px] font-bold">
              <span className={line.unavailableReason ? 'line-through opacity-70' : undefined}>
                {line.quantity}× {line.name}
                {line.addOnSummary && <span className="cb-customer-muted font-semibold"> · {line.addOnSummary}</span>}
              </span>
              {line.unavailableReason && (
                <span className="cb-customer-usual-unavailable block text-[11px] font-black">
                  {line.unavailableReason}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Blockers and notices are stated in words, never colour alone, and announced. */}
      {blockerMessage && (
        <p className="cb-customer-usual-blocker mt-3 px-3 py-2 text-[12px] font-bold" role="status" aria-live="polite">
          {blockerMessage}
        </p>
      )}
      {!blockerMessage && noticeMessage && (
        <p className="cb-customer-usual-note mt-3 px-3 py-2 text-[12px] font-bold" role="status" aria-live="polite">
          {noticeMessage}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onOrder}
          // A blocker must stay TAPPABLE: tapping is what names the unavailable items
          // and offers Edit / Choose another store. Only offline and in-flight work
          // disable it. The reorder itself is still refused by the screen.
          disabled={busy || offline}
          data-requires-online="true"
          className="cb-customer-accent-button inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-black"
        >
          <RefreshCw size={16} aria-hidden="true" />
          {busy ? 'Checking...' : blockerMessage ? 'Review My Usual' : 'Order My Usual'}
        </button>
        <button
          type="button"
          onClick={onEdit}
          disabled={busy || offline}
          aria-label="Edit My Usual"
          className="cb-customer-icon-button inline-flex h-11 w-11 items-center justify-center rounded-2xl"
        >
          <Pencil size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy || offline}
          aria-label="Delete My Usual"
          className="cb-customer-icon-button-danger inline-flex h-11 w-11 items-center justify-center rounded-2xl"
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="cb-customer-muted mt-2 text-[11px] font-bold">Saved to your Coffee Bond profile</p>
    </section>
  );
}
