import { useEffect, useState } from 'react';
import { onSnapshot } from 'firebase/firestore';
import { useParams } from 'react-router-dom';
import CustomerTrackingScreen, {
  TrackingScreenState,
} from '../../components/customer/CustomerTrackingScreen';
import { PublicOrderTracking } from '../../types';
import { CustomerProfile, restoreCustomerProfile } from '../../lib/customerAuth';
import { rememberCustomerOrder } from '../../lib/customerOrderPersistence';
import { publicTrackingDocRef } from '../../lib/publicOrderTracking';
import { CUSTOMER_HOME_PATH, customerTrackingUrl } from '../../lib/customerRoutes';

/**
 * Order tracking — data only.
 *
 * The live subscription is untouched: the same onSnapshot on the same public tracking
 * document, keyed on the same token. Layout lives in CustomerTrackingScreen so the
 * screen can be rendered and measured in every status without a live order.
 */
export default function CustomerOrderStatus() {
  const { onlineOrderId: trackingToken } = useParams();
  const [order, setOrder] = useState<PublicOrderTracking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [authRestored, setAuthRestored] = useState(false);

  useEffect(() => {
    let active = true;
    restoreCustomerProfile().then(restoredProfile => {
      if (active) setProfile(restoredProfile);
    }).catch(() => {
      // Tracking remains available even if the optional account session cannot be restored.
    }).finally(() => {
      if (active) setAuthRestored(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!trackingToken) {
      setError('Missing order reference.');
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    setError(null);
    rememberCustomerOrder(trackingToken);
    const unsubscribe = onSnapshot(
      publicTrackingDocRef(trackingToken),
      (snapshot) => {
        if (!snapshot.exists()) {
          setOrder(null);
          setError('We could not find this order reference.');
        } else {
          setOrder({ id: snapshot.id, ...snapshot.data() } as PublicOrderTracking);
          setError(null);
        }
        setLoading(false);
      },
      (err) => {
        console.error('Failed to listen to order status', err);
        setError('We could not load this order status. Please check the reference and try again.');
        setLoading(false);
      },
    );

    return unsubscribe;
  }, [trackingToken]);

  const copyTrackingLink = async () => {
    if (!trackingToken) return;
    const trackingUrl = customerTrackingUrl(trackingToken);
    try {
      await navigator.clipboard.writeText(trackingUrl);
      setCopyMessage('Tracking link copied.');
    } catch {
      setCopyMessage(trackingUrl);
    }
  };

  const state: TrackingScreenState = loading
    ? { kind: 'loading' }
    : error
      ? { kind: 'error', message: error }
      : order
        ? { kind: 'ready', order }
        : { kind: 'error', message: 'We could not find this order reference.' };

  return (
    <CustomerTrackingScreen
      state={state}
      profile={profile}
      authRestored={authRestored}
      copyMessage={copyMessage}
      onCopyTrackingLink={copyTrackingLink}
      onProfileUpdated={setProfile}
      onSignedOut={() => setProfile(null)}
      onOpenMyUsual={() => { window.location.assign(CUSTOMER_HOME_PATH); }}
    />
  );
}
