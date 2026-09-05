import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClinicCreateForm from './ClinicCreateForm';
const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({ apiRequest: request }));

beforeEach(() => { request.mockReset(); });
function fill() {
  fireEvent.click(screen.getByRole('button', { name: 'Add clinic' }));
  fireEvent.change(screen.getByLabelText('Clinic name'), { target: { value: 'Bright Health — Irvine' } });
  fireEvent.change(screen.getByLabelText('Address or location'), { target: { value: 'Synthetic test location, Irvine' } });
  fireEvent.change(screen.getByLabelText('Clinic timezone'), { target: { value: 'America/Los_Angeles' } });
}
describe('clinic creation', () => {
  it('does not expose creation without owner/admin authority', () => {
    render(<ClinicCreateForm canCreate={false} onCreated={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
  it('creates one location with its explicit timezone and reports next steps', async () => {
    request.mockResolvedValue({ name: 'Bright Health — Irvine' });
    const created = vi.fn();
    render(<ClinicCreateForm canCreate onCreated={created} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create clinic' }));
    await waitFor(() => expect(created).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith('/v1/branches', { method: 'POST', body: JSON.stringify({ name: 'Bright Health — Irvine', location: 'Synthetic test location, Irvine', timezone: 'America/Los_Angeles' }) });
    expect(screen.getByRole('status')).toHaveTextContent('configure provider schedules');
  });
  it('blocks duplicate submissions while saving', async () => {
    let finish!: (value: unknown) => void;
    request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<ClinicCreateForm canCreate onCreated={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create clinic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Creating clinic…' }));
    expect(request).toHaveBeenCalledOnce();
    finish({ name: 'Bright Health — Irvine' });
    await screen.findByRole('status');
  });
  it('keeps entered details and exposes validation failure, not false success', async () => {
    request.mockRejectedValue(new Error('timezone must be a valid IANA timezone identifier'));
    render(<ClinicCreateForm canCreate onCreated={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create clinic' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('valid IANA timezone');
    expect(screen.getByLabelText('Clinic name')).toHaveValue('Bright Health — Irvine');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
