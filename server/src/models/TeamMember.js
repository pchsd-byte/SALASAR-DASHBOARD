import mongoose from 'mongoose';

// Who may sign in, and which parts of the dashboard they get.
//
// Access used to live entirely in environment variables: ADMIN_EMAILS, ALLOWED_LOGIN_DOMAINS and
// a single EMAIL_USER who was the only person allowed near the Email page. The plant has several
// process coordinators, and adding one meant editing Render's environment and waiting for a
// redeploy. This collection is the editable half: an admin adds an address and ticks the
// sections it may open, and it applies on that person's next request.
//
// It is keyed by email, not by User, deliberately — access is granted *before* the person first
// signs in, when no User document exists yet. The two meet in services/access.service.js.
//
// ADMIN_EMAILS still works and still wins (services/access.service.js): it is the way back in if
// this collection is ever emptied by mistake, so it cannot be edited through the API.
const teamMemberSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // What to show in the people list before they have ever signed in; their Google profile name
    // takes over once they have.
    name: { type: String, default: null },
    // Their job on the plant — "Process Coordinator — HSD", "Plant Head". Shown next to their
    // name in the navbar, and the reason there are several people with identical access: it was
    // hard-coded to one address before (DISPLAY_NAME_OVERRIDES in the client's Navbar).
    title: { type: String, default: null },
    // What they may do, not what they are called: 'admin' gets every section plus this page.
    role: { type: String, enum: ['admin', 'manager'], default: 'manager' },
    // Section keys from SECTIONS in services/access.service.js. An admin's sections are implied
    // (all of them) and this list is ignored for them.
    sections: [{ type: String }],
    // Revoking access without losing the record of who had it — and without a half-deleted
    // state if the person is re-added later.
    active: { type: Boolean, default: true },
    addedByEmail: { type: String, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const TeamMember = mongoose.model('TeamMember', teamMemberSchema);
