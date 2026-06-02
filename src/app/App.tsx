import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Sidebar from '../components/layout/Sidebar';
import Topbar from '../components/layout/Topbar';

const Dashboard = lazy(() => import('../pages/Dashboard'));
const ClinicRadar = lazy(() => import('../pages/ClinicRadar'));
const Autopilot = lazy(() => import('../pages/Autopilot'));
const CRM = lazy(() => import('../pages/CRM'));
const AIReceptionist = lazy(() => import('../pages/AIReceptionist'));
const Scheduling = lazy(() => import('../pages/Scheduling'));
const Patients = lazy(() => import('../pages/Patients'));
const PatientProfile = lazy(() => import('../pages/PatientProfile'));
const Campaigner = lazy(() => import('../pages/Campaigner'));
const Revenue = lazy(() => import('../pages/Revenue'));
const OpportunityCenter = lazy(() => import('../pages/OpportunityCenter'));
const DoctorWorkspace = lazy(() => import('../pages/DoctorWorkspace'));
const StaffWorkflow = lazy(() => import('../pages/StaffWorkflow'));
const Reviews = lazy(() => import('../pages/Reviews'));
const Inventory = lazy(() => import('../pages/Inventory'));
const Labs = lazy(() => import('../pages/Labs'));
const Telehealth = lazy(() => import('../pages/Telehealth'));
const Compliance = lazy(() => import('../pages/Compliance'));
const Integrations = lazy(() => import('../pages/Integrations'));
const Settings = lazy(() => import('../pages/Settings'));

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <Sidebar />
        <div className="app-main">
          <Topbar />
          <div className="app-scroll">
            <div className="app-inner">
              <Suspense fallback={<div className="skeleton h-48 rounded-2xl" />}>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/clinic-radar" element={<ClinicRadar />} />
                  <Route path="/autopilot" element={<Autopilot />} />
                  <Route path="/crm" element={<CRM />} />
                  <Route path="/ai-receptionist" element={<AIReceptionist />} />
                  <Route path="/scheduling" element={<Scheduling />} />
                  <Route path="/patients" element={<Patients />} />
                  <Route path="/patients/:id" element={<PatientProfile />} />
                  <Route path="/campaigner" element={<Campaigner />} />
                  <Route path="/revenue" element={<Revenue />} />
                  <Route path="/opportunities" element={<OpportunityCenter />} />
                  <Route path="/doctor-workspace" element={<DoctorWorkspace />} />
                  <Route path="/staff" element={<StaffWorkflow />} />
                  <Route path="/reviews" element={<Reviews />} />
                  <Route path="/inventory" element={<Inventory />} />
                  <Route path="/labs" element={<Labs />} />
                  <Route path="/telehealth" element={<Telehealth />} />
                  <Route path="/compliance" element={<Compliance />} />
                  <Route path="/integrations" element={<Integrations />} />
                  <Route path="/settings" element={<Settings />} />
                </Routes>
              </Suspense>
            </div>
          </div>
        </div>
      </div>
    </BrowserRouter>
  );
}
