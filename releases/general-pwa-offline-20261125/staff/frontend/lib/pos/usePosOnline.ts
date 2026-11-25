import { useEffect, useState } from 'react';
import { useConnectivity } from '../../contexts/ConnectivityContext';
import { functions, app } from '../firebase';
import { getMeta } from '../offline/journal';
import { browserIsOnline } from '../connectivity';

export function usePosOnline() {
  const { isOnline } = useConnectivity();
  const [reachable, setReachable] = useState(browserIsOnline);

  useEffect(() => {
    if (!isOnline) {
      setReachable(false);
      return;
    }

    let active = true;
    let checkedDeviceAt=0, checkBackend=false;
    const backendUrl = import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true'
      ? 'http://'+(import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_HOST || '127.0.0.1')+':'+(import.meta.env.VITE_FIREBASE_FUNCTIONS_EMULATOR_PORT || 5001)+'/'+app.options.projectId+'/'+functions.region+'/offlineCash'
      : 'https://'+functions.region+'-'+app.options.projectId+'.cloudfunctions.net/offlineCash';
    let request: AbortController | undefined;
    const probe = async () => {
      if (request) return;
      request = new AbortController();
      const timeout = window.setTimeout(() => request?.abort(), 3000);
      try {
        // HEAD bypasses the service worker cache and does not require sign-in.
        // A server-side outage and an unreachable endpoint both require offline handling.
        if(Date.now()-checkedDeviceAt>60000) {
          checkBackend=Boolean((await getMeta('device').catch(()=>null))?.privateKey);
          checkedDeviceAt=Date.now();
        }
        // HEAD cannot submit a callable action. Its response distinguishes an unavailable backend from a reachable one.
        const response=await fetch(checkBackend ? backendUrl : '/index.html', {method:'HEAD', cache:'no-store',signal:request.signal});
        if(response.status>=500)throw new TypeError('POS backend unavailable');
        if (active && browserIsOnline()) setReachable(true);
      } catch (error) {
        if (active && (error instanceof TypeError || (error as Error)?.name === 'AbortError')) {
          setReachable(false);
        }
      } finally {
        window.clearTimeout(timeout);
        request = undefined;
      }
    };
    void probe();
    const timer = window.setInterval(probe, 10000);
    return () => {
      active = false;
      window.clearInterval(timer);
      request?.abort();
    };
  }, [isOnline]);

  return isOnline && reachable;
}
