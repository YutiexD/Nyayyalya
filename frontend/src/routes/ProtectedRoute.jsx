/**
 * Route protection.
 *
 * # This is convenience, not security
 *
 * Worth stating plainly because it is easy to mistake for the real thing: the server
 * authorises every single request through `services/accessResolver.js`, loading the
 * resource from the database itself. A user who edits `sessionStorage` to claim they
 * are a judge gets a session object this guard believes and an API that refuses every
 * call they make. Nothing here is a security boundary.
 *
 * What it IS for: a stale tab should show a sign-in screen, not a wall of 401s; and a
 * malkhana custodian who follows a link to the court view should land somewhere they
 * can work rather than on a page where every panel is a denial. Both are usability
 * problems, and both are worth fixing in the client.
 */
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { selectSession } from '@/features/auth/authSlice';
import { getAccessToken, HOME_FOR_ROLE } from '@/lib/api';

/**
 * @param {object} props
 * @param {string[]} [props.roles] roles permitted here; omitted means any signed-in user
 */
export function ProtectedRoute({ roles }) {
  const session = useSelector(selectSession);
  const location = useLocation();

  // Both halves must be present. A session object without a token is a tab whose
  // sessionStorage was partially cleared, and rendering a dashboard for it would
  // produce exactly the wall of 401s this guard exists to avoid.
  if (!session || !getAccessToken()) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (roles && !roles.includes(session.role)) {
    // Send them to their own home rather than an error page: they are a legitimate
    // user who followed a link meant for a different role.
    return <Navigate to={HOME_FOR_ROLE[session.role] ?? '/login'} replace />;
  }

  return <Outlet />;
}

/** The inverse: keep a signed-in user off the sign-in screen. */
export function PublicOnlyRoute() {
  const session = useSelector(selectSession);
  const location = useLocation();

  if (session && getAccessToken()) {
    const next = location.state?.from;
    return <Navigate to={next || HOME_FOR_ROLE[session.role] || '/'} replace />;
  }
  return <Outlet />;
}
