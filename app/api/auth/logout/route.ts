// Clears the owner session cookie (app/owner-auth.ts). Same-origin only, like login. Always succeeds
// - there is nothing sensitive in "you are now signed out" - even if no session was ever set.
import { sameOrigin } from '@/lib/research-db';
import { SESSION_COOKIE } from '@/app/owner-auth';

const noStore = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Same-origin request required.' }, { status: 403, headers: noStore });
  const response = Response.json({ ok: true }, { headers: noStore });
  response.headers.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  return response;
}
