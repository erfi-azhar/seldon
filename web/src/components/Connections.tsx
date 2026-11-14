// Connections to outside services, managed in Settings.

import { useQuery } from '@tanstack/react-query';
import { CalendarDays, KeyRound, Mail, Plug, Plus, RefreshCw, Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { IntegrationStatus, McpServerView } from '../../../shared/types.ts';
import { api, useIntegration, useWrite, write } from '../api.ts';
import { useApp } from '../state.tsx';
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

export function CalendarConnection() {
  const { data: status } = useIntegration('calendar');
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const save = useWrite(() => write.put('/integrations/calendar', { url }));
  const run = useWrite(() => write.post('/integrations/calendar/run'));
  const disconnect = useWrite(() => write.del('/integrations/calendar'));
  const connected = !!status?.configured;
  const showForm = !connected || editing;
  const name = String(status?.settings.name || status?.settings.host || 'Calendar');
  const flights = Number(status?.settings.flights ?? 0);

  return (
    <div className="conn-card">
      <div className="conn-head">
        <span className="brain-icon">
          <CalendarDays size={18} />
        </span>
        <div className="grow">
          <b>Calendar flights</b>
          <span className="hint" style={{ display: 'block' }}>
            {connected ? `${name} · ${flights === 1 ? '1 upcoming flight' : `${flights} upcoming flights`}` : 'Bring in flights from Flighty or any calendar, and keep their times current'}
          </span>
        </div>
        {connected && !editing && (
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => run.mutate()} disabled={status?.running}>
              <RefreshCw size={13} /> Check now
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
              Change
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => window.confirm('Disconnect this calendar? Its link is deleted from Terminus; flights already added stay on your trips.') && disconnect.mutate()}>
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
              In Flighty, turn on calendar export and pick the calendar it writes to. A calendar of its own, such as "Flights", keeps everything else private.
            </li>
            <li>
              Copy that calendar's private address. <b>Google:</b> calendar.google.com → Settings → the calendar → Integrate calendar → <i>Secret address in iCal format</i>. <b>iCloud:</b> in Calendar, share the calendar as a Public Calendar and copy the <code>webcal://</code> link.
            </li>
            <li>Paste it below. Terminus checks it every 15 minutes, files each flight onto the right trip and follows any change in its times.</li>
          </ol>
          <Field label="Private calendar address">
            <input className="input" type="url" autoComplete="off" value={url} placeholder={connected ? 'Saved — paste a new address to replace it' : 'https://calendar.google.com/calendar/ical/…/basic.ics'} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <div className="row-wrap">
            <button type="button" className="btn btn-primary" disabled={save.isPending || !url.trim()} onClick={() => save.mutate(undefined, { onSuccess: () => (setEditing(false), setUrl('')) })}>
              {save.isPending ? 'Checking…' : connected ? 'Save' : 'Connect calendar'}
            </button>
            {editing && (
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
          {save.error && <p className="error-text">{save.error.message}</p>}
          <p className="hint">
            Anyone with this address can read the calendar, so Terminus keeps it with your other secrets and never shows it again. Only flights are read from it. A flight you delete here stays deleted, and one that disappears from the calendar is flagged for you, not removed.
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

/** Tools the server didn't mark safe or destructive wait for the person's OK. */
type McpServer = McpServerView & { unconfirmed?: { name: string; allowed: boolean }[] };

interface McpList {
  servers: McpServer[];
  known: { name: string; url: string; blurb: string }[];
}

function GravlSync() {
  const { data: status } = useIntegration('gravl');
  const toggle = useWrite((enabled: boolean) => write.put('/integrations/gravl', { enabled }));
  const run = useWrite(() => write.post('/integrations/gravl/run'));
  const last = status?.settings.last as { food: number; workouts: number; body: number } | null | undefined;
  return (
    <div className="sync-row">
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={!!status?.enabled} onChange={(e) => toggle.mutate(e.target.checked)} />
        <span>Sync workouts, food and measurements into Health every few hours</span>
      </label>
      {status?.enabled && (
        <div className="row-wrap" style={{ gap: 8 }}>
          <StatusLine status={status} />
          {last && !status.running && !status.lastError && (
            <span className="hint">
              Last brought in {last.workouts} workouts, {last.food} food entries, {last.body} measurements
            </span>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => run.mutate()} disabled={status.running}>
            <RefreshCw size={13} /> Sync now
          </button>
        </div>
      )}
    </div>
  );
}

export function McpConnections() {
  const { data } = useQuery({ queryKey: ['mcp'], queryFn: () => api<McpList>('GET', '/mcp/servers') });
  const { toast, agentName } = useApp();
  const [custom, setCustom] = useState({ name: '', url: '' });
  const [adding, setAdding] = useState(false);
  const add = useWrite((body: { name: string; url: string }) => write.post<{ authorizeUrl: string | null }>('/mcp/servers', body));
  const signIn = useWrite((id: string) => write.post<{ authorizeUrl: string | null }>(`/mcp/servers/${id}/auth`));
  const setMode = useWrite((v: { id: string; mode: string }) => write.patch(`/mcp/servers/${v.id}`, { mode: v.mode }));
  const allowTool = useWrite((v: { id: string; tool: string; allowed: boolean }) => write.patch(`/mcp/servers/${v.id}`, { allow: { tool: v.tool, allowed: v.allowed } }));
  const check = useWrite((id: string) => write.post(`/mcp/servers/${id}/check`));
  const remove = useWrite((id: string) => write.del(`/mcp/servers/${id}`));

  // Coming back from a server's sign-in page.
  useEffect(() => {
    const result = new URLSearchParams(location.search).get('mcp');
    if (!result) return;
    toast({ message: result === 'connected' ? 'Connected.' : result === 'cancelled' ? 'Sign-in was cancelled.' : 'Sign-in did not complete. Try again.' });
    history.replaceState(null, '', location.pathname + location.hash);
  }, [toast]);

  const go = (r: { authorizeUrl: string | null }) => {
    // The server's own sign-in page; it sends you back here when done.
    if (r.authorizeUrl) location.href = r.authorizeUrl;
  };
  const connected = new Set((data?.servers ?? []).map((s) => s.url));

  return (
    <div className="conn-card">
      <div className="conn-head">
        <span className="brain-icon">
          <Plug size={18} />
        </span>
        <div className="grow">
          <b>Apps over MCP</b>
          <span className="hint" style={{ display: 'block' }}>
            Let {agentName} use apps that offer an MCP server — log a workout or a meal in Gravl from a conversation.
          </span>
        </div>
      </div>

      {(data?.servers ?? []).map((s) => (
        <div key={s.id} className="mcp-server">
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="grow">
              <b>{s.name}</b>
              <span className="hint" style={{ display: 'block' }}>
                {s.status === 'connected' ? `${s.toolCount} tools available to ${agentName}` : s.status === 'needs_auth' ? 'Needs you to sign in' : s.error ? s.error : 'Not checked yet'}
              </span>
            </div>
            {s.status === 'needs_auth' ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => signIn.mutate(s.id, { onSuccess: go, onError: (e) => toast({ message: e.message }) })}>
                Sign in
              </button>
            ) : (
              <select className="select agent-brain" style={{ maxWidth: 190 }} value={s.mode} onChange={(e) => setMode.mutate({ id: s.id, mode: e.target.value })} aria-label={`What ${agentName} may do in ${s.name}`}>
                <option value="write">Read and log</option>
                <option value="read">Read only</option>
                <option value="off">Off</option>
              </select>
            )}
          </div>
          {s.withheld.length > 0 && (
            <p className="hint">
              Never offered to {agentName}: {s.withheld.join(', ')} — {agentName} doesn't delete things.
            </p>
          )}
          {(s.unconfirmed?.length ?? 0) > 0 && (
            <div>
              <p className="hint">
                {s.name} doesn't say whether these change or remove things, so {agentName} only gets the ones you allow:
              </p>
              <div className="row-wrap" style={{ gap: 12 }}>
                {s.unconfirmed!.map((t) => (
                  <label key={t.name} className="row" style={{ gap: 6 }}>
                    <input type="checkbox" checked={t.allowed} onChange={(e) => allowTool.mutate({ id: s.id, tool: t.name, allowed: e.target.checked }, { onError: (err) => toast({ message: err.message }) })} />
                    <span>{t.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {s.id === 'gravl' && s.status === 'connected' && <GravlSync />}
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => check.mutate(s.id)}>
              <RefreshCw size={13} /> Check
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => window.confirm(`Disconnect ${s.name}?`) && remove.mutate(s.id)}>
              Disconnect
            </button>
          </div>
        </div>
      ))}

      <div className="row-wrap">
        {(data?.known ?? [])
          .filter((k) => !connected.has(k.url))
          .map((k) => (
            <button key={k.url} type="button" className="btn btn-primary" disabled={add.isPending} onClick={() => add.mutate({ name: k.name, url: k.url }, { onSuccess: go, onError: (e) => toast({ message: e.message }) })} title={k.blurb}>
              <Plus size={14} /> Connect {k.name}
            </button>
          ))}
        <button type="button" className="btn" onClick={() => setAdding((v) => !v)}>
          Another MCP server
        </button>
      </div>
      {adding && (
        <form
          className="field-row"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(custom, { onSuccess: (r) => (setAdding(false), go(r)), onError: (err) => toast({ message: err.message }) });
          }}
        >
          <Field label="Name">
            <input className="input" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="My app" />
          </Field>
          <Field label="Server URL">
            <div className="row">
              <input className="input" value={custom.url} onChange={(e) => setCustom({ ...custom, url: e.target.value })} placeholder="https://…/mcp" aria-label="Server URL" />
              <button type="submit" className="btn btn-sm" disabled={!custom.name.trim() || !custom.url.trim()}>
                Add
              </button>
            </div>
          </Field>
        </form>
      )}
      <p className="hint">
        <b>Gravl</b> has an official MCP server (it covers Gravl Macros too). <b>Bevel</b> has no official MCP server or API yet — a request for one is on their roadmap — and <b>MacroFactor</b> has no official API; both write to Apple Health, which Terminus can't read directly. Sign-in opens the app's own page and returns here; do it on the device you use Terminus from.
      </p>
    </div>
  );
}
