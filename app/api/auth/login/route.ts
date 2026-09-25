// Owner-secret login for the Vercel+Turso deployment (app/owner-auth.ts). Same-origin only (CSRF),
// like every other mutating route in this app. Verifies the submitted password against
// OWNER_PASSWORD_HASH and, on success, sets a signed session cookie; never trusts anything the
// client sends about who it is. This never runs on the Sites/Cloudflare path.
import { readJsonObject } from '@/lib/request-body';
import { sameOrigin } from '@/lib/research-db';
import { SESSION_COOKIE, createOwnerSession, verifyOwnerPassword } from '@/app/owner-auth';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Same-origin request required.' }, { status: 403, headers: noStore });
  const body = await readJsonObject(request);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!password) return Response.json({ error: 'Password required.' }, { status: 400, headers: noStore });

  if (!verifyOwnerPassword(password)) {
    return Response.json({ error: 'Incorrect password.' }, { status: 401, headers: noStore });
  }

  const session = createOwnerSession();
  if (!session) {
    // AUTH_SECRET is unset: fail closed rather than issue a cookie nothing can verify.
    return Response.json({ error: 'Sign-in is not configured.' }, { status: 503, headers: noStore });
  }

  const response = Response.json({ ok: true }, { headers: noStore });
  response.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`,
  );
  return response;
}
