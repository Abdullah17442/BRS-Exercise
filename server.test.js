const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const server = require('./server');
const { createApp, HOLD_MS } = server;

const SECRET = 'test-secret';
const START = new Date('2026-05-01T09:00:00.000Z');
const TEST_COPIES = [
  { id: 'ita-1', bookId: 'intro-to-algorithms', status: 'AVAILABLE' },
  { id: 'cc-1', bookId: 'clean-code', status: 'AVAILABLE' },
  { id: 'cc-2', bookId: 'clean-code', status: 'AVAILABLE' },
  { id: 'sicp-1', bookId: 'sicp', status: 'AVAILABLE' },
  { id: 'ddia-1', bookId: 'ddia', status: 'AVAILABLE' },
];

test('exports an Express request handler for Vercel', () => {
  assert.equal(typeof server, 'function');
  assert.equal(typeof server.listen, 'function');
});

// Fresh app per test, with a clock the test can move forward.
function setup({ enabled = true, copies = TEST_COPIES } = {}) {
  let current = START.getTime();
  const app = createApp({ secret: SECRET, reservationsEnabled: enabled, now: () => new Date(current), copies });
  return {
    app,
    state: app.locals.state,
    advance: (ms) => { current += ms; },
    borrow: (studentId, body, { token } = {}) => {
      const req = request(app).post('/api/reservations');
      const t = token !== undefined ? token : jwt.sign({ sub: studentId }, SECRET);
      if (t) req.set('Authorization', `Bearer ${t}`);
      return req.send(body);
    },
  };
}

// ---------- Acceptance criteria ----------

test('AC1: an available copy is held for the student for exactly 24 hours', async () => {
  const { borrow } = setup();
  const res = await borrow('s1', { bookId: 'intro-to-algorithms' });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'RESERVED');
  assert.equal(res.body.availabilityStatus, 'AVAILABLE');
  assert.equal(res.body.message, 'You can collect the book.');
  assert.equal(res.body.reservation.copyId, 'ita-1');
  assert.equal(res.body.reservation.expiresAt, new Date(START.getTime() + HOLD_MS).toISOString());
});

test('AC2: with no copies available the student joins the waitlist and sees their position', async () => {
  const { borrow } = setup();
  await borrow('s1', { bookId: 'intro-to-algorithms' });
  const s2 = await borrow('s2', { bookId: 'intro-to-algorithms' });
  const s3 = await borrow('s3', { bookId: 'intro-to-algorithms' });
  assert.equal(s2.status, 202);
  assert.equal(s2.body.status, 'WAITLISTED');
  assert.equal(s2.body.availabilityStatus, 'UNAVAILABLE');
  assert.equal(s2.body.message, 'Waiting for availability of the book.');
  assert.equal(s2.body.waitlist.position, 1);
  assert.equal(s3.body.waitlist.position, 2);
});

test('AC3: a fourth reservation is rejected with a clear reason', async () => {
  const { borrow } = setup();
  for (const bookId of ['intro-to-algorithms', 'sicp', 'ddia']) {
    assert.equal((await borrow('s1', { bookId })).status, 201);
  }
  const fourth = await borrow('s1', { bookId: 'clean-code' });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error.code, 'RESERVATION_LIMIT_REACHED');
  assert.match(fourth.body.error.message, /3 active reservations/);
});

test('AC4: an uncollected copy passes to the first waitlisted student after 24 hours', async () => {
  const { borrow, advance, state } = setup();
  await borrow('s1', { bookId: 'intro-to-algorithms' });
  await borrow('s2', { bookId: 'intro-to-algorithms' });
  advance(HOLD_MS);
  const s1Again = await borrow('s1', { bookId: 'intro-to-algorithms' }); // triggers expiry
  assert.equal(s1Again.status, 202); // s1 lost the hold and is now in the queue
  const s2Hold = state.reservations.find((r) => r.studentId === 's2');
  assert.equal(s2Hold.status, 'ACTIVE');
  assert.equal(s2Hold.copyId, 'ita-1');
});

test('AC5 / ENG-6.1: a student cannot act as another student by sending a studentId', async () => {
  const { borrow, state } = setup();
  const res = await borrow('s1', { bookId: 'intro-to-algorithms', studentId: 'victim' });
  assert.equal(res.status, 400);
  assert.equal(state.reservations.length, 0); // nothing changed
});

// ---------- Expiry and waitlist ----------

test('a hold is still active 1 ms before 24 hours', async () => {
  const { borrow, advance, state } = setup();
  await borrow('s1', { bookId: 'intro-to-algorithms' });
  advance(HOLD_MS - 1);
  await borrow('s9', { bookId: 'clean-code' });
  assert.equal(state.reservations[0].status, 'ACTIVE');
});

test('an expired copy becomes AVAILABLE again when nobody is waiting', async () => {
  const { borrow, advance, state } = setup();
  await borrow('s1', { bookId: 'intro-to-algorithms' });
  advance(HOLD_MS);
  await borrow('s9', { bookId: 'clean-code' });
  assert.equal(state.reservations[0].status, 'EXPIRED');
  assert.equal(state.copies.find((c) => c.id === 'ita-1').status, 'AVAILABLE');
});

test('the promoted student gets a fresh 24 hours from the time of promotion', async () => {
  const { borrow, advance, state } = setup();
  await borrow('s1', { bookId: 'intro-to-algorithms' });
  await borrow('s2', { bookId: 'intro-to-algorithms' });
  advance(30 * 60 * 60 * 1000); // processed 6 hours late
  await borrow('s9', { bookId: 'clean-code' });
  const promoted = state.reservations.find((r) => r.studentId === 's2');
  assert.equal(promoted.expiresAt.getTime(), START.getTime() + 30 * 60 * 60 * 1000 + HOLD_MS);
});

test('waitlist is FIFO: only the first student is promoted, the second keeps waiting', async () => {
  const { borrow, advance, state } = setup();
  await borrow('s1', { bookId: 'intro-to-algorithms' });
  await borrow('s2', { bookId: 'intro-to-algorithms' });
  await borrow('s3', { bookId: 'intro-to-algorithms' });
  advance(HOLD_MS);
  await borrow('s9', { bookId: 'clean-code' });
  assert.equal(state.waitlist.find((w) => w.studentId === 's2').status, 'PROMOTED');
  assert.equal(state.waitlist.find((w) => w.studentId === 's3').status, 'WAITING');
});

test('a waitlisted student already at 3 reservations is skipped but keeps their place', async () => {
  const { borrow, advance, state } = setup();
  await borrow('s1', { bookId: 'intro-to-algorithms' });
  await borrow('s2', { bookId: 'intro-to-algorithms' }); // s2 first in queue
  await borrow('s3', { bookId: 'intro-to-algorithms' }); // s3 second
  advance(60 * 60 * 1000);
  for (const bookId of ['clean-code', 'sicp', 'ddia']) await borrow('s2', { bookId }); // s2 now at 3
  advance(HOLD_MS - 60 * 60 * 1000); // only s1's hold has expired
  await borrow('s9', { bookId: 'clean-code' });
  const holder = state.reservations.find((r) => r.bookId === 'intro-to-algorithms' && r.status === 'ACTIVE');
  assert.equal(holder.studentId, 's3');
  assert.equal(state.waitlist.find((w) => w.studentId === 's2').status, 'WAITING');
});

test('expiry never takes back a copy the walk-in desk has already lent out', async () => {
  const { borrow, advance, state } = setup();
  await borrow('s1', { bookId: 'intro-to-algorithms' });
  await borrow('s2', { bookId: 'intro-to-algorithms' });
  state.copies.find((c) => c.id === 'ita-1').status = 'BORROWED'; // collected at the desk
  advance(HOLD_MS);
  await borrow('s9', { bookId: 'clean-code' });
  assert.equal(state.copies.find((c) => c.id === 'ita-1').status, 'BORROWED');
  assert.equal(state.waitlist.find((w) => w.studentId === 's2').status, 'WAITING');
});

test('the same student cannot reserve or queue for the same book twice', async () => {
  const { borrow } = setup();
  await borrow('s1', { bookId: 'intro-to-algorithms' });
  const again = await borrow('s1', { bookId: 'intro-to-algorithms' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_REQUESTED');
  await borrow('s2', { bookId: 'intro-to-algorithms' });
  assert.equal((await borrow('s2', { bookId: 'intro-to-algorithms' })).status, 409);
});

// ---------- Concurrency ----------

test('two simultaneous requests for the last copy: one reserved, one waitlisted', async () => {
  const { borrow } = setup();
  const results = await Promise.all([
    borrow('s1', { bookId: 'intro-to-algorithms' }),
    borrow('s2', { bookId: 'intro-to-algorithms' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 202]);
});

test('simultaneous requests cannot bypass the 3-reservation limit', async () => {
  const { borrow } = setup();
  await borrow('s1', { bookId: 'intro-to-algorithms' });
  await borrow('s1', { bookId: 'sicp' });
  const results = await Promise.all([
    borrow('s1', { bookId: 'ddia' }),
    borrow('s1', { bookId: 'clean-code' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});

// ---------- Security and input validation ----------

test('requests without a token, with a garbage token, or a forged token are rejected', async () => {
  const { borrow } = setup();
  const body = { bookId: 'intro-to-algorithms' };
  assert.equal((await borrow('s1', body, { token: null })).status, 401);
  assert.equal((await borrow('s1', body, { token: 'not-a-jwt' })).status, 401);
  const forged = jwt.sign({ sub: 's1' }, 'attacker-secret');
  assert.equal((await borrow('s1', body, { token: forged })).status, 401);
});

test('each kind of bad token gets 401 with a reason that says what is wrong', async () => {
  const { borrow } = setup();
  const body = { bookId: 'intro-to-algorithms' };
  const cases = [
    [null, /missing/i],
    ['not-a-jwt', /malformed/i],
    [jwt.sign({ sub: 's1' }, 'attacker-secret'), /signature/i],
    [jwt.sign({ sub: 's1', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET), /expired/i],
    [jwt.sign({ name: 'no sub claim' }, SECRET), /sub/],
    [jwt.sign({ sub: 's1' }, SECRET, { algorithm: 'HS512' }), /algorithm|signature/i],
  ];
  for (const [token, reason] of cases) {
    const res = await borrow('s1', body, { token });
    assert.equal(res.status, 401, `token ${token}`);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    assert.match(res.body.error.message, reason);
  }
});

test('Authorization header parsing tolerates a lowercase scheme and extra spaces', async () => {
  const { app } = setup();
  const token = jwt.sign({ sub: 's1' }, SECRET);
  for (const header of [`bearer ${token}`, `Bearer   ${token}  `]) {
    const res = await request(app)
      .post('/api/reservations')
      .set('Authorization', header)
      .send({ bookId: 'clean-code' });
    assert.notEqual(res.status, 401, header);
  }
});

test('a doubled "Bearer Bearer" prefix is explained, not silently rejected', async () => {
  const { app } = setup();
  const res = await request(app)
    .post('/api/reservations')
    .set('Authorization', `Bearer Bearer ${jwt.sign({ sub: 's1' }, SECRET)}`)
    .send({ bookId: 'clean-code' });
  assert.equal(res.status, 401);
  assert.match(res.body.error.message, /Bearer.*twice|only the token/i);
});

test('generate-token.js produces a token the server accepts', async () => {
  const { generateToken } = require('./generate-token');
  const { borrow } = setup();
  const token = generateToken({ secret: SECRET, studentId: 'student-001' });
  const res = await borrow(null, { bookId: 'intro-to-algorithms' }, { token });
  assert.equal(res.status, 201);
  assert.equal(jwt.decode(token).sub, 'student-001');
});

test('reservation ownership comes from the token', async () => {
  const { borrow, state } = setup();
  await borrow('alice', { bookId: 'intro-to-algorithms' });
  assert.equal(state.reservations[0].studentId, 'alice');
});

test('invalid bookId values are rejected; unknown books return 404', async () => {
  const { borrow } = setup();
  assert.equal((await borrow('s1', {})).status, 400);
  assert.equal((await borrow('s1', { bookId: 42 })).status, 400);
  assert.equal((await borrow('s1', { bookId: '../etc/passwd' })).status, 400);
  assert.equal((await borrow('s1', [])).status, 400);
  const unknown = await borrow('s1', { bookId: 'no-such-book' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'BOOK_NOT_FOUND');
});

test('malformed JSON returns 400, not a server error', async () => {
  const { app } = setup();
  const res = await request(app)
    .post('/api/reservations')
    .set('Authorization', `Bearer ${jwt.sign({ sub: 's1' }, SECRET)}`)
    .set('Content-Type', 'application/json')
    .send('{"bookId":');
  assert.equal(res.status, 400);
});

test('the app refuses to start without a JWT secret', () => {
  assert.throws(() => createApp({ secret: '' }), /JWT_SECRET/);
});

// ---------- Feature toggle ----------

test('when online reservations are switched off, returns 503 and changes nothing', async () => {
  const { borrow, state } = setup({ enabled: false });
  const res = await borrow('s1', { bookId: 'intro-to-algorithms' });
  assert.equal(res.status, 503);
  assert.match(res.body.error.message, /walk-in/i);
  assert.equal(state.copies.find((c) => c.id === 'ita-1').status, 'AVAILABLE');
});
