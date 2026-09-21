import { Navigate, Route, Routes } from 'react-router-dom';
import { AlertsPage } from '@/pages/alerts';
import { EngineersPage } from '@/pages/engineers';
import { LoginPage } from '@/pages/login';
import { PlanPage } from '@/pages/plan';
import { PolicyPage } from '@/pages/policy';
import { RequestsPage } from '@/pages/requests';
import { SectionPlaceholder } from '@/shared/ui';
import { AppLayout } from '@/widgets/app-shell';
import { ROUTES } from './paths';
import { RequireSession } from './RequireSession';

/**
 * Sections are added one at a time; until a section exists its route states that
 * plainly rather than showing invented content.
 */
const PENDING_SECTIONS = [
  {
    path: ROUTES.chats,
    title: 'Чаты',
    note: 'Данных нет: System Layer не отдаёт переписку — контракта на чаты пока не существует.',
  },
  {
    path: ROUTES.ai,
    title: 'AI',
    note: 'Данных нет: контракта на AI-ассистента в System Layer пока не существует.',
  },
];

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
          {PENDING_SECTIONS.map((section) => (
            <Route
              element={<SectionPlaceholder note={section.note} title={section.title} />}
              key={section.path}
              path={section.path}
            />
          ))}
        </Route>
      </Route>
      <Route element={<Navigate replace to={ROUTES.plan} />} path="*" />
    </Routes>
  );
}
