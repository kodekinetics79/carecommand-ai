import { useEffect, useState } from 'react';
import { apiHealth } from '../lib/api';

export function useBackendHealth() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => apiHealth()
      .then(ready => { if (active) setIsReady(ready); })
      .catch(() => { if (active) setIsReady(false); });
    refresh();
    const timer = window.setInterval(refresh, 30000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return isReady;
}
