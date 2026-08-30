import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WeeklyHours } from '../../lib/receptionist';
import { sameWeeklyHours } from '../../lib/receptionistClinic';
import { HoursEditor } from './HoursEditor';

/**
 * M24, concretely: the old locations form held ONE start and ONE end time and
 * rebuilt the whole week from them on every save, so a clinic that opened
 * 09:00–13:00 on Saturday lost that the next time anyone edited anything.
 * The editor now round-trips the stored object: a change to one day must leave
 * the other six exactly as the server sent them.
 */
const STORED: WeeklyHours = {
  monday: { open: true, start: '09:00', end: '17:00' },
  tuesday: { open: true, start: '09:00', end: '17:00' },
  wednesday: { open: true, start: '09:00', end: '17:00' },
  thursday: { open: true, start: '09:00', end: '17:00' },
  friday: { open: true, start: '09:00', end: '17:00' },
  saturday: { open: true, start: '09:00', end: '13:00' },
  sunday: { open: false },
};

function Harness({ initial, onChange, inheritedFrom }: { initial: WeeklyHours | null; onChange: (next: WeeklyHours | null) => void; inheritedFrom?: WeeklyHours | null }) {
  const [value, setValue] = useState(initial);
  return (
    <HoursEditor
      label="Opening hours"
      value={value}
      inheritedFrom={inheritedFrom}
      timeStyle="12h"
      onChange={next => { setValue(next); onChange(next); }}
    />
  );
}

describe('HoursEditor', () => {
  it('renders every stored day, including a Saturday half-day', () => {
    render(<Harness initial={STORED} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Saturday opens at')).toHaveValue('09:00');
    expect(screen.getByLabelText('Saturday closes at')).toHaveValue('13:00');
    expect(screen.getByLabelText('Monday open')).toBeChecked();
    expect(screen.getByLabelText('Sunday open')).not.toBeChecked();
  });

  it('closing Friday leaves the other six days exactly as stored', () => {
    const onChange = vi.fn();
    render(<Harness initial={STORED} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('Friday open'));

    const next = onChange.mock.calls[0][0] as WeeklyHours;
    expect(next.friday).toEqual({ open: false });
    expect(next.saturday).toEqual({ open: true, start: '09:00', end: '13:00' });
    expect(next.monday).toEqual(STORED.monday);
    expect(Object.keys(next).sort()).toEqual(['friday', 'monday', 'saturday', 'sunday', 'thursday', 'tuesday', 'wednesday']);
  });

  it('editing one time keeps that day\'s other end', () => {
    const onChange = vi.fn();
    render(<Harness initial={STORED} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Saturday closes at'), { target: { value: '14:00' } });

    expect((onChange.mock.calls[0][0] as WeeklyHours).saturday).toEqual({ open: true, start: '09:00', end: '14:00' });
  });

  it('speaks each open day the way the agent will say it', () => {
    render(<Harness initial={STORED} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Saturday spoken as')).toHaveTextContent('Spoken: 9 AM to 1 PM');
    expect(screen.getByLabelText('Sunday spoken as')).toHaveTextContent('Closed');
  });

  it('names the consequence when no hours are configured at all', () => {
    render(<Harness initial={null} onChange={vi.fn()} />);
    expect(screen.getByText(/activation is blocked until hours exist/)).toBeInTheDocument();
  });

  it('copies Monday across the weekdays without touching the weekend', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ ...STORED, monday: { open: true, start: '08:00', end: '16:00' } }} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy Monday to weekdays' }));

    const next = onChange.mock.calls[0][0] as WeeklyHours;
    expect(next.tuesday).toEqual({ open: true, start: '08:00', end: '16:00' });
    expect(next.friday).toEqual({ open: true, start: '08:00', end: '16:00' });
    expect(next.saturday).toEqual(STORED.saturday);
    expect(next.sunday).toEqual({ open: false });
  });

  describe('inherit mode (a location)', () => {
    it('shows the clinic hours read-only and reports which mode is active', () => {
      render(<Harness initial={null} inheritedFrom={STORED} onChange={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Use clinic hours' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Custom hours' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByLabelText('Monday opens at')).toBeDisabled();
      expect(screen.getByLabelText('Monday opens at')).toHaveValue('09:00');
      expect(screen.getByText(/Showing the clinic hours this location inherits/)).toBeInTheDocument();
    });

    it('emits null when switching back to inheriting', () => {
      const onChange = vi.fn();
      render(<Harness initial={STORED} inheritedFrom={STORED} onChange={onChange} />);
      fireEvent.click(screen.getByRole('button', { name: 'Use clinic hours' }));
      expect(onChange).toHaveBeenCalledWith(null);
    });

    it('seeds custom hours from the clinic instead of an empty week', () => {
      const onChange = vi.fn();
      render(<Harness initial={null} inheritedFrom={STORED} onChange={onChange} />);
      fireEvent.click(screen.getByRole('button', { name: 'Custom hours' }));
      expect(onChange).toHaveBeenCalledWith(STORED);
    });
  });
});

describe('sameWeeklyHours', () => {
  it('ignores key order and closed-day representation', () => {
    expect(sameWeeklyHours(STORED, { ...STORED })).toBe(true);
    expect(sameWeeklyHours({ sunday: { open: false } }, {})).toBe(true);
    expect(sameWeeklyHours(null, null)).toBe(true);
  });

  it('sees a real difference, so the Save bar only lights up for one', () => {
    expect(sameWeeklyHours(STORED, { ...STORED, saturday: { open: false } })).toBe(false);
    expect(sameWeeklyHours(STORED, { ...STORED, monday: { open: true, start: '08:00', end: '17:00' } })).toBe(false);
    expect(sameWeeklyHours(null, STORED)).toBe(false);
  });
});
