import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  patientAppointments, patientDashboard, patientRequestAppointment,
  staffAppointments, staffDashboard,
  type PatientAppointment, type PatientDashboard, type StaffAppointment, type StaffDashboard,
} from './api';
import { useAuth } from './session';
import { colors, radius, spacing } from './theme';
import {
  Brand, Button, Card, Field, Loading, Message, Metric, Pill, Screen,
  SectionTitle, Segmented, formatDateTime, formatMoney, ui,
} from './ui';

function toneForStatus(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'blue' {
  const normalized = status.toLowerCase();
  if (normalized.includes('complete') || normalized.includes('confirm') || normalized.includes('verified')) return 'success';
  if (normalized.includes('risk') || normalized.includes('pending') || normalized.includes('wait')) return 'warning';
  if (normalized.includes('cancel') || normalized.includes('no_show') || normalized.includes('required') || normalized.includes('fail')) return 'danger';
  return 'blue';
}

export function AppGate() {
  const { loading, session } = useAuth();
  if (loading) return <Loading />;
  if (!session) return <AuthScreen />;
  if (session.kind === 'patient') return <PatientHome />;
  return <StaffHome />;
}

function AuthScreen() {
  const { signInStaff, mfa, verifyMfa, requestPatientLink, verifyPatientToken, error, clearError } = useAuth();
  const [mode, setMode] = useState<'patient' | 'staff'>('patient');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [clinicSlug, setClinicSlug] = useState('');
  const [patientEmail, setPatientEmail] = useState('');
  const [patientPhone, setPatientPhone] = useState('');
  const [patientToken, setPatientToken] = useState('');
  const [staffEmail, setStaffEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [mfaCode, setMfaCode] = useState('');

  const ingestUrl = useCallback((url: string | null) => {
    if (!url) return;
    try {
      const parsed = new URL(url);
      const token = parsed.searchParams.get('token');
      if (token) {
        setMode('patient');
        setPatientToken(token);
        setNotice('Sign-in link detected. Tap Verify & continue.');
      }
    } catch {
      // Ignore unrelated deep links; users can still paste a token manually.
    }
  }, []);

  useEffect(() => {
    void Linking.getInitialURL().then(ingestUrl);
    const subscription = Linking.addEventListener('url', event => ingestUrl(event.url));
    return () => subscription.remove();
  }, [ingestUrl]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); clearError(); setNotice(null);
    try { await action(); } finally { setBusy(false); }
  };

  const requestLink = (signup: boolean) => run(async () => {
    const message = await requestPatientLink({
      clinicSlug: clinicSlug.trim(),
      email: patientEmail.trim() || undefined,
      phone: patientPhone.trim() || undefined,
    }, signup);
    setNotice(message);
  });

  if (mfa) {
    return <Screen>
      <Brand eyebrow="Secure staff sign-in" />
      <View style={ui.gapSm}>
        <Text style={ui.title}>{mfa.mode === 'setup' ? 'Protect your account' : 'Verify it’s you'}</Text>
        <Text style={ui.muted}>{mfa.mode === 'setup' ? 'Your workspace requires MFA. Add this secret to your authenticator, then enter the current code.' : 'Enter the current code from your authenticator app.'}</Text>
      </View>
      {mfa.mode === 'setup' && mfa.secret ? <Card>
        <Text style={styles.kicker}>AUTHENTICATOR SECRET</Text>
        <Text selectable style={styles.secret}>{mfa.secret}</Text>
        <Text style={ui.muted}>Keep this secret private. CareCommand will never ask you to send it by email or chat.</Text>
      </Card> : null}
      <Field label="6-digit code" value={mfaCode} onChangeText={setMfaCode} keyboardType="number-pad" placeholder="000000" />
      {error ? <Message text={error} error /> : null}
      <Button title="Verify & continue" busy={busy} disabled={mfaCode.trim().length < 6} onPress={() => run(() => verifyMfa(mfaCode))} />
    </Screen>;
  }

  return <Screen>
    <Brand eyebrow="Mobile care workspace" />
    <View style={ui.gapSm}>
      <Text style={ui.title}>Care, wherever you are.</Text>
      <Text style={ui.muted}>One secure app. A simple patient experience up front; the operational command center for clinic teams behind it.</Text>
    </View>
    <Segmented value={mode} onChange={value => { setMode(value as 'patient' | 'staff'); clearError(); setNotice(null); }} options={[
      { value: 'patient', label: 'Patient / User' }, { value: 'staff', label: 'Staff / Owner' },
    ]} />

    {mode === 'patient' ? <View style={ui.gapMd}>
      <SectionTitle title="Sign in to your clinic" subtitle="We use a one-time secure link instead of asking you to remember another password." />
      <Field label="Clinic code" value={clinicSlug} onChangeText={setClinicSlug} placeholder="bright-health" />
      <Field label="Email" value={patientEmail} onChangeText={setPatientEmail} keyboardType="email-address" placeholder="you@example.com" />
      <Field label="Phone (optional)" value={patientPhone} onChangeText={setPatientPhone} keyboardType="phone-pad" placeholder="+1 555 555 5555" />
      <Button title="Send secure sign-in link" busy={busy} disabled={!clinicSlug.trim() || (!patientEmail.trim() && !patientPhone.trim())} onPress={() => requestLink(false)} />
      <Button title="New here? Request access" variant="secondary" disabled={!clinicSlug.trim() || (!patientEmail.trim() && !patientPhone.trim())} onPress={() => requestLink(true)} />
      {notice ? <Message text={notice} /> : null}
      {error ? <Message text={error} error /> : null}
      <Card style={ui.gapSm}>
        <Text style={ui.h2}>Have a sign-in token?</Text>
        <Text style={ui.muted}>Opening a CareCommand mobile link fills this automatically. You can also paste the token from your sign-in link.</Text>
        <Field label="One-time token" value={patientToken} onChangeText={setPatientToken} placeholder="Paste token" />
        <Button title="Verify & continue" variant="secondary" busy={busy} disabled={patientToken.trim().length < 10} onPress={() => run(() => verifyPatientToken(patientToken))} />
      </Card>
    </View> : <View style={ui.gapMd}>
      <SectionTitle title="Team sign in" subtitle="Staff, clinicians, managers and owners use the same tenant-scoped account and permissions as the web app." />
      <Field label="Work email" value={staffEmail} onChangeText={setStaffEmail} keyboardType="email-address" placeholder="name@clinic.com" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry placeholder="Password" />
      <Field label="Workspace code (if you belong to more than one)" value={tenantSlug} onChangeText={setTenantSlug} placeholder="bright-health" />
      {error ? <Message text={error} error /> : null}
      <Button title="Sign in securely" busy={busy} disabled={!staffEmail.trim() || !password} onPress={() => run(() => signInStaff({ email: staffEmail.trim(), password, tenantSlug: tenantSlug.trim() || undefined }))} />
      <Text style={styles.securityNote}>MFA, tenant isolation, clinic scope and server-side permissions remain enforced. Mobile does not bypass the web application’s security model.</Text>
    </View>}
  </Screen>;
}

function PatientHome() {
  const { session, signOut } = useAuth();
  const [tab, setTab] = useState<'home' | 'appointments'>('home');
  const [dashboard, setDashboard] = useState<PatientDashboard | null>(null);
  const [appointments, setAppointments] = useState<{ upcoming: PatientAppointment[]; past: PatientAppointment[] }>({ upcoming: [], past: [] });
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [service, setService] = useState('');
  const [notes, setNotes] = useState('');
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestNotice, setRequestNotice] = useState<string | null>(null);

  const token = session?.kind === 'patient' ? session.token : null;
  const load = useCallback(async () => {
    if (!token) return;
    setRefreshing(true); setError(null);
    try {
      const [d, a] = await Promise.all([patientDashboard(token), patientAppointments(token)]);
      setDashboard(d); setAppointments(a);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load your care information.'); }
    finally { setRefreshing(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  if (!session || session.kind !== 'patient') return <Loading />;

  const submitRequest = async () => {
    if (!service.trim()) return;
    setRequestBusy(true); setRequestNotice(null);
    try {
      const result = await patientRequestAppointment(session.token, { service: service.trim(), notes: notes.trim() || undefined });
      setRequestNotice(result.deduped ? 'You already have this request under review.' : 'Request sent. Your clinic can now review and schedule it.');
      setService(''); setNotes(''); await load();
    } catch (e) { setRequestNotice(e instanceof Error ? e.message : 'Could not send your request.'); }
    finally { setRequestBusy(false); }
  };

  return <Screen refreshing={refreshing} onRefresh={load}>
    <View style={ui.rowBetween}>
      <Brand eyebrow={dashboard?.clinicName ?? session.clinicName} />
      <Pressable onPress={() => void signOut()}><Text style={styles.link}>Sign out</Text></Pressable>
    </View>
    <View style={ui.gapSm}>
      <Text style={ui.title}>Hi, {dashboard?.displayName?.split(' ')[0] || session.displayName}.</Text>
      <Text style={ui.muted}>{dashboard?.branchName ? `${dashboard.branchName} • ` : ''}Everything you need for your next visit, without calling the front desk.</Text>
    </View>
    <Segmented value={tab} onChange={value => setTab(value as 'home' | 'appointments')} options={[{ value: 'home', label: 'Home' }, { value: 'appointments', label: 'Appointments' }]} />
    {error ? <Message text={error} error /> : null}

    {tab === 'home' ? <>
      <Card style={styles.heroCard}>
        <View style={ui.rowBetween}>
          <View style={ui.flex}>
            <Text style={styles.kicker}>NEXT APPOINTMENT</Text>
            <Text style={styles.heroTitle}>{dashboard?.cards.nextAppointment.service ?? 'No visit scheduled'}</Text>
            <Text style={ui.muted}>{formatDateTime(dashboard?.cards.nextAppointment.startsAt)}</Text>
          </View>
          <Pill text={dashboard?.cards.nextAppointment.state ?? 'unavailable'} tone={toneForStatus(dashboard?.cards.nextAppointment.state ?? '')} />
        </View>
      </Card>

      <SectionTitle title="Your care checklist" subtitle="Only items that need your attention are highlighted." />
      <View style={styles.grid}>
        <PatientTask title="Intake" state={dashboard?.cards.intake.state ?? 'unavailable'} />
        <PatientTask title="Insurance" state={dashboard?.cards.insurance.state ?? 'unavailable'} detail={dashboard?.cards.insurance.detail} />
        <PatientTask title="Payments" state={dashboard?.cards.payment.state ?? 'unavailable'} detail={dashboard?.cards.payment.amount ? `${dashboard.cards.payment.currency ?? 'USD'} ${dashboard.cards.payment.amount}` : undefined} />
        <PatientTask title="Estimate" state={dashboard?.cards.estimate.state ?? 'unavailable'} />
      </View>

      <Button title={requestOpen ? 'Close appointment request' : 'Request an appointment'} onPress={() => { setRequestOpen(v => !v); setRequestNotice(null); }} />
      {requestOpen ? <Card style={ui.gapMd}>
        <SectionTitle title="Tell us what you need" subtitle="This sends a real request to your clinic for review. It does not create a fake appointment." />
        <Field label="Service or reason" value={service} onChangeText={setService} autoCapitalize="sentences" placeholder="Annual physical, follow-up…" />
        <Field label="Notes (optional)" value={notes} onChangeText={setNotes} autoCapitalize="sentences" placeholder="Anything the scheduling team should know" multiline />
        {requestNotice ? <Message text={requestNotice} /> : null}
        <Button title="Send request" busy={requestBusy} disabled={!service.trim()} onPress={() => void submitRequest()} />
      </Card> : null}
    </> : <AppointmentList title="Upcoming" rows={appointments.upcoming} empty="You have no upcoming appointments." />}
  </Screen>;
}

function PatientTask({ title, state, detail }: { title: string; state: string; detail?: string }) {
  return <Card style={styles.taskCard}>
    <Text style={styles.taskTitle}>{title}</Text>
    <Pill text={state} tone={toneForStatus(state)} />
    {detail ? <Text style={styles.taskDetail}>{detail.replaceAll('_', ' ')}</Text> : null}
  </Card>;
}

function AppointmentList({ title, rows, empty }: { title: string; rows: PatientAppointment[]; empty: string }) {
  return <View style={ui.gapMd}>
    <SectionTitle title={title} subtitle={`${rows.length} appointment${rows.length === 1 ? '' : 's'}`} />
    {rows.length === 0 ? <Card><Text style={ui.muted}>{empty}</Text></Card> : rows.map(row => <Card key={row.id} style={ui.gapSm}>
      <View style={ui.rowBetween}><Text style={ui.h2}>{row.service}</Text><Pill text={row.status} tone={toneForStatus(row.status)} /></View>
      <Text style={ui.body}>{formatDateTime(row.startsAt)}</Text>
      <Text style={ui.muted}>{[row.providerName, row.branchName].filter(Boolean).join(' • ') || 'Your clinic'}</Text>
    </Card>)}
  </View>;
}

function StaffHome() {
  const { session, signOut } = useAuth();
  const [tab, setTab] = useState<'command' | 'schedule'>('command');
  const [summary, setSummary] = useState<StaffDashboard | null>(null);
  const [appointments, setAppointments] = useState<StaffAppointment[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const staff = session?.kind === 'staff' ? session : null;
  const clinicId = staff?.user.branchId ?? null;
  const ownerMode = staff ? ['OWNER', 'ADMIN'].includes(staff.user.role) : false;

  const load = useCallback(async () => {
    if (!staff) return;
    setRefreshing(true); setError(null);
    try {
      const [d, a] = await Promise.all([staffDashboard(staff.token, clinicId), staffAppointments(staff.token, clinicId)]);
      setSummary(d); setAppointments(a.data);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load the clinic workspace.'); }
    finally { setRefreshing(false); }
  }, [staff?.token, clinicId]);

  useEffect(() => { void load(); }, [load]);
  if (!staff) return <Loading />;

  return <Screen refreshing={refreshing} onRefresh={load}>
    <View style={ui.rowBetween}>
      <Brand eyebrow={staff.user.tenant.name} />
      <Pressable onPress={() => void signOut()}><Text style={styles.link}>Sign out</Text></Pressable>
    </View>
    <View style={ui.gapSm}>
      <View style={ui.row}><Text style={ui.title}>{ownerMode ? 'Command center' : 'Today’s clinic'}</Text><Pill text={staff.user.role} tone={ownerMode ? 'blue' : 'neutral'} /></View>
      <Text style={ui.muted}>{staff.user.displayName}{staff.user.branch?.name ? ` • ${staff.user.branch.name}` : ' • Network-wide view'}</Text>
    </View>
    <Segmented value={tab} onChange={value => setTab(value as 'command' | 'schedule')} options={[{ value: 'command', label: ownerMode ? 'Command' : 'Workspace' }, { value: 'schedule', label: 'Schedule' }]} />
    {error ? <Message text={error} error /> : null}

    {tab === 'command' ? <>
      <View style={styles.metrics}>
        <Metric label="Appointments today" value={summary?.todaysAppointments ?? '—'} />
        <Metric label="No-show risk" value={summary?.noShowRisk ?? '—'} hint={(summary?.noShowRisk ?? 0) > 0 ? 'Needs attention' : undefined} />
        <Metric label="Missed calls" value={summary?.missedCalls ?? '—'} />
        <Metric label="Pending approvals" value={summary?.pendingApprovals ?? '—'} />
        {ownerMode ? <Metric label="Network revenue" value={summary ? formatMoney(summary.networkRevenue) : '—'} /> : null}
        {ownerMode ? <Metric label="Active opportunity" value={summary ? formatMoney(summary.activeOpportunities) : '—'} /> : null}
      </View>

      <SectionTitle title="What needs attention" subtitle="Operational signals from the same backend as the web command center." />
      <Card style={ui.gapMd}>
        <Signal label="Patients at no-show risk" value={summary?.noShowRisk ?? 0} danger={(summary?.noShowRisk ?? 0) > 0} />
        <Signal label="Missed calls awaiting action" value={summary?.missedCalls ?? 0} danger={(summary?.missedCalls ?? 0) > 0} />
        <Signal label="AI actions awaiting approval" value={summary?.pendingApprovals ?? 0} danger={(summary?.pendingApprovals ?? 0) > 0} />
        <Signal label="Recovered call conversations" value={summary?.callsRecovered ?? 0} />
      </Card>

      {ownerMode ? <Card style={ui.gapSm}>
        <Text style={styles.kicker}>OWNER VIEW</Text>
        <Text style={styles.heroTitle}>{summary ? formatMoney(summary.revenueRecovered) : '—'}</Text>
        <Text style={ui.muted}>Revenue recovered in the latest network snapshot. This is backend-reported data, not a mobile estimate.</Text>
      </Card> : null}
    </> : <View style={ui.gapMd}>
      <SectionTitle title="Today’s schedule" subtitle={`${appointments.length} appointment${appointments.length === 1 ? '' : 's'} in your current scope`} />
      {appointments.length === 0 ? <Card><Text style={ui.muted}>No appointments are scheduled in this scope today.</Text></Card> : appointments.map(appointment => <Card key={appointment.id} style={ui.gapSm}>
        <View style={ui.rowBetween}><Text style={ui.h2}>{formatDateTime(appointment.startsAt)}</Text><Pill text={appointment.status} tone={toneForStatus(appointment.status)} /></View>
        <Text style={ui.body}>{appointment.patientName}</Text>
        <Text style={ui.muted}>{appointment.service}{appointment.providerName ? ` • ${appointment.providerName}` : ''}</Text>
      </Card>)}
    </View>}
  </Screen>;
}

function Signal({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return <View style={ui.rowBetween}>
    <Text style={ui.body}>{label}</Text>
    <Pill text={String(value)} tone={danger ? 'warning' : value > 0 ? 'blue' : 'success'} />
  </View>;
}

const styles = StyleSheet.create({
  link: { color: colors.primary, fontWeight: '800', padding: spacing.sm },
  securityNote: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', paddingHorizontal: spacing.md },
  kicker: { color: colors.primary, fontWeight: '900', fontSize: 11, letterSpacing: 1.2 },
  secret: { color: colors.text, fontWeight: '800', fontSize: 17, letterSpacing: 1, marginVertical: spacing.sm },
  heroCard: { paddingVertical: spacing.lg }, heroTitle: { color: colors.text, fontSize: 23, fontWeight: '900', marginVertical: spacing.xs },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  taskCard: { width: '48%', minHeight: 128, gap: spacing.sm }, taskTitle: { color: colors.text, fontSize: 16, fontWeight: '800' }, taskDetail: { color: colors.muted, fontSize: 11, textTransform: 'capitalize' },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
