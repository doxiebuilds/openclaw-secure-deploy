import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { RealtimeProvider } from './realtime/RealtimeProvider';
import { ShellLayout } from './shell/ShellLayout';
import { PageLoading } from './ui/PageLoading';
import { LoginPage } from './pages/LoginPage';

const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const GatewaysPage = lazy(() => import('./pages/GatewaysPage').then((m) => ({ default: m.GatewaysPage })));
const GatewayDetailPage = lazy(() =>
  import('./pages/GatewayDetailPage').then((m) => ({ default: m.GatewayDetailPage }))
);
const AgentsPage = lazy(() => import('./pages/AgentsPage').then((m) => ({ default: m.AgentsPage })));
const AgentDetailPage = lazy(() => import('./pages/AgentDetailPage').then((m) => ({ default: m.AgentDetailPage })));
const SessionHistoryPage = lazy(() =>
  import('./pages/SessionHistoryPage').then((m) => ({ default: m.SessionHistoryPage }))
);
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage').then((m) => ({ default: m.ApprovalsPage })));
const AuditPage = lazy(() => import('./pages/AuditPage').then((m) => ({ default: m.AuditPage })));
const AutomationsPage = lazy(() => import('./pages/AutomationsPage').then((m) => ({ default: m.AutomationsPage })));
const ConfigPage = lazy(() => import('./pages/ConfigPage').then((m) => ({ default: m.ConfigPage })));
const SecurityPage = lazy(() => import('./pages/SecurityPage').then((m) => ({ default: m.SecurityPage })));
const ExchangePage = lazy(() => import('./pages/ExchangePage').then((m) => ({ default: m.ExchangePage })));

function ProtectedShell() {
  const { user, loading } = useAuth();
  if (loading) return <PageLoading />;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <RealtimeProvider>
      <ShellLayout>
        <Suspense fallback={<PageLoading />}>
          <Outlet />
        </Suspense>
      </ShellLayout>
    </RealtimeProvider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/gateways" element={<GatewaysPage />} />
        <Route path="/gateways/:id" element={<GatewayDetailPage />} />
        <Route path="/gateways/:id/agents/:agentId" element={<AgentDetailPage />} />
        <Route path="/gateways/:id/sessions/:sessionKey" element={<SessionHistoryPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/automations" element={<AutomationsPage />} />
        <Route path="/config" element={<ConfigPage />} />
        <Route path="/exchange" element={<ExchangePage />} />
        <Route path="/security" element={<SecurityPage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
