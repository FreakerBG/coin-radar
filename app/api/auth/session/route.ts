// Tells the browser whether this request is signed in, and where to go to sign in if it is not.
// Without this the Vercel deployment had no way to reach app/login/page.tsx at all: nothing linked to
// it, nothing redirected to it, and every data route just answered 401 "Sign in required." to a
// visitor with no sign-in affordance anywhere on the page.
//
// Deliberately says nothing about *who* is signed in - no id, no email, no display name - so the
// response is the same shape for the Sites path and the Vercel owner path and carries no private
// data. Never cached: it is per-request identity.
import { getChatGPTUser, chatGPTSignInPath } from '@/app/chatgpt-auth';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  const returnTo = new URL(request.url).searchParams.get('return_to') ?? '/';
  return Response.json(
    // chatGPTSignInPath() sanitizes return_to; an off-origin or reserved value becomes "/".
    { signedIn: Boolean(user), signInPath: user ? null : chatGPTSignInPath(returnTo) },
    { headers: noStore },
  );
}
