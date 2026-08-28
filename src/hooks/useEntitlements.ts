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
      // Fail OPEN. An empty Set is indistinguishable from "this tenant owns
      // nothing", so a single transient GET failure locked ~15 nav items and
      // pointed a paying clinic owner at /subscription to buy back features
      // they already have. `null` means "unknown"; Sidebar treats it as
      // unlocked and the server remains the enforcement point — every gated
      // endpoint checks entitlements itself.
      .catch(() => { if (active) setEnabled(null); });
    return () => { active = false; };
  }, []);
  return enabled;
}
