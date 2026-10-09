// The sections an admin can grant, mirroring SECTIONS in the server's access.service.js. The
// server is the authority — it refuses the request itself — and this list only decides what the
// browser bothers to draw.
export const SECTION_LABELS = {
  dashboard: 'Dashboard',
  email: 'Email',
  settings: 'Settings',
};

// Sections are the whole answer, for admins too: an admin is not given Email by default (see
// ADMIN_SECTIONS on the server), so a role shortcut here would draw a nav link the API refuses.
export function canOpen(user, section) {
  if (!user) return false;
  return (user.sections ?? []).includes(section);
}

// Where to send somebody who lands on a page they may not open. A process coordinator with only
// the Email section used to be bounced to "/" — a dashboard they are not allowed to read —
// which looked like a broken app rather than a page that was never theirs.
export function landingFor(user) {
  if (canOpen(user, 'dashboard')) return '/';
  if (canOpen(user, 'email')) return '/email';
  return '/no-access';
}
