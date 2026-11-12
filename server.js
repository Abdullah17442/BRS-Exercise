// Library Reservation API: one endpoint, POST /api/reservations
// - Copy available  -> held for the student for 24 hours (201 RESERVED)
// - No copy free    -> student joins the FIFO waitlist (202 WAITLISTED, with position)
// - Max 3 active reservations per student; expired holds pass to the next student in the queue.
// Student identity comes ONLY from the JWT (ENG-6.1), never from the request body.

const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');

const HOLD_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE = 3;

const DEFAULT_BOOKS = {
  BOOK001: 'Software Architecture in Practice',
  'intro-to-algorithms': 'Introduction to Algorithms',
  'clean-code': 'Clean Code',
  sicp: 'SICP',
  ddia: 'Designing Data-Intensive Applications',
};
const DEFAULT_COPIES = [
  { id: 'book001-1', bookId: 'BOOK001', status: 'UNAVAILABLE' },
  { id: 'ita-1', bookId: 'intro-to-algorithms', status: 'AVAILABLE' },
  { id: 'cc-1', bookId: 'clean-code', status: 'AVAILABLE' },
  { id: 'cc-2', bookId: 'clean-code', status: 'AVAILABLE' },
  { id: 'sicp-1', bookId: 'sicp', status: 'AVAILABLE' },
  { id: 'ddia-1', bookId: 'ddia', status: 'AVAILABLE' },
];

// Verifies "Authorization: Bearer <JWT>" (HS256, signed with JWT_SECRET, must carry a "sub").
// Returns { studentId } or { error } with a reason the caller can act on.
function authenticate(header, secret) {
  if (!header || !header.trim()) {
    return { error: 'Missing Authorization header. Send: Authorization: Bearer <token>.' };
  }
  if (/^\s*Bearer\s+Bearer\s/i.test(header)) {
    return { error: 'The word "Bearer" appears twice. In Postman\'s Bearer Token field, paste only the token.' };
  }
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return { error: 'Authorization header must look like: Bearer <token>.' };

  let payload;
  try {
    payload = jwt.verify(match[1], secret, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') return { error: 'Token has expired. Generate a new one: npm run token' };
    if (err.message === 'invalid signature') {
      return { error: 'Token signature is invalid: it was not signed with this server\'s JWT_SECRET.' };
    }
    if (err.message === 'invalid algorithm') return { error: 'Token uses an unsupported algorithm. Only HS256 is accepted.' };
    if (/malformed|jwt must be/i.test(err.message)) return { error: 'Token is malformed (not a valid JWT).' };
    return { error: 'Token is invalid.' };
  }
  if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
    return { error: 'Token has no "sub" claim (the student ID).' };
  }
  return { studentId: payload.sub };
}

// Builds a fresh app with its own in-memory data. `now` is injectable so tests can move time.
function createApp({
  secret = process.env.JWT_SECRET,
  reservationsEnabled = process.env.ONLINE_RESERVATIONS_ENABLED !== 'false',
  now = () => new Date(),
  books = DEFAULT_BOOKS,
  copies = DEFAULT_COPIES,
} = {}) {
  if (!secret) throw new Error('JWT_SECRET must be set');

  const state = {
    copies: structuredClone(copies),
    reservations: [], // { id, studentId, bookId, copyId, status: ACTIVE|EXPIRED, expiresAt }
    waitlist: [], // { id, studentId, bookId, status: WAITING|PROMOTED, joinedAt }
  };
  const { reservations, waitlist } = state;

  const activeCount = (studentId) =>
    reservations.filter((r) => r.status === 'ACTIVE' && r.studentId === studentId).length;
  const queueFor = (bookId) => waitlist.filter((w) => w.status === 'WAITING' && w.bookId === bookId);

  // Release holds older than 24h and give the copy to the first eligible waitlisted student.
  // Runs synchronously (no await), so no other request can interleave: this is our "transaction".
  function releaseExpiredHolds(time) {
    for (const r of [...reservations]) {
      if (r.status !== 'ACTIVE' || r.expiresAt > time) continue;
      r.status = 'EXPIRED';
      const copy = state.copies.find((c) => c.id === r.copyId);
      if (copy.status !== 'RESERVED') continue; // walk-in desk already lent it out; not ours
      const next = queueFor(copy.bookId).find((w) => activeCount(w.studentId) < MAX_ACTIVE);
      if (!next) {
        copy.status = 'AVAILABLE';
        continue;
      }
      next.status = 'PROMOTED'; // can never be promoted twice
      reservations.push({
        id: randomUUID(), studentId: next.studentId, bookId: copy.bookId, copyId: copy.id,
        status: 'ACTIVE', expiresAt: new Date(time.getTime() + HOLD_MS),
      });
    }
  }

  const app = express();
  app.locals.state = state; // exposed for tests to inspect
  app.use(express.json({ limit: '10kb' }));
  const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });

  app.post('/api/reservations', (req, res) => {
    if (!reservationsEnabled) {
      return fail(res, 503, 'RESERVATIONS_DISABLED', 'Online reservations are switched off. Walk-in borrowing is unaffected.');
    }

    // Authentication: identity = verified token's "sub" claim, never the request body.
    const auth = authenticate(req.get('Authorization'), secret);
    if (auth.error) return fail(res, 401, 'UNAUTHENTICATED', auth.error);
    const { studentId } = auth;

    // Input validation: only bookId is accepted.
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'INVALID_REQUEST', 'Request body must be a JSON object.');
    }
    const extra = Object.keys(body).filter((k) => k !== 'bookId');
    if (extra.length) {
      return fail(res, 400, 'INVALID_REQUEST', `Unexpected field(s): ${extra.join(', ')}. Your identity comes from your token.`);
    }
    const { bookId } = body;
    if (typeof bookId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(bookId)) {
      return fail(res, 400, 'INVALID_REQUEST', '"bookId" is required (letters, numbers, - and _).');
    }

    const time = now();
    releaseExpiredHolds(time);

    if (!books[bookId]) return fail(res, 404, 'BOOK_NOT_FOUND', `No book with id "${bookId}".`);
    const alreadyHas =
      reservations.some((r) => r.status === 'ACTIVE' && r.studentId === studentId && r.bookId === bookId) ||
      queueFor(bookId).some((w) => w.studentId === studentId);
    if (alreadyHas) return fail(res, 409, 'ALREADY_REQUESTED', 'You already reserved or are queued for this book.');
    if (activeCount(studentId) >= MAX_ACTIVE) {
      return fail(res, 409, 'RESERVATION_LIMIT_REACHED', `You already have ${MAX_ACTIVE} active reservations, which is the maximum.`);
    }

    const copy = state.copies.find((c) => c.bookId === bookId && c.status === 'AVAILABLE');
    if (copy) {
      copy.status = 'RESERVED';
      const reservation = {
        id: randomUUID(), studentId, bookId, copyId: copy.id, status: 'ACTIVE',
        expiresAt: new Date(time.getTime() + HOLD_MS),
      };
      reservations.push(reservation);
      return res.status(201).json({
        status: 'RESERVED',
        availabilityStatus: 'AVAILABLE',
        message: 'You can collect the book.',
        reservation: { id: reservation.id, bookId, copyId: copy.id, expiresAt: reservation.expiresAt.toISOString() },
      });
    }

    const entry = { id: randomUUID(), studentId, bookId, status: 'WAITING', joinedAt: time };
    waitlist.push(entry);
    return res.status(202).json({
      status: 'WAITLISTED',
      availabilityStatus: 'UNAVAILABLE',
      message: 'Waiting for availability of the book.',
      waitlist: { id: entry.id, bookId, position: queueFor(bookId).indexOf(entry) + 1 },
    });
  });

  app.use((req, res) => fail(res, 404, 'NOT_FOUND', 'Route not found.'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    if (err.type === 'entity.too.large') return fail(res, 413, 'INVALID_REQUEST', 'Request body is too large.');
    console.error('Unexpected error:', err.message);
    return fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
  });

  return app;
}

// Loads .env (if present) using Node's built-in loader; no dotenv dependency needed.
// Variables already set in the real environment win over .env.
function loadDotEnv(path = require('node:path').join(__dirname, '.env')) {
  try {
    process.loadEnvFile(path);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { createApp, authenticate, loadDotEnv, HOLD_MS, MAX_ACTIVE };

// Only start listening when run directly (`npm start`), not when imported by tests.
if (require.main === module) {
  loadDotEnv();
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET is not set. Copy .env.example to .env and set a secret.');
    process.exit(1);
  }
  const app = createApp({ secret: process.env.JWT_SECRET });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`API running: POST http://localhost:${port}/api/reservations`);
    console.log(`Online reservations: ${process.env.ONLINE_RESERVATIONS_ENABLED === 'false' ? 'OFF' : 'ON'}`);
    console.log('Books:', Object.keys(DEFAULT_BOOKS).join(', '));
    console.log('Get a test token: npm run token -- student-001');
  });
}
