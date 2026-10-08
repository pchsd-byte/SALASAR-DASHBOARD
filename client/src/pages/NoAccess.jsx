import { useAuth } from '../context/AuthContext';

// Somebody who may sign in but has not been given a section yet. Before the people list existed
// this could not happen; now it is the first thing a newly added colleague sees if the admin
// saved their address without ticking anything, so it says who to ask rather than looping them
// back to a page they cannot open.
export function NoAccess() {
  const { user } = useAuth();

  return (
    <div className="mx-auto max-w-xl px-6 py-16 text-center">
      <h1 className="mb-2 text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
        No sections yet
      </h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        You are signed in as <strong>{user?.email}</strong>, but nobody has given this account a part
        of the dashboard to open yet. Ask an administrator to add the sections you need under
        Settings → People and access.
      </p>
    </div>
  );
}
