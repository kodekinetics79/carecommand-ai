import { useEffect, useState } from 'react';
import { subscriptionApi } from '../lib/subscriptions';

// Loads the tenant's enabled feature keys (null while loading). Used for
// subscription-aware navigation locking. Backend still enforces access.
export function useEntitlements() {
  const [enabled, setEnabled] = useState<Set<string> | null>(null);
  useEffect(() => {
    let active = true;
    subscriptionApi.features()
      .then(rows => { if (active) setEnabled(new Set(rows.filter(r => r.enabled).map(r => r.featureKey))); })
      .catch(() => { if (active) setEnabled(new Set()); });
    return () => { active = false; };
  }, []);
  return enabled;
}
