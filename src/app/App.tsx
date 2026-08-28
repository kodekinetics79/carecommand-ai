import { lazy, Suspense, useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router';
import Sidebar from '../components/layout/Sidebar';
import Topbar from '../components/layout/Topbar';
import { useSession } from '../hooks/useSession';
import { usePreferences } from '../lib/preferences';
import AutoTranslate from '../components/AutoTranslate';
import {
  ClientDashboard, ClientAppointments, ClientRequests, ClientIntake,
  ClientInsurance, ClientPayments, ClientProfile, ClientPreferences,
} from '../pages/client/ClientSections';

const Login = lazy(() => import('../pages/Login'));
const Dashboard = lazy(() => import('../pages/Dashboard'));
const AdvisoryRoom = lazy(() => import('../pages/AdvisoryRoom'));
const ClinicRadar = lazy(() => import('../pages/ClinicRadar'));
const Autopilot = lazy(() => import('../pages/Autopilot'));
const CRM = lazy(() => import('../pages/CRM'));
const AIReceptionist = lazy(() => import('../pages/AIReceptionist'));
const ReceptionistStudio = lazy(() => import('../pages/ReceptionistStudio'));
const Scheduling = lazy(() => import('../pages/Scheduling'));
const Patients = lazy(() => import('../pages/Patients'));
const PatientProfile = lazy(() => import('../pages/PatientProfile'));
const Campaigner = lazy(() => import('../pages/Campaigner'));
const CampaignEngine = lazy(() => import('../pages/CampaignEngine'));
const IntakeQueue = lazy(() => import('../pages/IntakeQueue'));
const PublicIntake = lazy(() => import('../pages/PublicIntake'));
const Revenue = lazy(() => import('../pages/Revenue'));
const RevenueProtection = lazy(() => import('../pages/RevenueProtection'));
const Insurance = lazy(() => import('../pages/Insurance'));
const OpportunityCenter = lazy(() => import('../pages/OpportunityCenter'));
const DoctorWorkspace = lazy(() => import('../pages/DoctorWorkspace'));
const StaffWorkflow = lazy(() => import('../pages/StaffWorkflow'));
const Reviews = lazy(() => import('../pages/Reviews'));
const Inventory = lazy(() => import('../pages/Inventory'));
const Labs = lazy(() => import('../pages/Labs'));
const Telehealth = lazy(() => import('../pages/Telehealth'));
const ComplianceCenter = lazy(() => import('../pages/ComplianceCenter'));
const Integrations = lazy(() => import('../pages/Integrations'));
const DeviceIntegration = lazy(() => import('../pages/DeviceIntegration'));
const RemoteMonitoring = lazy(() => import('../pages/RemoteMonitoring'));
const IntegrationSetup = lazy(() => import('../pages/IntegrationSetup'));
const InsuranceEligibility = lazy(() => import('../pages/InsuranceEligibility'));
const PatientEnrollments = lazy(() => import('../pages/PatientEnrollments'));
const DeviceSyncLogs = lazy(() => import('../pages/DeviceSyncLogs'));
const RpmBillingReadiness = lazy(() => import('../pages/RpmBillingReadiness'));
const Subscription = lazy(() => import('../pages/Subscription'));
const Platform = lazy(() => import('../pages/Platform'));
const PlatformLogin = lazy(() => import('../pages/PlatformLogin'));
const PlatformConsole = lazy(() => import('../pages/PlatformConsole'));
const PilotStatusShare = lazy(() => import('../pages/PilotStatusShare'));
const ClientLogin = lazy(() => import('../pages/client/ClientLogin'));
const ClientLayout = lazy(() => import('../pages/client/ClientLayout'));
const Settings = lazy(() => import('../pages/Settings'));
const ControlPlane = lazy(() => import('../pages/ControlPlane'));

function ProtectedLayout() {
  const { loading, isAuthenticated } = useSession();
  const location = useLocation();
  // Remount page content when currency/language changes so all formatted
  // figures (formatCurrency) re-render with the new preference immediately.
  const { currency, language } = usePreferences();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-t3">Loading session…</div>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return (
    <div className="app-shell">
      <Sidebar mobileOpen={mobileNavOpen} onNavigate={() => setMobileNavOpen(false)} />
      {mobileNavOpen && (
        <button type="button" className="mobile-nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />
      )}
      <div className="app-main">
        <Topbar mobileNavOpen={mobileNavOpen} onOpenNavigation={() => setMobileNavOpen(true)} />
        <main className="app-scroll" aria-label="Clinic workspace">
          <div className="app-inner">
            {/* Keyed by pathname so each route mounts its own Suspense boundary.
                Every page is React.lazy and react-router dispatches navigation
                inside startTransition, so a single already-mounted boundary keeps
                the PREVIOUS route rendered while the next chunk loads — the URL
                advances but breadcrumb, sidebar highlight and body all lag one
                navigation behind, with no loading feedback. Keying forces the
                fallback to show and the shell to track the current route. */}
            <Suspense key={location.pathname} fallback={<div className="skeleton h-48 rounded-2xl" />}>
              <div key={`${currency}-${language}`}><Outlet /></div>
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}

function PublicRoute({ children }: { children: ReactNode }) {
  const { loading, isAuthenticated } = useSession({ hydrate: false });
  const location = useLocation();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-t3">Loading session…</div>;
  }

  if (isAuthenticated) {
    const destination = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={destination} replace />;
  }

  return <>{children}</>;
}

function AdminRoute() {
  const { loading, isAuthenticated, user } = useSession();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-t3">Loading session…</div>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (!user || !['OWNER', 'ADMIN'].includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return (
    <Suspense fallback={<div className="skeleton h-48 rounded-2xl" />}>
      <ControlPlane />
    </Suspense>
  );
}

function ComplianceRoute() {
  const { loading, isAuthenticated, user } = useSession();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-t3">Loading session…</div>;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  if (!user || !['OWNER', 'ADMIN', 'COMPLIANCE_OFFICER', 'AUDITOR'].includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return (
    <Suspense fallback={<div className="skeleton h-48 rounded-2xl" />}>
      <ComplianceCenter />
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      {/* Runtime auto-translation across login, staff app, and patient portal. */}
      <AutoTranslate />
      <Routes>
        <Route
          path="/login"
          element={
            <PublicRoute>
              <Suspense fallback={<div className="skeleton h-48 rounded-2xl" />}>
                <Login />
              </Suspense>
            </PublicRoute>
          }
        />
        {/* Patient-facing intake via tokenized link (no auth). */}
        <Route path="/intake/:token" element={<Suspense fallback={<div className="skeleton h-48 rounded-2xl" />}><PublicIntake /></Suspense>} />
        {/* Customer-facing pilot proof-of-concept view (hashed share token). */}
        <Route path="/pilot/:token" element={<Suspense fallback={<div className="skeleton h-48 rounded-2xl" />}><PilotStatusShare /></Suspense>} />
        {/* Platform Admin Console — separate PlatformUser identity (NOT tenant auth). */}
        <Route path="/platform/login" element={<Suspense fallback={<div className="skeleton h-48 rounded-2xl" />}><PlatformLogin /></Suspense>} />
        <Route path="/platform" element={<Suspense fallback={<div className="skeleton h-48 rounded-2xl" />}><PlatformConsole /></Suspense>} />
        {/* Patient / Client Portal — separate PatientPortalAccount identity (NOT staff auth). */}
        <Route path="/client/login" element={<Suspense fallback={<div className="skeleton h-48 rounded-2xl" />}><ClientLogin /></Suspense>} />
        <Route path="/client" element={<Suspense fallback={<div className="skeleton h-48 rounded-2xl" />}><ClientLayout /></Suspense>}>
          <Route index element={<ClientDashboard />} />
          <Route path="appointments" element={<ClientAppointments />} />
          <Route path="requests" element={<ClientRequests />} />
          <Route path="intake" element={<ClientIntake />} />
          <Route path="insurance" element={<ClientInsurance />} />
          <Route path="payments" element={<ClientPayments />} />
          <Route path="profile" element={<ClientProfile />} />
          <Route path="preferences" element={<ClientPreferences />} />
        </Route>
        <Route element={<ProtectedLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/patient-intake" element={<IntakeQueue />} />
          <Route path="/advisory" element={<AdvisoryRoom />} />
          <Route path="/clinic-radar" element={<ClinicRadar />} />
          <Route path="/benchmarking" element={<ClinicRadar />} />
          <Route path="/autopilot" element={<Autopilot />} />
          <Route path="/crm" element={<CRM />} />
          <Route path="/ai-receptionist" element={<AIReceptionist />} />
          <Route path="/receptionist-studio" element={<ReceptionistStudio />} />
          <Route path="/scheduling" element={<Scheduling />} />
          <Route path="/patients" element={<Patients />} />
          <Route path="/patients/:id" element={<PatientProfile />} />
          <Route path="/campaigner" element={<Campaigner />} />
          <Route path="/reactivation" element={<CampaignEngine />} />
          <Route path="/revenue" element={<Revenue />} />
          <Route path="/revenue-protection" element={<RevenueProtection />} />
          <Route path="/insurance" element={<Insurance />} />
          <Route path="/opportunities" element={<OpportunityCenter />} />
          <Route path="/doctor-workspace" element={<DoctorWorkspace />} />
          <Route path="/staff" element={<StaffWorkflow />} />
          <Route path="/reviews" element={<Reviews />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/labs" element={<Labs />} />
          <Route path="/telehealth" element={<Telehealth />} />
          <Route path="/compliance" element={<ComplianceRoute />} />
          <Route path="/compliance/:section" element={<ComplianceRoute />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/devices" element={<DeviceIntegration />} />
          <Route path="/monitoring" element={<RemoteMonitoring />} />
          <Route path="/integration-setup" element={<IntegrationSetup />} />
          <Route path="/insurance-eligibility" element={<InsuranceEligibility />} />
          <Route path="/enrollments" element={<PatientEnrollments />} />
          <Route path="/sync-logs" element={<DeviceSyncLogs />} />
          <Route path="/rpm-readiness" element={<RpmBillingReadiness />} />
          <Route path="/subscription" element={<Subscription />} />
          {/* Operator-only console — gated by a platform token, not a tenant role; not in the sidebar. */}
          <Route path="/platform-legacy" element={<Platform />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/control-plane" element={<AdminRoute />} />
          <Route path="/admin" element={<AdminRoute />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
