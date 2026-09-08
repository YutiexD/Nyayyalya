/**
 * Client entry.
 *
 * Provider order matters and is deliberate:
 *   Redux    — theme and session, read by everything below
 *   Query    — server state, whose error handling needs the session
 *   Theme    — applies the class before the router paints
 *   Router   — last, so a guard can read both session and theme
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';

import { store } from '@/store';
import { queryClient } from '@/lib/queryClient';
import { ThemeProvider } from '@/components/ThemeProvider';
import { router } from '@/routes/router';
import { Toaster } from '@/components/ui/sonner';
import '@/styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
          <Toaster richColors closeButton position="top-right" />
        </ThemeProvider>
      </QueryClientProvider>
    </Provider>
  </React.StrictMode>
);
