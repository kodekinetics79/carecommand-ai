import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Sidebar from '../components/layout/Sidebar';
import Topbar from '../components/layout/Topbar';
import Dashboard from '../pages/Dashboard';
import ClinicRadar from '../pages/ClinicRadar';
import CRM from '../pages/CRM';
import AIReceptionist from '../pages/AIReceptionist';
import Scheduling from '../pages/Scheduling';
import Patients from '../pages/Patients';
import PatientProfile from '../pages/PatientProfile';
import Campaigner from '../pages/Campaigner';
import Revenue from '../pages/Revenue';
import DoctorWorkspace from '../pages/DoctorWorkspace';
import StaffWorkflow from '../pages/StaffWorkflow';
import Reviews from '../pages/Reviews';
import Inventory from '../pages/Inventory';
import Labs from '../pages/Labs';
import Telehealth from '../pages/Telehealth';
import Compliance from '../pages/Compliance';
import Integrations from '../pages/Integrations';
import Settings from '../pages/Settings';

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <Sidebar />
        <div className="app-main">
          <Topbar />
          <div className="app-scroll">
            <div className="app-inner">
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/clinic-radar" element={<ClinicRadar />} />
                <Route path="/crm" element={<CRM />} />
                <Route path="/ai-receptionist" element={<AIReceptionist />} />
                <Route path="/scheduling" element={<Scheduling />} />
                <Route path="/patients" element={<Patients />} />
                <Route path="/patients/:id" element={<PatientProfile />} />
                <Route path="/campaigner" element={<Campaigner />} />
                <Route path="/revenue" element={<Revenue />} />
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
            </div>
          </div>
        </div>
      </div>
    </BrowserRouter>
  );
}
