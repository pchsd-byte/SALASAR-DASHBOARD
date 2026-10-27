import './helpers/env.js';
import { test, describe, before, after, beforeEach } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app } from '../src/app.js';
import { env, isAllowedLogin, roleFor } from '../src/config/env.js';
import { TeamMember } from '../src/models/TeamMember.js';
import { AccessRequest } from '../src/models/AccessRequest.js';
import { User } from '../src/models/User.js';
import { invalidateAccessCache } from '../src/services/access.service.js';
import { parseDateRange } from '../src/controllers/dashboard.controller.js';
import { assertInsightsShape } from '../src/services/aiInsights.service.js';

// Authorisation now reads the TeamMember collection on every request (an admin grants sections
// from Settings), so these cases need a database. In memory, never the one in server/.env:
// test/helpers/env.js points that at an address nothing listens on.
let server;
let base;
let mongod;
before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'api-tests' });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  // Access is cached for 30 s per address; a test that grants access must not be answered from
  // the previous test's answer.
  invalidateAccessCache();
});

const ORIGIN = 'http://localhost:5173';
const sub = '64b000000000000000000001';
const cookieFor = (email, claims = {}) => `session=${jwt.sign({ sub, email, name: 'Test', role: 'manager', ...claims }, 'test-jwt-secret', { expiresIn: '1h' })}`;
const call = (path, { method = 'GET', cookie, origin = ORIGIN, body, headers = {} } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('configuration', () => {
  test('CLIENT_ORIGIN is normalised (a trailing slash would fail every CORS check)', () => {
    assert.equal(env.clientOrigin, 'http://localhost:5173');
  });

  // SEC-01
  // Every address is named now — there is no domain rule left to admit a colleague nobody added.
  test('the environment admits only the addresses it names', () => {
    assert.equal(isAllowedLogin('owner@gmail.com'), true, 'an admin on a personal address');
    assert.equal(isAllowedLogin('guest@gmail.com'), true, 'listed in ALLOWED_LOGIN_EMAILS');
    assert.equal(isAllowedLogin('pc.hsd@salasartechno.com'), true, 'the mailbox reports are sent from');
    assert.equal(isAllowedLogin('someone@salasartechno.com'), false, 'a work address nobody has added');
    assert.equal(isAllowedLogin('stranger@gmail.com'), false);
    assert.equal(isAllowedLogin('x@salasartechno.com.evil.com'), false);
  });

  test('the role comes from ADMIN_EMAILS, case-insensitively', () => {
    assert.equal(roleFor('ADMIN@salasartechno.com'), 'admin');
    assert.equal(roleFor('someone@salasartechno.com'), 'manager');
  });

  // config/env.js is evaluated once per process, so the Render case runs in a child process
  // (cwd = test/, where there is no .env for dotenv to fill gaps from).
  test('on Render, an unset or localhost OAuth redirect URI is derived from RENDER_EXTERNAL_URL', () => {
    const { status, stdout, stderr } = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { env } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../src/config/env.js', import.meta.url))).href)});
      console.log(JSON.stringify([env.googleLoginRedirectUri, env.googleDriveRedirectUri, env.gmailSendRedirectUri]));
    `], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      env: {
        ...process.env,
        RENDER: 'true',
        RENDER_EXTERNAL_URL: 'https://api.example.onrender.com/',
        GOOGLE_LOGIN_REDIRECT_URI: 'http://localhost:5001/api/auth/google/callback',
        GOOGLE_DRIVE_REDIRECT_URI: 'https://custom.example.com/api/auth/google/connect-drive/callback',
        GMAIL_SEND_REDIRECT_URI: '',
      },
    });
    assert.equal(status, 0, stderr);
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').pop()), [
      'https://api.example.onrender.com/api/auth/google/callback',
      'https://custom.example.com/api/auth/google/connect-drive/callback', // explicit, left alone
      'https://api.example.onrender.com/api/auth/google/connect-gmail/callback',
    ]);
  });

  test('off Render the redirect URIs keep their configured / localhost values', () => {
    assert.equal(env.googleLoginRedirectUri, 'http://localhost:5001/api/auth/google/callback');
  });
});

describe('authentication and authorization', () => {
  test('no cookie → 401', async () => {
    assert.equal((await call('/sync/status')).status, 401);
  });

  test('alg:none, forged and expired tokens → 401', async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub, email: 'admin@salasartechno.com', role: 'admin' })}.`;
    const forged = jwt.sign({ sub, email: 'admin@salasartechno.com', role: 'admin' }, 'dev-only-change-me');
    const expired = jwt.sign({ sub, email: 'admin@salasartechno.com', role: 'admin', exp: Math.floor(Date.now() / 1000) - 5 }, 'test-jwt-secret');
    for (const token of [none, forged, expired]) {
      assert.equal((await call('/sync/status', { cookie: `session=${token}` })).status, 401);
    }
  });

  // SEC-01: a valid session for an account outside the list is refused on every request.
  test('a signed-in account outside the allowed list → 403', async () => {
    assert.equal((await call('/sync/status', { cookie: cookieFor('stranger@gmail.com') })).status, 403);
  });

  // SEC-07: the role claim in the token is ignored; the current configuration decides.
  test('a manager whose token claims admin is still refused admin routes', async () => {
    const res = await call('/sync/run', { method: 'POST', cookie: cookieFor('someone@salasartechno.com', { role: 'admin' }) });
    assert.equal(res.status, 403);
  });

  test('a manager cannot reach the email routes', async () => {
    assert.equal((await call('/email/scheduled', { cookie: cookieFor('someone@salasartechno.com') })).status, 403);
  });
});

describe('request hardening', () => {
  // SEC-04
  test('a state-changing request from another site is refused before it reaches the route', async () => {
    const res = await call('/auth/google/disconnect-drive', { method: 'POST', cookie: cookieFor('admin@salasartechno.com'), origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /Cross-site/);
  });

  // REL-01: the error reaches the error handler as a 400 and the process keeps serving.
  test('an invalid date is a 400, and the server is still up afterwards', async () => {
    // An account that actually has the dashboard — an un-added address is refused at the door
    // now, long before anything looks at the query string.
    const cookie = cookieFor('admin@salasartechno.com');
    for (const q of ['from=garbage', 'from=2026-02-30', 'from=2026-03-02&to=2026-03-01', 'businessUnit=XYZ']) {
      const res = await call(`/dashboard/hsd/summary?${q}`, { cookie });
      assert.equal(res.status, 400, q);
    }
    assert.equal((await call('/health')).status, 200);
  });

  test('a malformed scheduled-email id is a 404, not a crash', async () => {
    const res = await call('/email/scheduled/not-an-object-id', { method: 'DELETE', cookie: cookieFor('pc.hsd@salasartechno.com') });
    assert.equal(res.status, 404);
    assert.equal((await call('/health')).status, 200);
  });

  test('malformed JSON is a 400, not a 500', async () => {
    const res = await call('/targets', { method: 'POST', cookie: cookieFor('admin@salasartechno.com'), body: '{"client": ' });
    assert.equal(res.status, 400);
  });

  // SEC-05: the 20 MB email parser only runs for the authorised sender.
  test('an unauthenticated large POST to the email routes is refused without being accepted', async () => {
    const res = await call('/email/send', { method: 'POST', body: { bodyHtml: 'x'.repeat(2_000_000) } });
    assert.equal(res.status, 401);
  });

  test('the ordinary body limit still applies elsewhere', async () => {
    const res = await call('/targets', { method: 'POST', cookie: cookieFor('admin@salasartechno.com'), body: { client: 'x'.repeat(200_000), qty: 1 } });
    assert.equal(res.status, 413);
  });
});

describe('dates and AI output', () => {
  // DA-16: 20:00 UTC on 13 Sep is 01:30 IST on 14 Sep.
  test('"today" is the IST calendar day', () => {
    const realNow = Date.now;
    Date.now = () => Date.parse('2026-09-13T20:00:00Z');
    try {
      const { from, to } = parseDateRange({});
      assert.equal(to.toISOString(), '2026-09-14T23:59:59.999Z');
      assert.equal(from.toISOString(), '2026-08-16T00:00:00.000Z');
    } finally {
      Date.now = realNow;
    }
  });

  test('a range covers whole days, inclusive', () => {
    const { from, to } = parseDateRange({ from: '2026-02-01', to: '2026-02-28' });
    assert.equal(from.toISOString(), '2026-02-01T00:00:00.000Z');
    assert.equal(to.toISOString(), '2026-02-28T23:59:59.999Z');
  });

  // REL-11: a reply missing `insights` used to be cached for a day and crash the dashboard.
  test('AI output that does not match the panel shape is refused', () => {
    assert.throws(() => assertInsightsShape({ headline: 'h', narrative: 'n', recommendations: [] }), /expected shape/);
    assert.throws(() => assertInsightsShape({ headline: 'h', narrative: 'n', insights: [{ title: 't', detail: 'd', severity: 'panic' }], recommendations: [] }));
    const ok = assertInsightsShape({ headline: 'h', narrative: 'n', insights: [{ title: 't', detail: 'd', severity: 'good', extra: 1 }], recommendations: ['r'] });
    assert.deepEqual(ok.insights[0], { title: 't', detail: 'd', severity: 'good' });
  });
});

// --- people and access ------------------------------------------------------------------------
// Access used to be three environment variables, one of which named the single person allowed
// near the Email page. The plant has several process coordinators, so an admin now grants
// sections per address from Settings. ADMIN_EMAILS still wins, as the way back in.

describe('people and access', () => {
  const admin = () => cookieFor('admin@salasartechno.com');
  const addMember = (member) => TeamMember.create({ role: 'manager', sections: [], active: true, ...member });

  test('a colleague sees only the sections they were given', async () => {
    await addMember({ email: 'coordinator@salasartechno.com', title: 'Process Coordinator — HSD', sections: ['email'] });
    const cookie = cookieFor('coordinator@salasartechno.com');

    assert.equal((await call('/email/scheduled', { cookie })).status, 200, 'the Email section they were given');
    assert.equal((await call('/dashboard/hsd/summary', { cookie })).status, 403, 'the figures they were not');
    assert.equal((await call('/users', { cookie })).status, 403, 'and never this page');
  });

  test('a second coordinator can be added without touching the server config', async () => {
    const res = await call('/users', {
      method: 'POST',
      cookie: admin(),
      body: { email: 'PC.Unit2@salasartechno.com', name: 'Unit 2 PC', title: 'Process Coordinator — Unit 2', sections: ['email', 'dashboard'] },
    });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.email, 'pc.unit2@salasartechno.com', 'addresses are stored lower-case');
    assert.deepEqual(created.sections, ['dashboard', 'email'], 'and in a canonical order');

    const cookie = cookieFor('pc.unit2@salasartechno.com');
    assert.equal((await call('/email/scheduled', { cookie })).status, 200);
    assert.equal((await call('/dashboard/hsd/summary?from=2026-09-01&to=2026-09-02', { cookie })).status, 200);
  });

  test('the role, sections and designation survive a round trip to the people list', async () => {
    await call('/users', { method: 'POST', cookie: admin(), body: { email: 'pc3@salasartechno.com', title: 'Process Coordinator — Paint', sections: ['email'] } });
    const list = await (await call('/users', { cookie: admin() })).json();
    const member = list.members.find((m) => m.email === 'pc3@salasartechno.com');
    assert.equal(member.title, 'Process Coordinator — Paint');
    assert.equal(member.role, 'manager');
    assert.deepEqual(member.sections, ['email']);
    assert.deepEqual(list.sections.map((s) => s.key), ['dashboard', 'email', 'settings'], 'the UI reads the section list from the server');
    assert.deepEqual(list.adminSections, ['dashboard', 'settings'], 'and which of them an admin gets without ticking');
  });

  test('changing access takes effect without the person signing in again', async () => {
    await addMember({ email: 'pc4@salasartechno.com', sections: ['email'] });
    const cookie = cookieFor('pc4@salasartechno.com');
    assert.equal((await call('/dashboard/hsd/summary', { cookie })).status, 403);

    const res = await call('/users/pc4@salasartechno.com', { method: 'PATCH', cookie: admin(), body: { sections: ['email', 'dashboard'] } });
    assert.equal(res.status, 200);
    // Same session cookie, no new sign-in.
    assert.equal((await call('/dashboard/hsd/summary?from=2026-09-01&to=2026-09-02', { cookie })).status, 200);
  });

  test('switching someone off blocks them', async () => {
    await addMember({ email: 'leaver@salasartechno.com', sections: ['dashboard'], active: false });
    const res = await call('/dashboard/hsd/summary', { cookie: cookieFor('leaver@salasartechno.com') });
    assert.equal(res.status, 403);
  });

  test('an admin granted here gets the people list and the figures — but not Email', async () => {
    await addMember({ email: 'secondadmin@salasartechno.com', role: 'admin', sections: [] });
    const cookie = cookieFor('secondadmin@salasartechno.com');
    assert.equal((await call('/users', { cookie })).status, 200);
    assert.equal((await call('/dashboard/hsd/summary?from=2026-09-01&to=2026-09-02', { cookie })).status, 200);
    // The report composer belongs to the coordinators who write the reports, not to whoever
    // administers Drive and the people list.
    assert.equal((await call('/email/scheduled', { cookie })).status, 403);
  });

  test('an admin who does write reports can be ticked for Email', async () => {
    await addMember({ email: 'writingadmin@salasartechno.com', role: 'admin', sections: ['email'] });
    assert.equal((await call('/email/scheduled', { cookie: cookieFor('writingadmin@salasartechno.com') })).status, 200);
  });

  test('ADMIN_EMAILS admins get every section except Email', async () => {
    const cookie = cookieFor('admin@salasartechno.com');
    assert.equal((await call('/dashboard/hsd/summary?from=2026-09-01&to=2026-09-02', { cookie })).status, 200);
    assert.equal((await call('/users', { cookie })).status, 200);
    assert.equal((await call('/email/scheduled', { cookie })).status, 403);
  });

  test('EMAIL_USER keeps Email whatever else is true of them', async () => {
    await addMember({ email: 'pc.hsd@salasartechno.com', role: 'manager', sections: [] });
    assert.equal((await call('/email/scheduled', { cookie: cookieFor('pc.hsd@salasartechno.com') })).status, 200);
  });

  test('ADMIN_EMAILS wins and cannot be edited away from here', async () => {
    await addMember({ email: 'admin@salasartechno.com', role: 'manager', sections: [] });
    // The row says manager; the environment says admin, and the environment is the lock-out guard.
    assert.equal((await call('/users', { cookie: admin() })).status, 200);

    const refused = await call('/users/admin@salasartechno.com', { method: 'PATCH', cookie: admin(), body: { role: 'manager' } });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /ADMIN_EMAILS/);
    assert.equal((await call('/users/admin@salasartechno.com', { method: 'DELETE', cookie: admin() })).status, 400);
  });

  test('bad input is refused with a reason', async () => {
    const cases = [
      [{ email: 'not-an-email' }, /valid email/],
      [{ email: 'x@salasartechno.com', sections: ['payroll'] }, /Unknown section/],
      [{ email: 'x@salasartechno.com', role: 'superuser' }, /Role must be/],
    ];
    for (const [body, expected] of cases) {
      const res = await call('/users', { method: 'POST', cookie: admin(), body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json()).error, expected);
    }

    await call('/users', { method: 'POST', cookie: admin(), body: { email: 'dupe@salasartechno.com' } });
    const again = await call('/users', { method: 'POST', cookie: admin(), body: { email: 'dupe@salasartechno.com' } });
    assert.equal(again.status, 400);
    assert.match((await again.json()).error, /already on the list/);
  });

  test('removing someone takes their access away', async () => {
    await addMember({ email: 'gone@salasartechno.com', sections: ['email'] });
    assert.equal((await call('/email/scheduled', { cookie: cookieFor('gone@salasartechno.com') })).status, 200);

    assert.equal((await call('/users/gone@salasartechno.com', { method: 'DELETE', cookie: admin() })).status, 200);
    // Removed means removed: not a lesser section, no access to anything at all.
    assert.equal((await call('/email/scheduled', { cookie: cookieFor('gone@salasartechno.com') })).status, 403);
    assert.equal((await call('/dashboard/hsd/summary', { cookie: cookieFor('gone@salasartechno.com') })).status, 403);
  });

  test('/auth/me reports the sections and designation the UI draws itself from', async () => {
    await addMember({ email: 'pc5@salasartechno.com', title: 'Process Coordinator — Fab', sections: ['email'] });
    const stored = await User.create({ googleId: 'g-pc5', email: 'pc5@salasartechno.com', name: 'PC Five', role: 'manager' });
    const me = await (await call('/auth/me', { cookie: cookieFor('pc5@salasartechno.com', { sub: stored._id.toString() }) })).json();

    assert.deepEqual(me.sections, ['email']);
    assert.equal(me.title, 'Process Coordinator — Fab');
    assert.equal(me.role, 'manager');
    assert.equal(me.emailSender, 'pc.hsd@salasartechno.com', 'the From line comes from the server, not a hard-coded constant');
  });
});

// --- the closed door --------------------------------------------------------------------------
// Signing in with Google proves who you are; it grants nothing here. Only ADMIN_EMAILS, the
// explicit environment grants, and the people an admin has added get past this.

describe('nobody gets in unnamed', () => {
  const admin = () => cookieFor('admin@salasartechno.com');

  test('a personal Google account with a valid session reaches nothing', async () => {
    const cookie = cookieFor('someone.random@gmail.com');
    for (const path of ['/dashboard/hsd/summary', '/dashboard/synopsis', '/email/scheduled', '/sync/status', '/users', '/targets']) {
      assert.equal((await call(path, { cookie })).status, 403, path);
    }
  });

  test('a work address nobody has added is refused too — there is no domain rule left', async () => {
    const cookie = cookieFor('newjoiner@salasartechno.com');
    assert.equal((await call('/dashboard/hsd/summary', { cookie })).status, 403);
    assert.equal((await call('/sync/status', { cookie })).status, 403);
  });

  test('the same address works the moment an admin adds it', async () => {
    const cookie = cookieFor('newjoiner@salasartechno.com');
    assert.equal((await call('/dashboard/hsd/summary?from=2026-09-01&to=2026-09-02', { cookie })).status, 403);

    await call('/users', { method: 'POST', cookie: admin(), body: { email: 'newjoiner@salasartechno.com', sections: ['dashboard'] } });
    assert.equal((await call('/dashboard/hsd/summary?from=2026-09-01&to=2026-09-02', { cookie })).status, 200);
  });

  test('a refused sign-in becomes a request the admin can see and grant', async () => {
    // What the login callback records when Google hands back an address nobody has added.
    await AccessRequest.create({ email: 'knocking@gmail.com', name: 'Someone Knocking', attempts: 2, reason: 'not_allowed' });

    const list = await (await call('/users', { cookie: admin() })).json();
    assert.equal(list.requests.length, 1);
    assert.deepEqual(
      { email: list.requests[0].email, name: list.requests[0].name, attempts: list.requests[0].attempts },
      { email: 'knocking@gmail.com', name: 'Someone Knocking', attempts: 2 },
    );

    // Granting it is just adding them — and that clears the request.
    await call('/users', { method: 'POST', cookie: admin(), body: { email: 'knocking@gmail.com', sections: ['dashboard'] } });
    const after = await (await call('/users', { cookie: admin() })).json();
    assert.deepEqual(after.requests, [], 'no longer waiting');
    assert.ok(after.members.some((m) => m.email === 'knocking@gmail.com'), 'on the list instead');
    assert.equal(await AccessRequest.countDocuments({ email: 'knocking@gmail.com' }), 0);
  });

  test('a request can be dismissed without granting anything', async () => {
    await AccessRequest.create({ email: 'stranger@gmail.com', attempts: 1 });
    assert.equal((await call('/users/requests/stranger@gmail.com', { method: 'DELETE', cookie: admin() })).status, 200);

    const list = await (await call('/users', { cookie: admin() })).json();
    assert.deepEqual(list.requests, []);
    assert.equal((await call('/dashboard/hsd/summary', { cookie: cookieFor('stranger@gmail.com') })).status, 403, 'still refused');

    const again = await call('/users/requests/stranger@gmail.com', { method: 'DELETE', cookie: admin() });
    assert.equal(again.status, 400, 'and dismissing a request that is not there says so');
  });

  test('only an admin sees or clears the queue', async () => {
    await AccessRequest.create({ email: 'knocking@gmail.com', attempts: 1 });
    await TeamMember.create({ email: 'manager@salasartechno.com', role: 'manager', sections: ['dashboard'], active: true });
    const cookie = cookieFor('manager@salasartechno.com');
    assert.equal((await call('/users', { cookie })).status, 403);
    assert.equal((await call('/users/requests/knocking@gmail.com', { method: 'DELETE', cookie })).status, 403);
  });

  test('somebody already on the list is not also shown as waiting', async () => {
    await TeamMember.create({ email: 'both@salasartechno.com', role: 'manager', sections: ['dashboard'], active: true });
    await AccessRequest.create({ email: 'both@salasartechno.com', attempts: 1 });
    const list = await (await call('/users', { cookie: admin() })).json();
    assert.deepEqual(list.requests, []);
  });
});

// --- your own profile ---------------------------------------------------------------------------
// The Profile page tells somebody what their account is and what it may open, and lets them change
// their own picture. Everything it shows comes from /auth/me — the same answer the server enforces.

describe('profile and avatar', () => {
  // Somebody who is both on the access list and has signed in before — the only state in which
  // the Profile page exists at all. A User row alone is not access: requireAuth asks
  // resolveAccess, and an address nobody added is refused at the door.
  const signedIn = async (email, { sections = ['dashboard'], title, ...extra } = {}) => {
    await TeamMember.create({ email, role: 'manager', sections, title, active: true });
    invalidateAccessCache();
    const stored = await User.create({ googleId: `g-${email}`, email, name: 'Test Person', picture: 'https://lh3.google/photo', role: 'manager', ...extra });
    return { cookie: cookieFor(email, { sub: stored._id.toString() }), stored };
  };

  test('/auth/me carries everything the page draws itself from', async () => {
    const { cookie } = await signedIn('pc9@salasartechno.com', { sections: ['email'], title: 'Process Coordinator — Paint', lastLoginAt: new Date('2026-10-20T06:30:00Z') });

    const me = await (await call('/auth/me', { cookie })).json();
    assert.equal(me.role, 'manager');
    assert.equal(me.title, 'Process Coordinator — Paint');
    assert.deepEqual(me.sections, ['email']);
    assert.deepEqual(me.avatar, { kind: 'google', colorIndex: 0, dataUrl: null }, 'the Google photo until they choose otherwise');
    assert.ok(me.lastLoginAt, 'and when they were last here');
  });

  test('a person can set initials, upload a picture, and go back to Google', async () => {
    const { cookie } = await signedIn('chooser@salasartechno.com');

    let res = await call('/auth/me/avatar', { method: 'PATCH', cookie, body: { kind: 'initials', colorIndex: 5 } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).avatar, { kind: 'initials', colorIndex: 5, dataUrl: null });

    const tiny = `data:image/jpeg;base64,${Buffer.from('not really a jpeg but small').toString('base64')}`;
    res = await call('/auth/me/avatar', { method: 'PATCH', cookie, body: { kind: 'photo', dataUrl: tiny } });
    assert.equal(res.status, 200);
    assert.equal((await (await call('/auth/me', { cookie })).json()).avatar.dataUrl, tiny, 'and it comes back with /auth/me');

    res = await call('/auth/me/avatar', { method: 'PATCH', cookie, body: { kind: 'google' } });
    assert.deepEqual((await res.json()).avatar, { kind: 'google', colorIndex: 0, dataUrl: null }, 'choosing Google clears the stored picture');
  });

  test('a picture too large for a payload sent on every page load is refused', async () => {
    const { cookie } = await signedIn('big@salasartechno.com');
    const huge = `data:image/png;base64,${'A'.repeat(90 * 1024)}`;
    const res = await call('/auth/me/avatar', { method: 'PATCH', cookie, body: { kind: 'photo', dataUrl: huge } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /over the 48 KB limit/);
  });

  test('nonsense is refused rather than stored', async () => {
    const { cookie } = await signedIn('odd@salasartechno.com');
    const cases = [
      [{ kind: 'badge' }, /Choose a Google photo/],
      [{ kind: 'initials', colorIndex: 99 }, /Pick one of the available colours/],
      [{ kind: 'photo', dataUrl: 'https://example.com/me.png' }, /could not be read/],
      [{ kind: 'photo', dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' }, /could not be read/],
    ];
    for (const [body, expected] of cases) {
      const res = await call('/auth/me/avatar', { method: 'PATCH', cookie, body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json()).error, expected);
    }
  });

  test('it is always your own account — the session decides, not the request', async () => {
    const mine = await signedIn('mine@salasartechno.com');
    const theirs = await signedIn('theirs@salasartechno.com');

    await call('/auth/me/avatar', { method: 'PATCH', cookie: mine.cookie, body: { kind: 'initials', colorIndex: 3, email: 'theirs@salasartechno.com', _id: theirs.stored._id.toString() } });

    assert.equal((await User.findById(mine.stored._id)).avatar.colorIndex, 3);
    assert.equal((await User.findById(theirs.stored._id)).avatar.kind, 'google', 'the other account is untouched');
  });

  test('signing out is required to change anybody else — the endpoint needs a session', async () => {
    assert.equal((await call('/auth/me/avatar', { method: 'PATCH', body: { kind: 'google' } })).status, 401);
  });
});
