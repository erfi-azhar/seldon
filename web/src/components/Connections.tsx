// Connections to outside services, managed in Settings.

import { Mail, RefreshCw } from 'lucide-react';
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
