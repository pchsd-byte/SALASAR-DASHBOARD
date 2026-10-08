import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import { sendReport, scheduleReport, listScheduledEmails, cancelScheduledEmail } from '../controllers/email.controller.js';
import { requireAuth, requireSection } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

// Sends real email from a real mailbox — keep this tight regardless of the general API limit.
const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// The compose body can carry a few inline images as base64 data URLs, so it gets a much larger
// limit than the rest of the API. It is parsed only after the caller has been authenticated and
// authorised: mounted app-wide, as it was, anyone on the internet could make the server buffer
// and parse 20 MB per request. The body is sanitised here for the same reason app.js sanitises
// every other route — the app-level pass runs before this parser has filled req.body.
const largeJson = [express.json({ limit: '20mb' }), mongoSanitize()];

// Anyone an admin has given the Email section to — the plant has several process coordinators,
// and this used to be one address from the environment. What they cannot do is change which
// mailbox the reports leave from: that is EMAIL_USER's own Gmail grant (auth.routes.js), and
// every send goes through it whoever composed it.
const restricted = [requireAuth, requireSection('email')];

router.post('/send', ...restricted, sendLimiter, ...largeJson, asyncHandler(sendReport));
router.post('/schedule', ...restricted, sendLimiter, ...largeJson, asyncHandler(scheduleReport));
router.get('/scheduled', ...restricted, asyncHandler(listScheduledEmails));
router.delete('/scheduled/:id', ...restricted, asyncHandler(cancelScheduledEmail));

export default router;
