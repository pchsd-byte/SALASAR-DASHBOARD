import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/layout/ProtectedRoute';
import { Navbar } from './components/layout/Navbar';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { Email } from './pages/Email';
import { AccessDenied } from './pages/AccessDenied';
import { Profile } from './pages/Profile';
import { WelcomeBlessing } from './components/layout/WelcomeBlessing';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

function AppShell({ children }) {
  return (
    <div className="min-h-screen">
      <Navbar />
      {children}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          {/* Outside the routes on purpose. It reads the sign-in flag when the app mounts, which
              is before any route has decided where this person lands — a coordinator with only
              the Email section gets redirected off `/`, and a redirect drops the query string. */}
          <WelcomeBlessing />
          <Routes>
            <Route path="/login" element={<Login />} />
            {/* Everyone signed in has a profile, whatever sections they were given — it is
                where they find out what those sections are. */}
            <Route
              path="/profile"
              element={
                <ProtectedRoute>
                  <AppShell>
                    <Profile />
                  </AppShell>
                </ProtectedRoute>
              }
            />
            {/* Public: the person has no session — the server turned their sign-in away and
                passed the address along in the URL. */}
            <Route path="/access-denied" element={<AccessDenied />} />
            {/* Signed in, but no section has been ticked for them yet. */}
            <Route
              path="/no-access"
              element={
                <ProtectedRoute>
                  <AccessDenied variant="no_sections" />
                </ProtectedRoute>
              }
            />
            <Route
              path="/"
              element={
                <ProtectedRoute section="dashboard">
                  <AppShell>
                    <Dashboard />
                  </AppShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute section="settings">
                  <AppShell>
                    <Settings />
                  </AppShell>
                </ProtectedRoute>
              }
            />
            <Route
              path="/email"
              element={
                <ProtectedRoute section="email">
                  <AppShell>
                    <Email />
                  </AppShell>
                </ProtectedRoute>
              }
            />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
