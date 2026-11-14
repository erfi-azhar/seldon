// Access tokens: let another program, such as Claude Code, act as Seldon on this Terminus.
// You create them here and can revoke them at any time; a token's value is shown once.

import { useQuery } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { AccessScope, AccessToken } from '../../../shared/types.ts';
import { api, useWrite, write } from '../api.ts';
import { timeAgo } from '../lib.ts';
import { useApp } from '../state.tsx';
import { Field, Seg } from './ui.tsx';

type Days = '30' | '90' | '365' | 'never';

export function AccessTokens() {
  const { agentName } = useApp();
  const { data: tokens = [] } = useQuery({ queryKey: ['tokens'], queryFn: () => api<AccessToken[]>('GET', '/tokens') });
  const [name, setName] = useState('Claude Code');
  const [scope, setScope] = useState<AccessScope>('write');
  const [days, setDays] = useState<Days>('90');
  const [made, setMade] = useState<{ token: string; record: AccessToken } | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useWrite(() => write.post<{ token: string; record: AccessToken }>('/tokens', { name, scope, days: days === 'never' ? null : Number(days) }));
  const revoke = useWrite((id: string) => write.del(`/tokens/${id}`));

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the value stays selectable on screen */
    }
  };

  return (
    <div className="access">
      <p className="hint" style={{ marginTop: 0 }}>
        A token lets another program act as {agentName} here: read what you track, and with write access add and update things through {agentName}'s own tools. Its changes show in your activity as {agentName}'s and can be undone. A token can never see passwords or API keys, manage tokens, export, import, or delete anything.
      </p>

      {tokens.length > 0 && (
        <ul className="access-list">
          {tokens.map((t) => (
            <li key={t.id}>
              <KeyRound size={15} className="faint" />
              <div className="grow">
                <b>{t.name}</b>
                <span className="hint">
                  {t.scope === 'write' ? 'Read and write' : 'Read only'} · made {timeAgo(t.createdAt)}
                  {t.lastUsedAt ? ` · used ${timeAgo(t.lastUsedAt)}` : ' · not used yet'}
                  {t.expiresAt ? ` · expires ${new Date(t.expiresAt).toLocaleDateString()}` : ' · never expires'}
                </span>
              </div>
              <button type="button" className="btn btn-ghost btn-sm danger" onClick={() => window.confirm(`Revoke "${t.name}"? Anything using it stops working at once.`) && revoke.mutate(t.id)}>
                <Trash2 size={13} /> Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {made ? (
        <div className="access-made">
          <b>Copy this token now. It won't be shown again.</b>
          <div className="row" style={{ gap: 8 }}>
            <code className="token grow">{made.token}</code>
            <button type="button" className="btn btn-sm" onClick={() => void copy(made.token)}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <span className="hint">Paste it only into the program you made it for, such as Claude Code's secure form. Never into a chat.</span>
          <div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMade(null)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="access-new">
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Field label="Access">
            <Seg label="Access" value={scope} onChange={setScope} options={[{ value: 'write', label: 'Read and write' }, { value: 'read', label: 'Read only' }]} />
          </Field>
          <Field label="Expires">
            <Seg label="Expires" value={days} onChange={setDays} options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: 'A year' }, { value: 'never', label: 'Never' }]} />
          </Field>
          <div>
            <button type="button" className="btn btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate(undefined, { onSuccess: (r) => setMade(r) })}>
              <KeyRound size={14} /> Create token
            </button>
          </div>
          {create.error && <p className="error-text">{create.error.message}</p>}
        </div>
      )}
    </div>
  );
}
