import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { resolveAccess, canUseSection } from '../services/access.service.js';

export async function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  let claims;
  try {
    claims = jwt.verify(token, env.jwtSecret);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  // The token is proof of who signed in, not of what they may do now. Access, role and sections
  // are re-derived on every request: taking someone out of ADMIN_EMAILS — or, now, off the
  // people list in Settings — used to take effect only when their 12-hour session expired.
  try {
    const access = await resolveAccess(claims.email);
    if (!access.allowed) {
      return res.status(403).json({ error: 'This account is not allowed to use the dashboard.' });
    }
    req.user = { ...claims, role: access.role, sections: access.sections };
    req.access = access;
    return next();
  } catch (err) {
    // A database blip must not read as "you are not allowed" — that would sign the whole plant
    // out of a dashboard that is merely unwell.
    return next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Section access, as granted in Settings → People and access. Admins pass everything.
export function requireSection(section) {
  return (req, res, next) => {
    if (!canUseSection(req.access, section)) {
      return res.status(403).json({ error: 'Not authorized for this action' });
    }
    next();
  };
}

// A single named address, regardless of sections. Only the Gmail grant uses this now: the
// reports are sent from EMAIL_USER's own mailbox, so only that account can authorise it —
// everyone with the Email section sends *through* it (§6.3).
export function requireEmail(allowedEmail) {
  const normalized = allowedEmail?.toLowerCase();
  return (req, res, next) => {
    if (!normalized || req.user?.email?.toLowerCase() !== normalized) {
      return res.status(403).json({ error: 'Not authorized for this action' });
    }
    next();
  };
}
