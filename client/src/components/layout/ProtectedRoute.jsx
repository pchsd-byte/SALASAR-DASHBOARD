import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { canOpen, landingFor } from '../../lib/sections';

export function ProtectedRoute({ children, adminOnly = false, section }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center" style={{ background: 'var(--surface-page)' }}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: 'var(--series-1)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== 'admin') return <Navigate to={landingFor(user)} replace />;
  // Sections are granted per person in Settings → People and access. This hides the page; the
  // API refuses the data regardless, which is the check that actually protects it.
  if (section && !canOpen(user, section)) return <Navigate to={landingFor(user)} replace />;

  return children;
}
