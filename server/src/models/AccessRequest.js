import mongoose from 'mongoose';

// Somebody who signed in with Google and was turned away because no admin has added them.
//
// Without this, a refused colleague is invisible: they see the "no access" page, and the admin
// has no idea they tried — so the first anybody hears of it is a phone call. Each refused
// attempt upserts one row here, and it shows in Settings → People and access as a request the
// admin can grant with one click or dismiss.
//
// It holds nothing the person did not just hand to Google's sign-in page about themselves, it
// grants nothing on its own, and it expires after 90 days so a stream of strangers knocking
// cannot grow it without bound.
const accessRequestSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, default: null },
    picture: { type: String, default: null },
    // Repeat attempts bump the count rather than adding rows — somebody trying three times is
    // one person who needs access, not three requests.
    attempts: { type: Number, default: 1 },
    // 'not_allowed' — never added. 'revoked' — they were switched off, which is a different
    // conversation: an admin who turned them off probably meant it.
    reason: { type: String, enum: ['not_allowed', 'revoked'], default: 'not_allowed' },
    firstAttemptAt: { type: Date, default: Date.now },
    lastAttemptAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

accessRequestSchema.index({ lastAttemptAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const AccessRequest = mongoose.model('AccessRequest', accessRequestSchema);
