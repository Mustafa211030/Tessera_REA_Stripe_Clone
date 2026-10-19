import { useState } from 'react';
import { dash, setCsrf } from '../lib.tsx';
import { ErrorNote, Field } from '../ui.tsx';

export function AuthPage({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ email: '', password: '', business_name: '' });
  const [error, setError] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await dash<{ csrf: string }>('POST', '/login/2fa', { mfa_token: mfa, code });
      setCsrf(r.csrf);
      onDone();
    } catch (err: any) {
      setError(err);
      if (err?.body?.error?.code === 'mfa_challenge_expired') { setMfa(null); setCode(''); }
    } finally { setBusy(false); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await dash<{ csrf: string; mfa_required?: boolean; mfa_token?: string }>('POST', mode === 'login' ? '/login' : '/signup', form);
      if (r.mfa_required) { setMfa(r.mfa_token!); setCode(''); return; }
      setCsrf(r.csrf);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card stack">
        <div className="row" style={{ justifyContent: 'center', gap: 10 }}>
          <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--color-brand)" /><path d="M9 9h6v6H9zM17 9h6v6h-6zM9 17h6v6H9z" fill="var(--color-on-brand)" /><path d="M17 17h6v6h-6z" fill="var(--color-on-brand)" opacity=".5" /></svg>
          <span style={{ fontSize: 22, fontWeight: 600 }}>Tessera</span>
        </div>
        {mfa ? (
          <form className="card card-body form-grid" onSubmit={verify} style={{ padding: 28 }}>
            <h2>Two-step authentication</h2>
            <p className="soft" style={{ margin: 0 }}>{useBackup ? 'Enter one of the backup codes you saved when you turned on two-step authentication. Each code works once.' : 'Enter the 6-digit code from your authenticator app.'}</p>
            <ErrorNote error={error} />
            <Field label={useBackup ? 'Backup code' : 'Authentication code'}>
              <input className="input" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus autoComplete="one-time-code" inputMode={useBackup ? 'text' : 'numeric'} maxLength={useBackup ? 20 : 6} placeholder={useBackup ? 'abc123-def456' : '123456'} />
            </Field>
            <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Checking…' : 'Verify'}</button>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <a href="#" onClick={(e) => { e.preventDefault(); setUseBackup(!useBackup); setCode(''); setError(null); }}>{useBackup ? 'Use authenticator app' : 'Use a backup code'}</a>
              <a href="#" onClick={(e) => { e.preventDefault(); setMfa(null); setError(null); }}>Start over</a>
            </div>
          </form>
        ) : (
        <form className="card card-body form-grid" onSubmit={submit} style={{ padding: 28 }}>
          <h2>{mode === 'login' ? 'Sign in to your account' : 'Create your test account'}</h2>
          <ErrorNote error={error} />
          {mode === 'signup' && (
            <Field label="Business name"><input className="input" value={form.business_name} onChange={set('business_name')} required autoComplete="organization" /></Field>
          )}
          <Field label="Email"><input className="input" type="email" value={form.email} onChange={set('email')} required autoComplete="email" /></Field>
          <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters.' : undefined}>
            <input className="input" type="password" value={form.password} onChange={set('password')} required minLength={mode === 'signup' ? 8 : undefined} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </Field>
          <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
          <p className="soft" style={{ textAlign: 'center' }}>
            {mode === 'login' ? 'New here? ' : 'Already have an account? '}
            <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'login' ? 'signup' : 'login'); setError(null); }}>{mode === 'login' ? 'Create an account' : 'Sign in'}</a>
          </p>
          {mode === 'login' && <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>Demo login after <code>npm run seed</code>: demo@tessera.local / tessera-demo</p>}
        </form>
        )}
      </div>
    </div>
  );
}
