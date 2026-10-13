import { env, roleFor as envRoleFor } from '../config/env.js';
import { TeamMember } from '../models/TeamMember.js';

// The one answer to "what may this address do?", used at sign-in and again on every request.
//
// **Nobody gets in who has not been named.** There is no longer a domain rule: signing in with
// any Google account — a personal gmail.com address or a colleague's work address — gives you
// nothing until an admin adds you. ALLOWED_LOGIN_DOMAINS used to admit the whole company and is
// gone; the plant is a handful of people, and "anyone at the domain can read the figures" was a
// wider door than anybody had actually asked for.
//
// So an address is allowed only if it is one of:
//   1. **ADMIN_EMAILS** — always admins, checked before any query. The way back in, and the
//      reason the people list can never lock every admin out.
//   2. **An active TeamMember row** — what an admin maintains from Settings.
//   3. **EMAIL_USER / ALLOWED_LOGIN_EMAILS** — explicit grants typed into the environment by
//      whoever runs the server, which is the same act of permission as adding a row.
//
// Everything else is refused, and the attempt is recorded so an admin can see who knocked
// (models/AccessRequest.js).

export const SECTIONS = ['dashboard', 'email', 'settings'];

// What an admin gets without anybody ticking anything. Email is deliberately **not** in here:
// the report composer belongs to the process coordinators who write the reports, and an admin
// managing Drive and the people list has no business in their drafts and schedule queue. An
// admin who does need it is ticked for it like anyone else — and EMAIL_USER always keeps it,
// since that is the mailbox everything is sent from.
export const ADMIN_SECTIONS = SECTIONS.filter((section) => section !== 'email');

// Shown in the admin UI, so the person granting access reads what it means rather than a key.
export const SECTION_LABELS = {
  dashboard: 'Dashboard — production, dispatch and manpower figures',
  email: 'Email — compose, send and schedule the plant reports',
  settings: 'Settings — Drive connection and the sync log',
};

// What someone allowed in by domain (or ALLOWED_LOGIN_EMAILS) gets when nobody has set their
// sections. Before this feature every such account could open the dashboard, and taking that
// away silently on upgrade would lock the plant out of its own figures.
export const DEFAULT_SECTIONS = ['dashboard'];

const CACHE_TTL_MS = 30_000;
const cache = new Map();

export function invalidateAccessCache(email) {
  if (email) cache.delete(email.toLowerCase());
  else cache.clear();
}

function envAccess(email) {
  const normalized = (email || '').toLowerCase();
  const isEnvAdmin = env.adminEmails.includes(normalized);
  const isEmailSender = Boolean(env.emailUser) && normalized === env.emailUser.toLowerCase();
  return { normalized, isEnvAdmin, isEmailSender };
}

async function resolve(email) {
  const { normalized, isEnvAdmin, isEmailSender } = envAccess(email);
  if (!normalized) return { allowed: false, role: 'manager', sections: [] };

  // ADMIN_EMAILS first, and before any query — the lock-out guard. Checking it without touching
  // the database also means an admin can still sign in and read the sync log when MongoDB is the
  // thing that is broken.
  if (isEnvAdmin) {
    const sections = [...ADMIN_SECTIONS];
    if (isEmailSender) sections.push('email');
    return { allowed: true, role: 'admin', sections, source: 'env' };
  }

  const member = await TeamMember.findOne({ email: normalized }).lean();

  if (member && member.active === false) {
    return { allowed: false, role: 'manager', sections: [], source: 'revoked' };
  }

  if (member) {
    const role = member.role === 'admin' ? 'admin' : 'manager';
    const title = member.title ?? null;
    // An admin's own ticks only decide Email; the rest of an admin's sections are implied.
    const sections = role === 'admin'
      ? SECTIONS.filter((s) => ADMIN_SECTIONS.includes(s) || (member.sections ?? []).includes(s))
      : SECTIONS.filter((s) => (member.sections ?? []).includes(s));
    // EMAIL_USER keeps the Email page even if nobody ticked it: that address is the mailbox the
    // reports are sent from, and losing its own access would be a confusing way to break
    // sending.
    if (isEmailSender && !sections.includes('email')) sections.push('email');
    return { allowed: true, role, title, sections, source: 'member' };
  }

  // Not on the list: the only remaining ways in are the explicit grants in the environment.
  if (isEmailSender) {
    return { allowed: true, role: envRoleFor(normalized), sections: [...DEFAULT_SECTIONS, 'email'], source: 'env' };
  }
  if (env.allowedLoginEmails.includes(normalized)) {
    return { allowed: true, role: envRoleFor(normalized), sections: [...DEFAULT_SECTIONS], source: 'env-email' };
  }
  return { allowed: false, role: 'manager', sections: [], source: 'none' };
}

// Cached briefly: requireAuth asks on every request, and without this each one costs a query.
// Every write through the people API clears the entry, so a change an admin makes is live
// immediately rather than within the TTL — the TTL only covers edits made straight in the
// database.
export async function resolveAccess(email) {
  const key = (email || '').toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const value = await resolve(key);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// Sections are the whole answer — there is no "admin sees everything" shortcut here, because
// Email is a section an admin does not get by default (ADMIN_SECTIONS above). Being an admin is
// still what `requireAdmin` checks for Drive, manual syncs and the people list.
export function canUseSection(access, section) {
  return Boolean(access?.allowed) && access.sections.includes(section);
}
