// Fake-secret corpus for the redaction and scanner tests. Values are assembled at runtime so no secret-shaped literal
// sits in the repo (keeps GitHub push protection quiet). None of these are real credentials.
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
export const jwt = payload => b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u(payload) + '.' + 'Zm9vYmFyYmF6cXV4' + 'X1y2Z3w4V5u6';

export const CORPUS = {
  aws: 'AK' + 'IA' + 'IOSFODNN7EXAMPLE',
  awsSecret: 'wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYEXAMPLEKEY',
  stripe: 'sk_' + 'live_' + 'a1B2c3D4'.repeat(3),
  supabaseService: jwt({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'service' + '_role', iat: 1700000000, exp: 2000000000 }),
  supabaseAnon: jwt({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'anon', iat: 1700000000, exp: 2000000000 }),
  openai: 'sk-' + 'proj-' + 'Ab3dE9'.repeat(8),
  github: 'gh' + 'p_' + 'A1b2C3d4E5'.repeat(4),
  privateKey: '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\nKUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==\n-----END ' + 'RSA PRIVATE KEY-----',
};
