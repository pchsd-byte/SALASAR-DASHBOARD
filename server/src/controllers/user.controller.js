import { TeamMember } from '../models/TeamMember.js';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { SECTIONS, SECTION_LABELS, DEFAULT_SECTIONS, invalidateAccessCache } from '../services/access.service.js';
import { BadRequestError } from './dashboard.controller.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

const shape = (m) => ({
  email: m.email,
  name: m.name ?? null,
  title: m.title ?? null,
  role: m.role,
  sections: m.role === 'admin' ? SECTIONS : m.sections ?? [],
  active: m.active !== false,
});

function parseEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!EMAIL_PATTERN.test(email)) throw new BadRequestError('Enter a valid email address.');
  return email;
}

function parseRole(value) {
  if (value === undefined) return undefined;
  if (value !== 'admin' && value !== 'manager') throw new BadRequestError('Role must be "admin" or "manager".');
  return value;
}

function parseSections(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new BadRequestError('Sections must be a list.');
  const unknown = value.filter((s) => !SECTIONS.includes(s));
  if (unknown.length) throw new BadRequestError(`Unknown section: ${unknown.join(', ')}.`);
  // De-duplicated and kept in the canonical order, so the stored row never depends on the order
  // the checkboxes happened to be ticked in.
  return SECTIONS.filter((s) => value.includes(s));
}

// An address listed in ADMIN_EMAILS is an admin whatever this collection says, so letting it be
// edited here would show a change that has no effect. It is refused with the reason.
function refuseIfEnvAdmin(email) {
  if (env.adminEmails.includes(email)) {
    throw new BadRequestError(`${email} is an admin through the server's ADMIN_EMAILS setting and cannot be changed here. Edit that setting to change it.`);
  }
}

// Never leave the app with no admin. Environment admins count, which is why this can only ever
// refuse the removal of the last *database* admin while ADMIN_EMAILS is empty.
async function refuseIfLastAdmin(email) {
  if (env.adminEmails.length > 0) return;
  const target = await TeamMember.findOne({ email }).lean();
  if (target?.role !== 'admin' || target.active === false) return;
  const otherAdmins = await TeamMember.countDocuments({ role: 'admin', active: true, email: { $ne: email } });
  if (otherAdmins === 0) {
    throw new BadRequestError('This is the only admin left. Make somebody else an admin first, or add an address to ADMIN_EMAILS on the server.');
  }
}

export async function listTeam(req, res) {
  const [members, users] = await Promise.all([
    TeamMember.find().sort({ email: 1 }).lean(),
    // Whoever has actually signed in, for the name and the last-seen column.
    User.find().select('email name picture lastLoginAt -_id').lean(),
  ]);
  const byEmail = new Map(users.map((u) => [u.email, u]));

  res.json({
    // What the UI needs to render the section checkboxes without hard-coding the list.
    sections: SECTIONS.map((key) => ({ key, label: SECTION_LABELS[key] })),
    defaultSections: DEFAULT_SECTIONS,
    // Config-level facts the admin cannot change from here, shown so the page explains itself.
    envAdmins: env.adminEmails,
    emailSender: env.emailUser,
    loginDomains: env.allowedLoginDomains,
    members: members.map((m) => ({
      ...shape(m),
      name: byEmail.get(m.email)?.name ?? m.name ?? null,
      picture: byEmail.get(m.email)?.picture ?? null,
      addedByEmail: m.addedByEmail ?? null,
      lastLoginAt: byEmail.get(m.email)?.lastLoginAt ?? null,
      // An admin from ADMIN_EMAILS can also have a row here; say so rather than letting an edit
      // look like it did nothing.
      fixedByEnv: env.adminEmails.includes(m.email),
    })),
  });
}

export async function addTeamMember(req, res) {
  const email = parseEmail(req.body?.email);
  refuseIfEnvAdmin(email);
  const role = parseRole(req.body?.role) ?? 'manager';
  const sections = parseSections(req.body?.sections) ?? [...DEFAULT_SECTIONS];
  const name = text(req.body?.name);
  const title = text(req.body?.title);

  if (await TeamMember.findOne({ email }).lean()) {
    throw new BadRequestError(`${email} is already on the list. Edit their access instead.`);
  }

  const member = await TeamMember.create({ email, name, title, role, sections, active: true, addedByEmail: req.user.email });
  invalidateAccessCache(email);
  res.status(201).json(shape(member));
}

export async function updateTeamMember(req, res) {
  const email = parseEmail(req.params.email);
  refuseIfEnvAdmin(email);

  const update = {};
  const role = parseRole(req.body?.role);
  const sections = parseSections(req.body?.sections);
  if (role !== undefined) update.role = role;
  if (sections !== undefined) update.sections = sections;
  if (typeof req.body?.active === 'boolean') update.active = req.body.active;
  if (typeof req.body?.name === 'string') update.name = text(req.body.name);
  if (typeof req.body?.title === 'string') update.title = text(req.body.title);
  if (Object.keys(update).length === 0) throw new BadRequestError('Nothing to change.');

  // Demoting or switching off the last admin locks everybody out of this very page.
  if (update.role === 'manager' || update.active === false) await refuseIfLastAdmin(email);

  const member = await TeamMember.findOneAndUpdate({ email }, { $set: update }, { new: true }).lean();
  if (!member) throw new BadRequestError(`${email} is not on the list.`);
  invalidateAccessCache(email);
  res.json(shape(member));
}

export async function removeTeamMember(req, res) {
  const email = parseEmail(req.params.email);
  refuseIfEnvAdmin(email);
  await refuseIfLastAdmin(email);

  const removed = await TeamMember.findOneAndDelete({ email }).lean();
  if (!removed) throw new BadRequestError(`${email} is not on the list.`);
  invalidateAccessCache(email);
  // The User document (their Google profile, from signing in) is deliberately left alone: it is
  // a record of who has used the app, and removing access does not undo that history. Without a
  // TeamMember row they fall back to the environment's own rule — which for an address outside
  // ALLOWED_LOGIN_DOMAINS means no access at all.
  res.json({ removed: removed.email });
}
