import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Copy, Check, Loader2, AlertCircle, Link2, BadgeCheck, Ban } from 'lucide-react';
import {
  paymentsApi, PAYMENT_STATUS_META,
  type AppointmentPaymentView, type GenerateLinkResult,
} from '../../lib/payments';

// Truthful appointment deposit/checkout card. Never shows a fake "paid" state;
// surfaces setup_required when the payment provider isn't configured.
export default function AppointmentPaymentCard({ appointmentId, currency = 'USD' }: { appointmentId: string; currency?: string }) {
  const [view, setView] = useState<AppointmentPaymentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await paymentsApi.getAppointmentPayment(appointmentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load payment status');
    } finally {
      setLoading(false);
    }
  }, [appointmentId]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const v = await paymentsApi.getAppointmentPayment(appointmentId);
        if (active) setView(v);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load payment status');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [appointmentId]);

  async function generateLink() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res: GenerateLinkResult = await paymentsApi.generatePaymentLink(appointmentId);
      if (res.status === 'setup_required') {
        setNotice(res.message);
      } else if (res.status === 'not_required') {
        setNotice(res.message);
      } else if (res.status === 'link_created') {
        setView(res.payment);
        setNotice(res.reused ? 'Existing payment link reused.' : `Payment link created${res.mode ? ` (${res.mode})` : ''}.`);
      } else {
        setError('Payment link could not be created.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate link');
    } finally {
      setBusy(false);
    }
  }

  async function evaluate() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await paymentsApi.evaluateDeposit(appointmentId);
      setView(res.payment);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to evaluate deposit');
    } finally {
      setBusy(false);
    }
  }

  async function waive() {
    if (!view?.depositRequirementId) return;
    const reason = window.prompt('Reason for waiving this deposit?');
    if (!reason) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await paymentsApi.waiveDeposit(view.depositRequirementId, reason);
      await load();
      setNotice('Deposit waived.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to waive deposit');
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!view?.paymentUrl) return;
    await navigator.clipboard.writeText(view.paymentUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading) return <div className="rounded-xl border border-[var(--b1)] p-3 text-xs text-t3"><Loader2 className="inline w-4 h-4 animate-spin" /> Loading payment status…</div>;
  if (error && !view) return <div className="rounded-xl border border-[var(--b1)] p-3 text-xs text-red-v">{error}</div>;
  if (!view) return null;

  const meta = PAYMENT_STATUS_META[view.status];
  const actions = view.allowedActions;
  const amountText = view.amount > 0 ? `${view.currency || currency} ${view.amount.toFixed(2)}` : null;

  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-indigo" />
          <span className="text-xs font-bold text-t1">Deposit & Checkout</span>
        </div>
        <span className={`badge ${meta.badge}`}>{meta.label}</span>
      </div>

      <div className="flex items-center gap-3 text-[11px] text-t3">
        {amountText && <span className="text-t2 font-semibold">{amountText}</span>}
        {view.dueAt && <span>Due {new Date(view.dueAt).toLocaleDateString()}</span>}
        {view.followUpNeeded && <span className="text-red-v font-semibold inline-flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Follow-up needed</span>}
      </div>

      {view.setupRequired && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-v/40 bg-amber-v/5 px-2.5 py-1.5 text-[11px] text-amber-v">
          <AlertCircle className="w-3.5 h-3.5" /> Payment provider not configured — set up Stripe to send live links.
        </div>
      )}
      {notice && <p className="text-[11px] text-t2">{notice}</p>}
      {error && <p className="text-[11px] text-red-v">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {view.status === 'not_required' && (
          <button type="button" disabled={busy} onClick={evaluate} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-50">
            <BadgeCheck className="w-3.5 h-3.5" /> Check deposit rules
          </button>
        )}
        {(actions.includes('generate_link') || actions.includes('resend_link')) && (
          <button type="button" disabled={busy} onClick={generateLink} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
            {actions.includes('resend_link') ? 'Resend link' : 'Generate payment link'}
          </button>
        )}
        {view.paymentUrl && (actions.includes('copy_link') || view.status === 'link_created') && (
          <button type="button" onClick={copyLink} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)]">
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-v" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy link'}
          </button>
        )}
        {actions.includes('waive') && (
          <button type="button" disabled={busy} onClick={waive} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t3 hover:bg-[var(--s3)] disabled:opacity-50">
            <Ban className="w-3.5 h-3.5" /> Waive
          </button>
        )}
      </div>
    </div>
  );
}
