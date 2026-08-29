import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import LegacyCampaignRedirect from './CampaignEngine';

/**
 * `/campaigner` and `/reactivation` were two doors onto the same `Campaign`
 * rows, read through two field families on two backends. They are one
 * destination now — but a bookmark, a shared link or a CTA that still names the
 * old path must land somewhere, and it must not arrive empty-handed: a goal the
 * user picked is not something a URL change is allowed to discard.
 */

function Destination() {
  const location = useLocation();
  return <pre data-testid="landed">{JSON.stringify(location.state)}</pre>;
}

function renderAt(pathname: string, state?: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname, state }]}>
      <Routes>
        <Route path="/campaigns" element={<Destination />} />
        <Route path="/campaigner" element={<LegacyCampaignRedirect />} />
        <Route path="/reactivation" element={<LegacyCampaignRedirect />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('retired campaign paths', () => {
  it.each(['/campaigner', '/reactivation'])('resolves %s to the campaign workspace', pathname => {
    renderAt(pathname);
    expect(screen.getByTestId('landed')).toBeInTheDocument();
  });

  it('carries the navigation payload across the redirect', () => {
    renderAt('/reactivation', { goal: 'winback', source: 'CRM' });
    expect(JSON.parse(screen.getByTestId('landed').textContent ?? 'null'))
      .toEqual({ goal: 'winback', source: 'CRM' });
  });
});
