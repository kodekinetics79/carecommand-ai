import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { timedOutFailure, type ResourceState } from '../../lib/resourceState';
import ResourceSection from './ResourceSection';

// What the render prop would print if a failed panel were ever allowed to
// reach it. Nothing in this string may appear on an error or loading state.
function TeamCount({ rows }: { rows: string[] }) {
  return <p>{rows.length} team members on duty</p>;
}

function renderSection(state: ResourceState<string[]>) {
  return render(
    <ResourceSection label="Team members" state={state} onRetry={vi.fn()}>
      {rows => <TeamCount rows={rows} />}
    </ResourceSection>,
  );
}

describe('ResourceSection', () => {
  it('shows only the failure on error — no count, no empty claim', () => {
    renderSection({ status: 'error', failure: timedOutFailure(15_000) });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Team members could not be loaded');
    expect(alert).toHaveTextContent('no figure here should be read as zero, empty or healthy');
    expect(screen.queryByText(/team members on duty/)).not.toBeInTheDocument();
    expect(screen.queryByText(/returned no records/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows only the shimmer while loading — no count, no empty claim', () => {
    renderSection({ status: 'loading' });

    expect(screen.getByText('Loading Team members…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/team members on duty/)).not.toBeInTheDocument();
    expect(screen.queryByText(/returned no records/)).not.toBeInTheDocument();
  });

  it('claims the workspace is empty only after a response carried no records', () => {
    renderSection({ status: 'ready', data: [], receivedAt: 1 });

    expect(screen.getByText('Team members loaded successfully and the workspace returned no records.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/team members on duty/)).not.toBeInTheDocument();
  });

  it('renders the received value when the response carried records', () => {
    renderSection({ status: 'ready', data: ['a-nurse', 'a-provider'], receivedAt: 1 });

    expect(screen.getByText('2 team members on duty')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/returned no records/)).not.toBeInTheDocument();
  });
});
