import { useEffect, useState } from 'react';
import { ArrowRight, Coffee, UtensilsCrossed, Wheat } from 'lucide-react';
import CustomerProductImage from './CustomerProductImage';

export type CustomerHomeSignatureProduct = {
  code: string;
  name: string;
  imageUrl: string | null;
  isFood: boolean;
};

type Props = {
  products: CustomerHomeSignatureProduct[];
  storeSelected: boolean;
  loading: boolean;
  canOrder: boolean;
  unavailableMessage?: string;
  onStart: (productCode: string) => void;
  onBrowseMenu: () => void;
};

/**
 * Product-first signed-out Home hero.
 *
 * Menu identity, imagery and availability are supplied by CustomerOrder from the
 * current public store snapshot. This component changes no basket, auth or checkout
 * state itself; it only selects a visible signature and delegates the existing action.
 */
export default function CustomerSignedOutStartCard({
  products,
  storeSelected,
  loading,
  canOrder,
  unavailableMessage,
  onStart,
  onBrowseMenu,
}: Props) {
  const [selectedCode, setSelectedCode] = useState(products[0]?.code || '');

  useEffect(() => {
    if (!products.some(product => product.code === selectedCode)) {
      setSelectedCode(products[0]?.code || '');
    }
  }, [products, selectedCode]);

  if (loading && storeSelected) {
    return (
      <section className="cb-customer-signature-hero is-loading" aria-labelledby="cb-start-here-heading" aria-busy="true">
        <div className="cb-customer-skeleton cb-customer-signature-loading-photo motion-reduce:animate-none" />
        <div className="cb-customer-signature-content">
          <p className="cb-customer-signature-eyebrow">Start from here</p>
          <h2 id="cb-start-here-heading" className="sr-only">Loading signature drinks</h2>
          <div className="cb-customer-skeleton h-7 w-3/5 animate-pulse rounded-full motion-reduce:animate-none" />
          <div className="cb-customer-skeleton mt-4 h-12 w-full animate-pulse rounded-2xl motion-reduce:animate-none" />
          <div className="cb-customer-skeleton mt-3 h-[52px] w-full animate-pulse rounded-2xl motion-reduce:animate-none" />
        </div>
      </section>
    );
  }

  if (!storeSelected) {
    return (
      <section className="cb-customer-signature-hero is-store-unknown" aria-labelledby="cb-start-here-heading">
        <div className="cb-customer-signature-art" aria-hidden="true">
          <Wheat size={70} strokeWidth={1.15} />
          <Coffee size={42} strokeWidth={1.35} />
        </div>
        <div className="cb-customer-signature-content">
          <p className="cb-customer-signature-eyebrow">Start from here</p>
          <h2 id="cb-start-here-heading" className="cb-customer-signature-name">Signature coffee, made your way</h2>
          <p className="cb-customer-signature-copy">Choose your Bond above to see what’s pouring today.</p>
        </div>
      </section>
    );
  }

  const selected = products.find(product => product.code === selectedCode) || products[0];

  if (!selected) {
    return (
      <section className="cb-customer-signature-hero is-fallback" aria-labelledby="cb-start-here-heading">
        <div className="cb-customer-signature-art" aria-hidden="true">
          <Wheat size={70} strokeWidth={1.15} />
          <Coffee size={42} strokeWidth={1.35} />
        </div>
        <div className="cb-customer-signature-content">
          <p className="cb-customer-signature-eyebrow">Start from here</p>
          <h2 id="cb-start-here-heading" className="cb-customer-signature-name">Find your coffee</h2>
          <p className="cb-customer-signature-copy">Our signature picks are resting. The current menu is ready when you are.</p>
          <button type="button" onClick={onBrowseMenu} className="cb-customer-signature-primary">
            Explore the menu <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </section>
    );
  }

  const SignatureIcon = selected.isFood ? UtensilsCrossed : Coffee;

  return (
    <section className="cb-customer-signature-hero" aria-labelledby="cb-start-here-heading">
      <div className="cb-customer-signature-photo">
        <CustomerProductImage
          src={selected.imageUrl}
          alt={selected.name}
          icon={SignatureIcon}
          iconClassName="text-[#9a6a2e]"
          className="h-full w-full"
          priority
        />
      </div>

      <div className="cb-customer-signature-content">
        <p className="cb-customer-signature-eyebrow">Start from here</p>
        <h2 id="cb-start-here-heading" className="cb-customer-signature-name">{selected.name}</h2>

        <div className="cb-customer-signature-options" aria-label="Coffee Bond signature drinks">
          {products.map(product => (
            <button
              key={product.code}
              type="button"
              onClick={() => setSelectedCode(product.code)}
              aria-pressed={product.code === selected.code}
              className="cb-customer-signature-option"
            >
              {product.name}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => onStart(selected.code)}
          disabled={!canOrder}
          aria-label={`Start with ${selected.name}`}
          className="cb-customer-signature-primary"
        >
          <span>Start with {selected.name}</span>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
        {!canOrder && unavailableMessage && (
          <p className="cb-customer-signature-message" role="status">{unavailableMessage}</p>
        )}
      </div>
    </section>
  );
}
