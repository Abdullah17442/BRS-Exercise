// LOCAL TESTING ONLY. Signs a JWT exactly the way server.js verifies it:
// HS256, signed with JWT_SECRET from .env, student ID in the "sub" claim.
// This stands in for the university login, which the API does not include.
//
// Usage:
//   npm run token                          -> token for student-001, valid 1 hour
//   npm run token -- student-002           -> token for another student
//   npm run token -- student-001 --expired -> already-expired token (to test 401)
//   npm run token -- student-001 --no-sub  -> token without "sub" (to test 401)

const jwt = require('jsonwebtoken');
const { loadDotEnv } = require('./server');

function generateToken({ secret, studentId = 'student-001', expired = false, noSub = false, expiresIn = '1h' }) {
  if (!secret) throw new Error('JWT_SECRET is not set. Copy .env.example to .env and set a secret.');
  const payload = noSub ? { name: 'token without sub' } : { sub: studentId };
  if (expired) {
    return jwt.sign({ ...payload, exp: Math.floor(Date.now() / 1000) - 60 }, secret, { algorithm: 'HS256' });
  }
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn });
}

module.exports = { generateToken };

if (require.main === module) {
  if (process.env.NODE_ENV === 'production') {
    console.error('generate-token.js is for local testing only and will not run in production.');
    process.exit(1);
  }
  loadDotEnv();
  const args = process.argv.slice(2);
  const studentId = args.find((a) => !a.startsWith('--')) || 'student-001';
  try {
    const token = generateToken({
      secret: process.env.JWT_SECRET,
      studentId,
      expired: args.includes('--expired'),
      noSub: args.includes('--no-sub'),
    });
    console.log(token);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
