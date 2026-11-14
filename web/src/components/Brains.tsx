// Brains: the models Terminus thinks with. Connect several (your Claude and your
// OpenAI, a local model) and choose which handles conversations and which handles
// quiet background work.

import { Brain, Cpu, KeyRound, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PRESET_BY_ID, PRESETS } from '../../../shared/providers.ts';
import type { Brains as BrainRoles, ConnectionInput, ConnectionView, ModelSettings, Settings } from '../../../shared/types.ts';
import { api, useWrite, write } from '../api.ts';
import { useQuery } from '@tanstack/react-query';
import { cx, plural } from '../lib.ts';
import { Field, Spinner } from './ui.tsx';

const useConnectionModels = (c: ConnectionView | undefined) =>
  useQuery({
    // Refetched whenever what the connection points at changes.
    queryKey: ['models', c?.id, c?.provider, c?.baseUrl, c?.apiKeyHint],
    queryFn: () => api<{ id: string; name: string }[]>('GET', `/connections/${c!.id}/models`),
    enabled: !!c && (c.provider !== 'anthropic' || c.hasApiKey),
    retry: false,
    staleTime: 60_000,
  });

/** Pick or edit one connection: preset, address, key, then model. */
export function ConnectionEditor({ connection, onSaved, compact }: { connection?: ConnectionView; onSaved?: (c: ConnectionView) => void; compact?: boolean }) {
  const [presetId, setPresetId] = useState<string | null>(connection?.preset ?? null);
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [manualModel, setManualModel] = useState(connection?.model ?? '');
  const preset = presetId ? PRESET_BY_ID[presetId] : undefined;

  const create = useWrite((body: ConnectionInput) => write.post<ConnectionView>('/connections', body));
  const update = useWrite((v: { id: string; body: Partial<ConnectionInput> }) => write.patch<ConnectionView>(`/connections/${v.id}`, v.body));
  const models = useConnectionModels(connection);

  // Once connected with no model chosen, take the preset's default, or the only one
  // offered. Tried once per connection state, so a failed save cannot loop.
  const tried = useRef('');
  const { mutate: patch } = update;
  useEffect(() => {
    if (!connection || connection.model || !models.data) return;
    const stamp = `${connection.id}|${connection.baseUrl}|${connection.apiKeyHint}`;
    if (tried.current === stamp) return;
    tried.current = stamp;
    const pick = (preset?.defaultModel && models.data.find((m) => m.id === preset.defaultModel)?.id) || (models.data.length === 1 ? models.data[0]!.id : '');
    if (pick) patch({ id: connection.id, body: { model: pick } });
  }, [connection, models.data, preset, patch]);

  const choose = (id: string) => {
    const p = PRESET_BY_ID[id]!;
    setPresetId(id);
    setBaseUrl(connection?.preset === id ? connection.baseUrl : p.baseUrl);
    setApiKey('');
  };

  const connect = () => {
    if (!preset) return;
    const body: ConnectionInput = {
      provider: preset.provider,
      preset: preset.id,
      baseUrl: preset.provider === 'anthropic' ? '' : baseUrl,
      // Only send a key when one was typed; otherwise the saved one stays (or is
      // cleared by the server if the endpoint changed).
      ...(apiKey ? { apiKey } : {}),
    };
    if (connection) update.mutate({ id: connection.id, body }, { onSuccess: (c) => onSaved?.(c) });
    else create.mutate({ ...body, model: preset.defaultModel }, { onSuccess: (c) => onSaved?.(c) });
    setApiKey('');
  };

  const saving = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const isSaved = !!connection && connection.preset === presetId;
  const missingKey = !!preset?.needsKey && !apiKey && !(connection?.hasApiKey && connection.preset === presetId);
  const missingUrl = !!preset && preset.provider !== 'anthropic' && !baseUrl.trim();

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="preset-grid">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className="preset" aria-pressed={presetId === p.id} onClick={() => choose(p.id)}>
            <strong>
              {p.label}
              {p.local && <span className="chip">local</span>}
            </strong>
            {!compact && <span>{p.blurb}</span>}
          </button>
        ))}
      </div>

      {preset && (
        <>
          <p className="hint">{preset.help}</p>
          <div className="field-row">
            {preset.provider !== 'anthropic' && (
              <Field label="Server address">
                <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" spellCheck={false} autoCapitalize="off" />
              </Field>
            )}
            {(preset.needsKey || preset.id === 'custom') && (
              <Field label={preset.needsKey ? 'API key' : 'API key (if it needs one)'}>
                <input
                  className="input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={connection?.hasApiKey && connection.preset === presetId ? `Saved (${connection.apiKeyHint})` : 'Paste your key'}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            )}
          </div>
          <div className="row-wrap">
            <button type="button" className="btn btn-primary" onClick={connect} disabled={saving || missingKey || missingUrl}>
              {isSaved ? 'Reconnect' : 'Connect'}
            </button>
            {isSaved && (
              <span className="status-line">
                {models.isFetching ? (
                  <>
                    <Spinner /> Checking…
                  </>
                ) : models.isError ? (
                  <>
                    <i className="status-dot bad" /> <span className="error-text">{models.error.message}</span>
                  </>
                ) : models.data ? (
                  <>
                    <i className="status-dot ok" /> Connected — {plural(models.data.length, 'model')} available
                  </>
                ) : null}
              </span>
            )}
          </div>
          {error && <p className="error-text">{error.message}</p>}
        </>
      )}

      {isSaved && connection && (
        <div className="field-row">
          <Field label="Model" hint={connection.provider === 'openai-compatible' ? 'Pick one that supports tool calling, or the agent can talk but not act.' : undefined}>
            {models.data && models.data.length > 0 ? (
              <select className="select" value={connection.model} onChange={(e) => patch({ id: connection.id, body: { model: e.target.value } })}>
                {!connection.model && <option value="">Choose a model…</option>}
                {connection.model && !models.data.some((m) => m.id === connection.model) && <option value={connection.model}>{connection.model}</option>}
                {models.data.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                value={manualModel}
                onChange={(e) => setManualModel(e.target.value)}
                onBlur={() => manualModel.trim() !== connection.model && patch({ id: connection.id, body: { model: manualModel } })}
                placeholder="Model name"
                spellCheck={false}
              />
            )}
          </Field>
          {connection.provider === 'anthropic' && (
            <Field label="Thinking effort" hint="How hard it thinks before answering. Auto uses the model's default.">
              <select className="select" value={connection.effort} onChange={(e) => patch({ id: connection.id, body: { effort: e.target.value as ModelSettings['effort'] } })}>
                <option value="auto">Auto</option>
                <option value="low">Low — quickest</option>
                <option value="medium">Medium</option>
                <option value="high">High — most careful</option>
              </select>
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

function RoleChip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={cx('chip', on ? 'chip-on' : 'chip-outline')} aria-pressed={on} onClick={onClick} title={on ? `Handles ${label.toLowerCase()}` : `Use for ${label.toLowerCase()}`}>
      {label}
    </button>
  );
}

export function BrainsSection({ settings }: { settings: Settings }) {
  const { connections, brains } = settings;
  const [editing, setEditing] = useState<string | 'new' | null>(connections.length === 0 ? 'new' : null);
  const setRole = useWrite((v: Partial<BrainRoles>) => write.put('/brains', v));
  const remove = useWrite((id: string) => write.del(`/connections/${id}`));

  return (
    <div className="stack" style={{ gap: 14 }}>
      {connections.map((c) => (
        <div key={c.id} className="brain-card">
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <span className="brain-icon">{PRESET_BY_ID[c.preset ?? '']?.local ? <Cpu size={18} /> : <Brain size={18} />}</span>
            <div className="grow">
              <b>{c.label}</b>
              <span className="hint" style={{ display: 'block' }}>
                {c.model || 'no model chosen'}
                {PRESET_BY_ID[c.preset ?? '']?.local ? ' · on this machine' : ''}
                {c.provider === 'anthropic' && !c.hasApiKey ? ' · needs a key' : ''}
              </span>
            </div>
            <div className="row-wrap" style={{ gap: 6 }}>
              <RoleChip on={brains.chat === c.id} label="Chat" onClick={() => setRole.mutate({ chat: c.id })} />
              <RoleChip on={brains.background === c.id} label="Background" onClick={() => setRole.mutate({ background: c.id })} />
            </div>
          </div>
          <div className="row" style={{ marginTop: 10, gap: 4 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(editing === c.id ? null : c.id)}>
              {editing === c.id ? 'Done' : 'Edit'}
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => window.confirm(`Remove ${c.label}? Its key is deleted from Terminus.`) && remove.mutate(c.id)}>
              <Trash2 size={13} /> Remove
            </button>
          </div>
          {editing === c.id && (
            <div style={{ marginTop: 14 }}>
              <ConnectionEditor connection={c} compact />
            </div>
          )}
        </div>
      ))}

      {editing === 'new' ? (
        <div className="brain-card">
          <NewBrain onDone={() => setEditing(null)} connections={connections} />
        </div>
      ) : (
        <div>
          <button type="button" className="btn" onClick={() => setEditing('new')}>
            <Plus size={15} /> Add a brain
          </button>
        </div>
      )}

      {connections.length > 1 && (
        <p className="hint">
          <b>Chat</b> answers you in conversations — you can also switch brains inside any conversation. <b>Background</b> does the quiet work: triaging mail, reading links you save, syncing apps.
        </p>
      )}
      <BrainGuide />
    </div>
  );
}

/** A new connection: once created, keep editing it so the model can be chosen. */
function NewBrain({ onDone, connections }: { onDone: () => void; connections: ConnectionView[] }) {
  const [createdId, setCreatedId] = useState<string | null>(null);
  const created = connections.find((c) => c.id === createdId);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <ConnectionEditor connection={created} onSaved={(c) => setCreatedId(c.id)} />
      <div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          {created ? 'Done' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

export function BrainGuide() {
  return (
    <details className="guide">
      <summary>
        <Sparkles size={15} /> How to connect your Claude and your OpenAI
      </summary>
      <ol>
        <li>
          <b>API keys are separate from subscriptions.</b> ChatGPT Plus or Pro and Claude Pro or Max do not include API access. The API is its own pay-as-you-go account, billed per token, so each needs a key and a little credit.
        </li>
        <li>
          <b>Claude:</b> sign in at <code>console.anthropic.com</code>, add credit under Billing, then Settings → API keys → Create key. Back here: Add a brain → Anthropic → paste the key → Connect. Terminus picks <code>claude-opus-5-5</code>; you can choose another model and the thinking effort.
        </li>
        <li>
          <b>OpenAI:</b> sign in at <code>platform.openai.com</code>, add credit under Billing, then API keys → Create new secret key. Back here: Add a brain → OpenAI → paste → Connect, then choose a model that supports tool calling (function calling) so Seldon can act, not just talk.
        </li>
        <li>
          <b>Give each a job.</b> One brain answers you in conversations (<b>Chat</b>), the other can do the quiet work (<b>Background</b>): mail triage, reading saved links, syncing apps. A common split is the stronger model for chat and the cheaper one for background. Any conversation can switch brains from the agent panel's header.
        </li>
        <li>
          <b>Keep spend in check.</b> Set a monthly spending limit in each console. Keys stay in your Terminus database on this machine: they are never sent to the browser and never included in exports.
        </li>
      </ol>
      <p className="hint">
        <KeyRound size={12} style={{ verticalAlign: -1 }} /> Want nothing to leave your machine? Add Ollama or LM Studio as a brain and give it both jobs.
      </p>
    </details>
  );
}
