import { env, isAllowedLogin as envAllowsLogin, roleFor as envRoleFor } from '../config/env.js';
import { TeamMember } from '../models/TeamMember.js';

// The one answer to "what may this address do?", used at sign-in and again on every request.
//
// Two sources, in this order:
//   1. The environment — ADMIN_EMAILS, EMAIL_USER, ALLOWED_LOGIN_DOMAINS, ALLOWED_LOGIN_EMAILS.
//      Unchanged from before, and still the way back in: an address in ADMIN_EMAILS is an admin
//      no matter what the database says, which is what makes it impossible to lock every admin
//      out of the app by editing the people list.
//   2. The TeamMember collection — what an admin maintains from Settings.
//
// A deactivated TeamMember row revokes a domain sign-in that would otherwise be allowed: that is
// the only way to turn someone off without narrowing the whole domain.

export const SECTIONS = ['dashboard', 'email', 'settings'];

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
    return { allowed: true, role: 'admin', sections: [...SECTIONS], source: 'env' };
  }

  const member = await TeamMember.findOne({ email: normalized }).lean();

  if (member && member.active === false) {
    return { allowed: false, role: 'manager', sections: [], source: 'revoked' };
  }

  if (member) {
    const role = member.role === 'admin' ? 'admin' : 'manager';
    const title = member.title ?? null;
    const sections = role === 'admin'
      ? [...SECTIONS]
      : SECTIONS.filter((s) => (member.sections ?? []).includes(s));
    // EMAIL_USER keeps the Email page even if nobody ticked it: that address is the mailbox the
    // reports are sent from, and losing its own access would be a confusing way to break
    // sending.
    if (isEmailSender && !sections.includes('email')) sections.push('email');
    return { allowed: true, role, title, sections, source: 'member' };
  }

  // Nobody has listed them, so fall back to the environment's own rule.
  if (isEmailSender) {
    return { allowed: true, role: envRoleFor(normalized), sections: [...DEFAULT_SECTIONS, 'email'], source: 'env' };
  }
  if (envAllowsLogin(normalized)) {
    return { allowed: true, role: envRoleFor(normalized), sections: [...DEFAULT_SECTIONS], source: 'domain' };
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

export function canUseSection(access, section) {
  return Boolean(access?.allowed) && (access.role === 'admin' || access.sections.includes(section));
}
