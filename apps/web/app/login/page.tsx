'use client';

import { createBrowserClient } from '@supabase/ssr';
import { useState } from 'react';

/**
 * Magic-link sign-in. No password to store, lose, or leak.
 *
 * The response is deliberately identical whether or not the address belongs to
 * a known user: telling a stranger "no account with that email" turns the login
 * form into a membership oracle.
 */
export default function Login() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const redirect = `${window.location.origin}/auth/callback`;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirect },
    });
    if (error) {
      // The on-screen text stays generic, but the real reason goes to the
      // console. This leaks nothing: signInWithOtp is a browser-to-Supabase
      // call, so the same message is already sitting in the Network tab for
      // anyone who opens it. Swallowing it here only blinds the operator.
      // The two that actually happen: the redirect URL is not allow-listed in
      // Supabase (common on preview deployments, whose hostname changes every
      // push), and the built-in SMTP hourly cap.
      console.error('[taskos] sign-in failed', {
        message: error.message,
        status: error.status,
        redirect,
        fix: 'Supabase → Authentication → URL Configuration → Redirect URLs must contain this exact redirect.',
      });
    }
    setState(error ? 'error' : 'sent');
  }

  return (
    <main>
      <form className="center" onSubmit={send}>
        <h1>TaskOS</h1>
        <p className="sub">Sign in to see what is going to slip.</p>
        {state === 'sent' ? (
          <p className="dim">
            If that address has an account, a sign-in link is on its way. Check your email.
          </p>
        ) : (
          <>
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" disabled={state === 'sending'}>
              {state === 'sending' ? 'Sending…' : 'Email me a link'}
            </button>
            {state === 'error' && (
              <p className="bad" style={{ fontSize: 13 }}>
                Could not send the link. Try again shortly.
              </p>
            )}
          </>
        )}
      </form>
    </main>
  );
}
