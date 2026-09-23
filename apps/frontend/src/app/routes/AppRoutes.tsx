import { Navigate, Route, Routes } from 'react-router-dom';
import { AiPage } from '@/pages/ai';
import { AlertsPage } from '@/pages/alerts';
import { ChatsPage } from '@/pages/chats';
import { EngineersPage } from '@/pages/engineers';
import { LoginPage } from '@/pages/login';
import { PlanPage } from '@/pages/plan';
import { PolicyPage } from '@/pages/policy';
import { RequestsPage } from '@/pages/requests';
import { AppLayout } from '@/widgets/app-shell';
import { ROUTES } from './paths';
import { RequireSession } from './RequireSession';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<LoginPage />} path={ROUTES.login} />
      <Route element={<RequireSession />}>
        <Route element={<AppLayout />}>
          <Route element={<PlanPage />} path={ROUTES.plan} />
          <Route element={<RequestsPage />} path={ROUTES.requests} />
          <Route element={<EngineersPage />} path={ROUTES.engineers} />
          <Route element={<AlertsPage />} path={ROUTES.alerts} />
          <Route element={<PolicyPage />} path={ROUTES.policy} />
          <Route element={<ChatsPage />} path={ROUTES.chats} />
          <Route element={<AiPage />} path={ROUTES.ai} />
        </Route>
      </Route>
      <Route element={<Navigate replace to={ROUTES.plan} />} path="*" />
    </Routes>
  );
}
