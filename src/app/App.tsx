import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Sidebar from '../components/layout/Sidebar';
import Topbar from '../components/layout/Topbar';
import { useSession } from '../hooks/useSession';

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
const Settings = lazy(() => import('../pages/Settings'));
const ControlPlane = lazy(() => import('../pages/ControlPlane'));

function ProtectedLayout() {
  const { loading, isAuthenticated } = useSession();
  const location = useLocation();

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
            <Suspense fallback={<div className="skeleton h-48 rounded-2xl" />}>
              <Outlet />
            </Suspense>
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
        <Route element={<ProtectedLayout />}>
          <Route path="/" element={<Dashboard />} />
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
          <Route path="/settings" element={<Settings />} />
          <Route path="/control-plane" element={<AdminRoute />} />
          <Route path="/admin" element={<AdminRoute />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
