import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from '@/pages/login';
import { ROUTES } from './paths';
import { RequireSession } from './RequireSession';

/** Temporary landing behind the session gate until the plan page lands. */
function PlanPlaceholder() {
  return (
    <main className="grid h-full place-items-center p-8 text-center">
      <p className="text-sm text-ink/60">Вход выполнен. Экран «План дня» — следующий шаг.</p>
    </main>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<LoginPage />} path={ROUTES.login} />
      <Route element={<RequireSession />}>
        <Route element={<PlanPlaceholder />} path={ROUTES.plan} />
      </Route>
      <Route element={<Navigate replace to={ROUTES.plan} />} path="*" />
    </Routes>
  );
}
