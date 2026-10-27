import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    name: { type: String, required: true },
    // What Google gave us at sign-in. Kept whatever the person later chooses, so "use my Google
    // photo" always has something to go back to.
    picture: { type: String },
    // What they chose for themselves on the Profile page.
    //   'google'   — their Google photo (the default; nothing else is stored)
    //   'initials' — their initials on one of the dashboard's own series colours
    //   'photo'    — an uploaded picture, downscaled by the browser to 128x128 before it is
    //                sent and capped below (models are not the place to ship megabytes: this
    //                rides along with /auth/me on every page load, and bandwidth is metered).
    avatar: {
      kind: { type: String, enum: ['google', 'initials', 'photo'], default: 'google' },
      // Index into the chart palette, so a chosen colour cannot clash with the theme.
      colorIndex: { type: Number, default: 0, min: 0, max: 7 },
      dataUrl: { type: String, default: null },
    },
    role: { type: String, enum: ['admin', 'manager'], default: 'manager' },
    title: { type: String, default: null },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

export const User = mongoose.model('User', userSchema);
