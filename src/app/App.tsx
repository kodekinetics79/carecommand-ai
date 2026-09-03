import { lazy, Suspense, useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router';
import Sidebar from '../components/layout/Sidebar';
import Topbar from '../components/layout/Topbar';
import AccessRestricted from '../components/ui/AccessRestricted';
import { useSession } from '../hooks/useSession';
import { matchRoute, hasRouteAccess } from '../lib/access';
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
const AIWorkforce = lazy(() => import('../pages/AIWorkforce'));
const FrontDesk = lazy(() => import('../pages/FrontDesk'));
const ReceptionistStudio = lazy(() => import('../pages/ReceptionistStudio'));
const Scheduling = lazy(() => import('../pages/Scheduling'));
const Patients = lazy(() => import('../pages/Patients'));
const PatientProfile = lazy(() => import('../pages/PatientProfile'));
const Campaigns = lazy(() => import('../pages/Campaigner'));
// /campaigner and /reactivation were consolidated into /campaigns; this keeps
// both old paths resolvable and carries their navigation state across.
const LegacyCampaignRedirect = lazy(() => import('../pages/CampaignEngine'));
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
const DeviceIntegration = lazy(() => import('../pages/DeviceIntegration'));
const RemoteMonitoring = lazy(() => import('../pages/RemoteMonitoring'));
const InsuranceEligibility = lazy(() => import('../pages/InsuranceEligibility'));
const PatientEnrollments = lazy(() => import('../pages/PatientEnrollments'));
const DeviceSyncLogs = lazy(() => import('../pages/DeviceSyncLogs'));
const MonitoringThresholds = lazy(() => import('../pages/MonitoringThresholds'));
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
  const { loading, isAuthenticated, user } = useSession();
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

  // Arrival at a section this account's role does not cover — a bookmark, a
  // shared link, a tab left open across a role change. One honest state instead
  // of a page that loads and then fills with the API's permission text. The
  // server check is untouched; this only stops the page from being drawn.
  const destination = matchRoute(location.pathname);
  const permitted = hasRouteAccess(user, destination.route);

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
              <div key={`${currency}-${language}`}>
                {permitted
                  ? <Outlet />
                  : <AccessRestricted section={destination.route.label} role={user?.role} workspace={user?.tenant?.name} />}
              </div>
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
          <Route path="/front-desk" element={<FrontDesk />} />
          <Route path="/ai-receptionist" element={<AIReceptionist />} />
          <Route path="/receptionist-studio" element={<ReceptionistStudio />} />
          {/* Workforce inherits the Studio's receptionist:manage access declaration
              through the segment-aware route registry. It orchestrates the same
              scheduler, intake, task and outbound records rather than creating a
              second AI-specific data plane. */}
          <Route path="/receptionist-studio/workforce" element={<AIWorkforce />} />
          <Route path="/scheduling" element={<Scheduling />} />
          <Route path="/patients" element={<Patients />} />
          <Route path="/patients/:id" element={<PatientProfile />} />
          <Route path="/campaigns" element={<Campaigns />} />
          {/* Retired campaign paths — one destination now, two old links. */}
          <Route path="/campaigner" element={<LegacyCampaignRedirect />} />
          <Route path="/reactivation" element={<LegacyCampaignRedirect />} />
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
          <Route path="/compliance" element={<ComplianceCenter />} />
          <Route path="/compliance/:section" element={<ComplianceCenter />} />
          {/* /integrations and /integration-setup are gone. A clinic contracted
              for a working product, not a console of the services we buy: the
              provider catalogue, its credential fields and its Test-connection
              buttons live in the Platform Console now. Both paths fall through
              to the catch-all redirect below, so an old bookmark lands on the
              Command Center rather than a blank screen. */}
          <Route path="/devices" element={<DeviceIntegration />} />
          <Route path="/monitoring" element={<RemoteMonitoring />} />
          <Route path="/insurance-eligibility" element={<InsuranceEligibility />} />
          <Route path="/enrollments" element={<PatientEnrollments />} />
          <Route path="/sync-logs" element={<DeviceSyncLogs />} />
          <Route path="/alert-thresholds" element={<MonitoringThresholds />} />
          <Route path="/rpm-readiness" element={<RpmBillingReadiness />} />
          <Route path="/subscription" element={<Subscription />} />
          {/* Operator-only console — gated by a platform token, not a tenant role; not in the sidebar. */}
          <Route path="/platform-legacy" element={<Platform />} />
          <Route path="/settings" element={<Settings />} />
          {/* Owner/admin console. ProtectedLayout's access gate holds the role
              requirement, mirroring requireRoles('OWNER','ADMIN') on
              /v1/control-plane; the API stays the enforcement point. */}
          <Route path="/control-plane" element={<ControlPlane />} />
          <Route path="/admin" element={<ControlPlane />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
