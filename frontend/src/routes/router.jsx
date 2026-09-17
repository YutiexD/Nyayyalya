/**
 * Route table.
 *
 * Every role view is lazy: an advocate never downloads the officer's upload form or the
 * FSL verdict form, which keeps the first paint after sign-in small.
 *
 * The public verifier is deliberately OUTSIDE the protected tree and carries no
 * session logic at all. It is the one surface a person with no account is meant to
 * reach, and it must keep working when nobody is signed in.
 */
import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';

import { AppLayout } from '@/components/layout/AppLayout';
import { ProtectedRoute, PublicOnlyRoute } from '@/routes/ProtectedRoute';
import { RouteFallback } from '@/components/layout/RouteFallback';
import { ErrorBoundaryPage } from '@/components/layout/ErrorBoundaryPage';
import { ROLES_FOR_ROUTE } from '@/lib/api';

const Landing = lazy(() => import('@/features/landing/LandingPage'));
const Login = lazy(() => import('@/features/auth/LoginPage'));
const Officer = lazy(() => import('@/features/officer/OfficerPage'));
const Station = lazy(() => import('@/features/station/StationPage'));
const Court = lazy(() => import('@/features/court/CourtPage'));
const Lab = lazy(() => import('@/features/lab/LabPage'));
const Counsel = lazy(() => import('@/features/counsel/CounselPage'));
const Verify = lazy(() => import('@/features/verify/VerifyPage'));

/** Wrap a lazy element so every route shares one loading and one error treatment. */
const page = (Element) => (
  <Suspense fallback={<RouteFallback />}>
    <Element />
  </Suspense>
);

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    errorElement: <ErrorBoundaryPage />,
    children: [
      { path: '/', element: page(Landing) },
      { path: '/verify', element: page(Verify) },

      {
        element: <PublicOnlyRoute />,
        children: [{ path: '/login', element: page(Login) }],
      },

      {
        element: <ProtectedRoute roles={ROLES_FOR_ROUTE['/officer']} />,
        children: [{ path: '/officer', element: page(Officer) }],
      },
      {
        element: <ProtectedRoute roles={ROLES_FOR_ROUTE['/station']} />,
        children: [{ path: '/station', element: page(Station) }],
      },
      {
        element: <ProtectedRoute roles={ROLES_FOR_ROUTE['/court']} />,
        children: [{ path: '/court', element: page(Court) }],
      },
      {
        element: <ProtectedRoute roles={ROLES_FOR_ROUTE['/lab']} />,
        children: [{ path: '/lab', element: page(Lab) }],
      },
      {
        element: <ProtectedRoute roles={ROLES_FOR_ROUTE['/counsel']} />,
        children: [{ path: '/counsel', element: page(Counsel) }],
      },

      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
