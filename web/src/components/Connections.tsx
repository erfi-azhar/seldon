// Connections to outside services, managed in Settings.

import { KeyRound, Mail, RefreshCw, Share2 } from 'lucide-react';
import { useState } from 'react';
import type { IntegrationStatus } from '../../../shared/types.ts';
import { useIntegration, useWrite, write } from '../api.ts';
import { timeAgo } from '../lib.ts';
import { Field, Spinner } from './ui.tsx';

export function StatusLine({ status }: { status: IntegrationStatus | undefined }) {
  if (!status) return null;
  if (status.running)
    return (
      <span className="status-line">
        <Spinner /> Checking now…
      </span>
    );
  if (status.lastError)
    return (
      <span className="status-line">
        <i className="status-dot bad" /> <span className="error-text">{status.lastError}</span>
      </span>
    );
  if (status.lastOkAt)
    return (
      <span className="status-line">
        <i className="status-dot ok" /> Last checked {timeAgo(status.lastOkAt)}
      </span>
    );
  return status.configured ? (
    <span className="status-line">
      <i className="status-dot" /> Waiting for the first check
    </span>
  ) : null;
}

export function GmailConnection() {
  const { data: status } = useIntegration('gmail');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [editing, setEditing] = useState(false);
  const save = useWrite(() => write.put('/integrations/gmail', { email: email || String(status?.settings.email ?? ''), ...(password ? { appPassword: password } : {}) }));
  const run = useWrite(() => write.post('/integrations/gmail/run'));
  const disconnect = useWrite(() => write.del('/integrations/gmail'));
  const connected = !!status?.configured;
  const showForm = !connected || editing;

  return (
    <div className="conn-card">
      <div className="conn-head">
        <span className="brain-icon">
          <Mail size={18} />
        </span>
        <div className="grow">
          <b>Gmail</b>
          <span className="hint" style={{ display: 'block' }}>
            {connected ? String(status!.settings.email) : 'Surface important mail and suggest follow-ups'}
          </span>
        </div>
        {connected && !editing && (
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => run.mutate()} disabled={status?.running}>
              <RefreshCw size={13} /> Check now
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => window.confirm('Disconnect Gmail? The app password is deleted from Terminus.') && disconnect.mutate()}>
              Disconnect
            </button>
          </div>
        )}
      </div>
      {connected && <StatusLine status={status} />}

      {showForm && (
        <>
          <ol className="steps-list">
            <li>
              Turn on 2-Step Verification for your Google account, if it isn't already (<code>myaccount.google.com/security</code>).
            </li>
            <li>
              Create an app password at <code>myaccount.google.com/apppasswords</code> — name it "Terminus" — and paste the 16 letters below.
            </li>
            <li>That's it. Terminus reads your inbox every ten minutes, never sends mail, and only saves reply drafts when you ask.</li>
          </ol>
          <div className="field-row">
            <Field label="Gmail address">
              <input className="input" type="email" autoComplete="email" value={email} placeholder={String(status?.settings.email ?? 'you@gmail.com')} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="App password">
              <input className="input" type="password" autoComplete="off" value={password} placeholder={connected ? 'Saved' : 'abcd efgh ijkl mnop'} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
          <div className="row-wrap">
            <button
              type="button"
              className="btn btn-primary"
              disabled={save.isPending || (!email && !connected) || (!password && !connected)}
              onClick={() => save.mutate(undefined, { onSuccess: () => (setEditing(false), setPassword('')) })}
            >
              {save.isPending ? 'Checking…' : connected ? 'Save' : 'Connect Gmail'}
            </button>
            {editing && (
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
          {save.error && <p className="error-text">{save.error.message}</p>}
          <p className="hint">
            Mail is read by your background brain to judge what matters, with no ability to act. With no brain connected, Gmail's own Important label decides. Your app password stays in your Terminus database and is never shown again.
          </p>
        </>
      )}
    </div>
  );
}

export function CaptureSetup() {
  const [token, setToken] = useState<string | null>(null);
  const make = useWrite(() => write.post<{ token: string }>('/capture/token'));
  const origin = typeof location === 'undefined' ? '' : location.origin;
  return (
    <div className="conn-card">
      <div className="conn-head">
        <span className="brain-icon">
          <Share2 size={18} />
        </span>
        <div className="grow">
          <b>Capture from anywhere</b>
          <span className="hint" style={{ display: 'block' }}>
            Send a link or picture from any app; it lands in the Library, read and filed.
          </span>
        </div>
      </div>
      <ol className="steps-list">
        <li>
          <b>Android:</b> install Terminus from your browser's menu (<i>Install app</i>). It then appears in the share sheet of every app.
        </li>
        <li>
          <b>iPhone and Mac:</b> make a Shortcut that shows in the share sheet and accepts URLs, text and images. Add <i>Get Contents of URL</i>: method <code>POST</code>, URL <code>{origin}/api/capture</code>, header <code>Authorization</code> = <code>Bearer</code> + your token, request body <i>Form</i> with a field <code>text</code> set to the Shortcut Input (or a <i>File</i> field <code>file</code> for pictures).
        </li>
        <li>Your phone must be able to reach this Terminus (the same Wi-Fi, or a private network such as Tailscale).</li>
      </ol>
      <div className="row-wrap">
        <button type="button" className="btn" onClick={() => make.mutate(undefined, { onSuccess: (r) => setToken(r.token) })}>
          <KeyRound size={14} /> {token ? 'Make a new token' : 'Create a capture token'}
        </button>
        {token && <code className="token">{token}</code>}
      </div>
      {token && <p className="hint">Copy it now — it is shown once. Making a new one turns the old one off. It can only save things, nothing else.</p>}
    </div>
  );
}
