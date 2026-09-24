'use client';
import { useEffect, useState } from 'react';
import { LogIn, LogOut } from 'lucide-react';

// The sign-in / sign-out control in the dashboard topbar. Before this, app/login/page.tsx existed but
// nothing on any page linked to it and there was no way to sign out at all, so the Vercel deployment
// was unusable by the one person it is for: every data route answered 401 "Sign in required." and the
// page offered no way to fix that.
//
// State comes from GET /api/auth/session, which reports only whether this request is signed in -
// never who - so nothing identifying is rendered, for an anonymous visitor or a signed-in one.
type Session = { signedIn: boolean; signInPath: string | null };

export default function AuthControl() {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const returnTo = window.location.pathname + window.location.search;
        const response = await fetch('/api/auth/session?return_to=' + encodeURIComponent(returnTo));
        if (!response.ok) return;
        const next = await response.json() as Session;
        if (!cancelled) setSession(next);
      } catch {
        // Leave the control hidden rather than guess at a sign-in state we could not read.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      // A full reload, not a client-side route change: the Goldmine and Advisor panels are holding
      // data fetched as the signed-in owner, and a router navigation would leave it on screen.
      window.location.reload();
    } catch {
      setBusy(false);
    }
  }

  if (!session) return null;
  if (!session.signedIn) {
    return (
      <a className="pill" href={session.signInPath ?? '/login'} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <LogIn size={14} /> Sign in
      </a>
    );
  }
  return (
    <button className="pill" type="button" onClick={() => void signOut()} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
      <LogOut size={14} /> {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
