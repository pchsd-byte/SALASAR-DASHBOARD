// Imported first by every test file, before anything reads config/env.js. It pins a known
// configuration so results do not depend on whoever's server/.env happens to be on disk — and,
// above all, so no test can ever reach a real database: MONGODB_URI is forced to an address
// nothing listens on. Integration tests connect to their own in-memory MongoDB explicitly.
// (dotenv never overrides a variable that is already set.)
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/never-used-by-tests';
process.env.NODE_ENV = 'test';
delete process.env.RENDER;
delete process.env.RENDER_EXTERNAL_URL;
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.TOKEN_ENCRYPTION_KEY = 'test-token-encryption-key';
process.env.ADMIN_EMAILS = 'admin@salasartechno.com,owner@gmail.com';
process.env.EMAIL_USER = 'pc.hsd@salasartechno.com';
// ALLOWED_LOGIN_DOMAINS is gone: a domain is no longer a way in (Oct 2026).
process.env.ALLOWED_LOGIN_EMAILS = 'guest@gmail.com';
process.env.CLIENT_ORIGIN = 'http://localhost:5173/';
// Pinned for the same reason as MONGODB_URI above: whoever runs the tests may have a deployed
// server's URLs in their own server/.env, and dotenv would fill these in from it.
process.env.GOOGLE_LOGIN_REDIRECT_URI = 'http://localhost:5001/api/auth/google/callback';
process.env.GOOGLE_DRIVE_REDIRECT_URI = 'http://localhost:5001/api/auth/google/connect-drive/callback';
process.env.GMAIL_SEND_REDIRECT_URI = 'http://localhost:5001/api/auth/google/connect-gmail/callback';
process.env.SYNOPSIS_FOLDER_ID = 'test-synopsis-folder';
process.env.GEMINI_API_KEY = '';
