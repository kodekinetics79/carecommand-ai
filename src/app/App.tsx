import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/layout/Sidebar';
import Topbar from '../components/layout/Topbar';
import LazyBoundary from '../components/ui/LazyBoundary';
import { useSession } from '../hooks/useSession';
import { usePreferences } from '../lib/preferences';

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
const AutoTranslate = lazy(() => import('../components/AutoTranslate'));
const ClientDashboard = lazy(() => import('../pages/client/ClientSections').then(m => ({ default: m.ClientDashboard })));
const ClientAppointments = lazy(() => import('../pages/client/ClientSections').then(m => ({ default: m.ClientAppointments })));
const ClientRequests = lazy(() => import('../pages/client/ClientSections').then(m => ({ default: m.ClientRequests })));
const ClientIntake = lazy(() => import('../pages/client/ClientSections').then(m => ({ default: m.ClientIntake })));
const ClientInsurance = lazy(() => import('../pages/client/ClientSections').then(m => ({ default: m.ClientInsurance })));
const ClientPayments = lazy(() => import('../pages/client/ClientSections').then(m => ({ default: m.ClientPayments })));
const ClientProfile = lazy(() => import('../pages/client/ClientSections').then(m => ({ default: m.ClientProfile })));
const ClientPreferences = lazy(() => import('../pages/client/ClientSections').then(m => ({ default: m.ClientPreferences })));

const routeFallback = <div className="skeleton h-48 rounded-2xl" />;

function ProtectedLayout() {
  const { loading, isAuthenticated } = useSession();
  const location = useLocation();
  // Remount page content when currency/language changes so all formatted
  // figures (formatCurrency) re-render with the new preference immediately.
  const { currency, language } = usePreferences();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-t3">Loading session…</div>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <Topbar />
        <div className="app-scroll">
          <div className="app-inner">
            <LazyBoundary
              fallback={routeFallback}
              title="Module loading failed"
              description="The route chunk could not be loaded. Refresh the page to try again."
            >
              <div key={`${currency}-${language}`}><Outlet /></div>
            </LazyBoundary>
          </div>
        </div>
      </div>
    </div>
  );
}

function PublicRoute({ children }: { children: ReactNode }) {
  const { loading, isAuthenticated } = useSession();
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
    <LazyBoundary
      fallback={routeFallback}
      title="Admin module loading failed"
      description="The control-plane chunk could not be loaded. Refresh the page to try again."
    >
      <ControlPlane />
    </LazyBoundary>
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
    <LazyBoundary
      fallback={routeFallback}
      title="Compliance module loading failed"
      description="The compliance chunk could not be loaded. Refresh the page to try again."
    >
      <ComplianceCenter />
    </LazyBoundary>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      {/* Runtime auto-translation across login, staff app, and patient portal. */}
      <Suspense fallback={null}>
        <AutoTranslate />
      </Suspense>
      <Routes>
        <Route
          path="/login"
          element={
            <PublicRoute>
              <LazyBoundary
                fallback={routeFallback}
                title="Login module loading failed"
                description="The login chunk could not be loaded. Refresh the page to try again."
              >
                <Login />
              </LazyBoundary>
            </PublicRoute>
          }
        />
        {/* Patient-facing intake via tokenized link (no auth). */}
        <Route path="/intake/:token" element={<LazyBoundary fallback={routeFallback} title="Intake module loading failed" description="The intake chunk could not be loaded. Refresh the page to try again."><PublicIntake /></LazyBoundary>} />
        {/* Customer-facing pilot proof-of-concept view (hashed share token). */}
        <Route path="/pilot/:token" element={<LazyBoundary fallback={routeFallback} title="Pilot module loading failed" description="The pilot chunk could not be loaded. Refresh the page to try again."><PilotStatusShare /></LazyBoundary>} />
        {/* Platform Admin Console — separate PlatformUser identity (NOT tenant auth). */}
        <Route path="/platform/login" element={<LazyBoundary fallback={routeFallback} title="Platform login loading failed" description="The platform login chunk could not be loaded. Refresh the page to try again."><PlatformLogin /></LazyBoundary>} />
        <Route path="/platform" element={<LazyBoundary fallback={routeFallback} title="Platform console loading failed" description="The platform console chunk could not be loaded. Refresh the page to try again."><PlatformConsole /></LazyBoundary>} />
        {/* Patient / Client Portal — separate PatientPortalAccount identity (NOT staff auth). */}
        <Route path="/client/login" element={<LazyBoundary fallback={routeFallback} title="Client login loading failed" description="The client login chunk could not be loaded. Refresh the page to try again."><ClientLogin /></LazyBoundary>} />
        <Route path="/client" element={<LazyBoundary fallback={routeFallback} title="Client portal loading failed" description="The client portal chunk could not be loaded. Refresh the page to try again."><ClientLayout /></LazyBoundary>}>
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
