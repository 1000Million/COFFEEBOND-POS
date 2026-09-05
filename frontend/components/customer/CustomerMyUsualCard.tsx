import { ComponentType } from 'react';
import { ArrowRight, Coffee, Trash2, UtensilsCrossed, Wheat } from 'lucide-react';
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
  /** Real current-menu image used only by the unchanged signed-out discovery state. */
  discoveryImageUrl?: string | null;
  discoveryImageName?: string;
  discoveryImageIsFood?: boolean;
  /** Formatted menu subtotal recalculated from live prices at the CURRENT store, or null. */
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
  /** Uses the existing menu/category path; omitted when no pastry category is available. */
  onAddPastry?: () => void;
  /** Honest order-type label supplied by the screen; price remains a separate live value. */
  orderActionLabel?: string;
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
  discoveryImageUrl = null,
  discoveryImageName = 'Coffee Bond menu',
  discoveryImageIsFood = false,
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
  onAddPastry,
  orderActionLabel = 'Place pickup',
}: Props) {
  const DiscoveryIcon = discoveryImageIsFood ? UtensilsCrossed : Coffee;
  const discoveryVisual = discoveryImageUrl ? (
    <div className="cb-customer-usual-photo is-discovery" aria-hidden="true">
      <CustomerProductImage
        src={discoveryImageUrl}
        alt={discoveryImageName}
        icon={DiscoveryIcon}
        iconClassName="text-[#9a6a2e]"
        className="h-full w-full"
        priority
      />
    </div>
  ) : (
    <div className="cb-customer-usual-art" aria-hidden="true">
      <Wheat size={58} strokeWidth={1.25} />
      <Coffee size={34} strokeWidth={1.45} />
    </div>
  );

  if (state === 'SIGNED_OUT') {
    return (
      <section className="cb-customer-usual-hero is-signed-out" aria-labelledby="cb-my-usual-heading">
        {discoveryVisual}
        <div className="cb-customer-usual-content">
          <p className="cb-customer-usual-eyebrow">My Usual</p>
          <h2 id="cb-my-usual-heading" className="cb-customer-usual-name">Your everyday favourite</h2>
          <p className="cb-customer-usual-copy">Sign in to save it once and order it again in a tap.</p>
          <button
            type="button"
            onClick={onSignIn}
            data-requires-online="true"
            className="cb-customer-usual-primary"
          >
            Sign in <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </section>
    );
  }

  if (state === 'EMPTY') {
    return (
      <section className="cb-customer-usual-hero is-empty" aria-labelledby="cb-my-usual-heading">
        <div className="cb-customer-usual-content">
          <p className="cb-customer-usual-eyebrow">YOUR USUAL</p>
          <h2 id="cb-my-usual-heading" className="cb-customer-usual-name">Start a usual</h2>
          <p className="cb-customer-usual-copy">
            Save the order you always make.<br />
            Next time it’s one tap.
          </p>
          <button type="button" onClick={onCreate} className="cb-customer-usual-primary">
            Build it from the menu <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </section>
    );
  }

  if (state === 'LOADING') {
    return (
      <section className="cb-customer-usual-hero is-loading" aria-labelledby="cb-my-usual-heading" aria-busy="true">
        <div className="cb-customer-skeleton cb-customer-usual-loading-photo motion-reduce:animate-none" />
        <div className="cb-customer-usual-content">
          <p className="cb-customer-usual-eyebrow">My Usual</p>
          <h2 id="cb-my-usual-heading" className="sr-only">My Usual</h2>
          <div className="cb-customer-skeleton h-6 w-4/5 animate-pulse rounded-full motion-reduce:animate-none" />
          <div className="cb-customer-skeleton mt-3 h-3 w-full animate-pulse rounded-full motion-reduce:animate-none" />
          <div className="cb-customer-skeleton mt-2 h-3 w-3/5 animate-pulse rounded-full motion-reduce:animate-none" />
          <div className="cb-customer-skeleton mt-auto h-11 w-full animate-pulse rounded-full motion-reduce:animate-none" />
        </div>
      </section>
    );
  }

  const icon = (isFood: boolean): ComponentType<{ size?: number; className?: string }> =>
    (isFood ? UtensilsCrossed : Coffee);

  const lead = lines[0];
  const LeadIcon = lead ? icon(lead.isFood) : Coffee;
  const leadDetails = [
    lead && lead.quantity > 1 ? `${lead.quantity} servings` : '',
    lead?.addOnSummary || '',
  ].filter(Boolean).join(' · ');
  const primaryLabel = blockerMessage
    ? 'Review My Usual'
    : `${orderActionLabel}${totalLabel ? ` · ${totalLabel}` : ''}`;

  return (
    <section className={`cb-customer-usual-hero is-saved${blockerMessage || noticeMessage ? ' has-message' : ''}${lines.length > 1 ? ' has-extras' : ''}`} aria-labelledby="cb-my-usual-heading">
      <div className="cb-customer-usual-photo">
        <CustomerProductImage
          src={lead?.imageUrl || null}
          alt={lead?.name || 'My Usual'}
          icon={LeadIcon}
          iconClassName="text-[#9a6a2e]"
          className="h-full w-full"
          priority
        />
        {lines.length > 1 && (
          <span className="cb-customer-usual-count" aria-label={`${lines.length} saved items`}>+{lines.length - 1}</span>
        )}
        <div className="cb-customer-usual-photo-controls">
          <button
            type="button"
            onClick={onDelete}
            disabled={busy || offline}
            aria-label="Delete My Usual"
            className="cb-customer-usual-icon-button is-danger"
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="cb-customer-usual-content">
        <p className="cb-customer-usual-eyebrow">My Usual</p>
        <h2 id="cb-my-usual-heading" className="cb-customer-usual-name">{lead?.name || 'My Usual'}</h2>

        {(leadDetails || lead?.unavailableReason) && (
          <div className="cb-customer-usual-lead-detail">
            {leadDetails && <span className="cb-customer-usual-lead-modifiers">{leadDetails}</span>}
            {lead?.unavailableReason && <small>{lead.unavailableReason}</small>}
          </div>
        )}

        <div className="cb-customer-usual-price-row">
          {totalLabel ? (
            <>
              <p
                className="cb-customer-usual-price"
                aria-label={`Current menu price ${totalLabel}; GST added at checkout`}
              >
                {totalLabel}
              </p>
              <p className="sr-only">GST is added at checkout.</p>
            </>
          ) : blockerMessage ? (
            <p className="cb-customer-usual-review">Review required</p>
          ) : null}
        </div>

        <div className="cb-customer-usual-actions">
        <button
          type="button"
          onClick={onOrder}
          // A blocker must stay TAPPABLE: tapping is what names the unavailable items
          // and offers Edit / Choose another store. Only offline and in-flight work
          // disable it. The reorder itself is still refused by the screen.
          disabled={busy || offline}
          data-requires-online="true"
          aria-label={busy ? 'Checking My Usual' : primaryLabel}
          className="cb-customer-usual-primary min-w-0 flex-1"
        >
          <span>{busy ? 'Checking...' : primaryLabel}</span>
          <ArrowRight size={15} aria-hidden="true" />
        </button>
        </div>

        <div className="cb-customer-usual-secondary-actions">
          <button
            type="button"
            onClick={onEdit}
            disabled={busy || offline}
            className="cb-customer-usual-secondary"
          >
            Change
          </button>
          {onAddPastry && (
            <button
              type="button"
              onClick={onAddPastry}
              className="cb-customer-usual-secondary"
            >
              Add a pastry
            </button>
          )}
        </div>

        {blockerMessage && (
          <p className="cb-customer-usual-message is-error" role="status" aria-live="polite">{blockerMessage}</p>
        )}
        {!blockerMessage && noticeMessage && (
          <p className="cb-customer-usual-message" role="status" aria-live="polite">{noticeMessage}</p>
        )}
        <p className="sr-only">Saved to your Coffee Bond profile</p>
      </div>

      {/* The hero stays compact for a one-line usual. Multi-line bundles disclose every
          saved line in a bounded, full-width footer; blockers open it automatically. */}
      {lines.length > 1 && (
        <details className="cb-customer-usual-more" open={Boolean(blockerMessage)}>
          <summary>+{lines.length - 1} more saved item{lines.length === 2 ? '' : 's'}</summary>
          <ul className="cb-customer-usual-lines">
            {lines.slice(1).map(line => (
              <li key={line.key} className={line.unavailableReason ? 'is-unavailable' : undefined}>
                <span>{line.quantity}× {line.name}</span>
                {line.addOnSummary && <span> · {line.addOnSummary}</span>}
                {line.unavailableReason && <small>{line.unavailableReason}</small>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
