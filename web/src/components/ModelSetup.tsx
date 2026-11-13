// Choosing the agent's model. Used in Settings and at the end of onboarding.

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { PRESET_BY_ID, PRESETS } from '../../../shared/providers.ts';
import type { ModelSettings, Settings, SettingsUpdate } from '../../../shared/types.ts';
import { useModels, useWrite, write } from '../api.ts';
import { plural } from '../lib.ts';
import { Field, Spinner } from './ui.tsx';

export function ModelSetup({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const saved = settings.model;
  const [presetId, setPresetId] = useState<string | null>(saved.preset);
  const [baseUrl, setBaseUrl] = useState(saved.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [manualModel, setManualModel] = useState(saved.model);
  const preset = presetId ? PRESET_BY_ID[presetId] : undefined;

  const save = useWrite((model: NonNullable<SettingsUpdate['model']>) => write.put<Settings>('/settings', { model }));

  const connected = !!saved.provider && saved.preset === presetId;
  // The list is refetched whenever what we are connected to changes.
  const stamp = `${saved.provider}|${saved.baseUrl}|${saved.apiKeyHint}`;
  const models = useModels(connected, stamp);

  // Once connected with no model chosen, take the preset's default, or the only one on
  // offer. Tried once per connection, so a failed save cannot loop.
  const autoPicked = useRef('');
  const { mutate } = save;
  useEffect(() => {
    if (!connected || saved.model || !models.data || autoPicked.current === stamp) return;
    autoPicked.current = stamp;
    const pick = (preset?.defaultModel && models.data.find((m) => m.id === preset.defaultModel)?.id) || (models.data.length === 1 ? models.data[0]!.id : '');
    if (pick) mutate({ model: pick });
  }, [connected, saved.model, models.data, preset, stamp, mutate]);

  const choose = (id: string) => {
    const p = PRESET_BY_ID[id]!;
    setPresetId(id);
    setBaseUrl(saved.preset === id ? saved.baseUrl : p.baseUrl);
    setApiKey('');
    setManualModel(saved.preset === id ? saved.model : '');
  };

  const connect = () => {
    if (!preset) return;
    const sameTarget = saved.provider === preset.provider && saved.baseUrl === baseUrl.trim().replace(/\/+$/, '');
    save.mutate(
      {
        provider: preset.provider,
        preset: preset.id,
        baseUrl: preset.provider === 'anthropic' ? '' : baseUrl,
        model: sameTarget ? saved.model : preset.defaultModel,
        // Only send a key when one was typed; otherwise the saved one stays (or is
        // cleared by the server if the endpoint changed).
        ...(apiKey ? { apiKey } : {}),
      },
      { onSuccess: () => void qc.invalidateQueries({ queryKey: ['models'] }) },
    );
    setApiKey('');
  };

  const needsKey = !!preset && (preset.needsKey || preset.id === 'custom');
  const missingKey = !!preset?.needsKey && !apiKey && !(saved.hasApiKey && saved.preset === presetId);
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
            <span>{p.blurb}</span>
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
            {needsKey && (
              <Field label={preset.needsKey ? 'API key' : 'API key (if it needs one)'}>
                <input
                  className="input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={saved.hasApiKey && saved.preset === presetId ? `Saved (${saved.apiKeyHint})` : 'Paste your key'}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            )}
          </div>
          <div className="row-wrap">
            <button type="button" className="btn btn-primary" onClick={connect} disabled={save.isPending || missingKey || missingUrl}>
              {connected ? 'Reconnect' : 'Connect'}
            </button>
            {connected && (
              <button type="button" className="btn btn-ghost" onClick={() => { save.mutate({ provider: null, preset: null, baseUrl: '', model: '', apiKey: null }); setPresetId(null); }}>
                Disconnect
              </button>
            )}
            {connected && (
              <span className="status-line">
                {models.isFetching ? (
                  <>
                    <Spinner /> Checking…
                  </>
                ) : models.isError ? (
                  <>
                    <i className="status-dot bad" /> <span className="error-text">{models.error.message}</span>
                  </>
                ) : (
                  <>
                    <i className="status-dot ok" /> Connected — {plural(models.data?.length ?? 0, 'model')} available
                  </>
                )}
              </span>
            )}
          </div>
          {save.error && <p className="error-text">{save.error.message}</p>}
        </>
      )}

      {connected && (
        <div className="field-row">
          <Field label="Model" hint={preset?.provider === 'openai-compatible' ? 'Pick one that supports tool calling, or the agent can talk but not act.' : undefined}>
            {models.data && models.data.length > 0 ? (
              <select className="select" value={saved.model} onChange={(e) => save.mutate({ model: e.target.value })}>
                {!saved.model && <option value="">Choose a model…</option>}
                {saved.model && !models.data.some((m) => m.id === saved.model) && <option value={saved.model}>{saved.model}</option>}
                {models.data.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            ) : (
              <input className="input" value={manualModel} onChange={(e) => setManualModel(e.target.value)} onBlur={() => manualModel.trim() !== saved.model && save.mutate({ model: manualModel })} placeholder="Model name" spellCheck={false} />
            )}
          </Field>
          {saved.provider === 'anthropic' && (
            <Field label="Thinking effort" hint="How hard the model thinks before answering. Auto uses its default.">
              <select className="select" value={saved.effort} onChange={(e) => save.mutate({ effort: e.target.value as ModelSettings['effort'] })}>
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
