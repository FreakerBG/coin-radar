'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Radar, Lock } from 'lucide-react';

// Owner-secret sign-in for the Vercel+Turso deployment (app/owner-auth.ts). This page only matters
// off Sites: on Sites, Sign in with ChatGPT is handled entirely outside this app (app/chatgpt-auth.ts).
export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        let message = 'Sign-in failed.';
        try {
          const data = await r.json() as { error?: string };
          if (data.error) message = data.error;
        } catch {
          // Not JSON; keep the generic message.
        }
        setError(message);
        return;
      }
      router.push('/');
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell" style={{ maxWidth: 420, paddingTop: 90 }}>
      <div className="brand" style={{ marginBottom: 30, justifyContent: 'center' }}>
        <span className="brand-icon"><Radar size={25} /></span>coin radar
      </div>
      <section className="panel">
        <div className="panel-head">
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
            <Lock size={17} /> Owner sign-in
          </h2>
        </div>
        <form onSubmit={submit} style={{ padding: 22 }}>
          <label style={{ fontSize: 14, color: '#b9c6d2', display: 'block' }}>
            Password
            <input
              type="password"
              autoFocus
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={{
                display: 'block', width: '100%', background: '#0d141b', border: '1px solid #334250',
                borderRadius: 7, color: '#e5edf4', padding: 11, marginTop: 8,
              }}
            />
          </label>
          {error && <div className="banner" role="alert" style={{ marginTop: 18 }}>{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={busy || !password} style={{ marginTop: 20, width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
      <p className="muted" style={{ fontSize: 13, marginTop: 18, textAlign: 'center' }}>
        Single-owner private tool. This deployment holds no shared or public accounts.
      </p>
    </div>
  );
}
