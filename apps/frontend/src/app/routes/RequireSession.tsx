import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useIsAuthenticated } from '@/entities/session';
import { ROUTES } from './paths';

/**
 * Gate for the `dispatch/*` contour: every page behind it needs a live dispatcher
 * token. The requested path travels in router state so sign-in returns the user
 * where they were heading.
 */
export function RequireSession() {
  const isAuthenticated = useIsAuthenticated();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate replace state={{ from: location.pathname }} to={ROUTES.login} />;
  }

  return <Outlet />;
}
