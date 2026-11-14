import { Download, Plus, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, useAuth, useMemories, useSettings, useSpheres, useWrite, write } from '../api.ts';
import { BrainsSection } from '../components/Brains.tsx';
import { CaptureSetup, GmailConnection } from '../components/Connections.tsx';
import { Orb } from '../components/Orb.tsx';
import { Field, Loading, Seg } from '../components/ui.tsx';
import { useApp } from '../state.tsx';

type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('terminus.theme') ?? localStorage.getItem('lifeos.theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.removeItem('lifeos.theme');
    if (theme === 'system') localStorage.removeItem('terminus.theme');
    else localStorage.setItem('terminus.theme', theme);
  } catch {
    // Storage can be unavailable (private mode); the theme still applies for this visit.
  }
}

export function Settings() {
  const { data: settings } = useSettings();
  const { data: allSpheres = [] } = useSpheres(true);
  const { data: memories = [] } = useMemories();
  const { data: auth } = useAuth();
  const { openSheet, toast } = useApp();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [memory, setMemory] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const saveProfile = useWrite((profile: { userName?: string; agentName?: string }) => write.put('/settings', { profile }));
  const setArchived = useWrite((v: { id: string; archived: boolean }) => write.patch(`/spheres/${v.id}`, { archived: v.archived }));
  const addMemory = useWrite((content: string) => write.post('/memories', { content }));
  const removeMemory = useWrite((id: string) => write.del(`/memories/${id}`));
  const importData = useWrite((dump: unknown) => api('POST', '/import', dump));
  const signOut = useWrite(() => write.post('/auth/logout'));

  if (!settings) return <Loading />;
  const { agentName } = settings.profile;

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const dump: unknown = JSON.parse(await file.text());
      if (!window.confirm('Importing replaces everything currently in this Terminus with the contents of the file. Continue?')) return;
      importData.mutate(dump, {
        onSuccess: () => toast({ message: 'Import complete.' }),
        onError: (err) => toast({ message: err.message }),
      });
    } catch {
      toast({ message: 'That file could not be read as a Terminus export.' });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <h1 className="page-title">Settings</h1>
      </header>

      <section className="card settings-section">
        <header>
          <h2>You</h2>
        </header>
        <div className="settings-body">
          <div className="field-row">
            <Field label="What should you be called?">
              <input className="input" defaultValue={settings.profile.userName} maxLength={80} onBlur={(e) => e.target.value.trim() !== settings.profile.userName && saveProfile.mutate({ userName: e.target.value })} />
            </Field>
            <Field label="Your agent's name" hint="Applies to new conversations.">
              <input className="input" defaultValue={agentName} maxLength={40} onBlur={(e) => e.target.value.trim() !== agentName && saveProfile.mutate({ agentName: e.target.value })} />
            </Field>
          </div>
        </div>
      </section>

      <section className="card settings-section" id="brains">
        <header>
          <h2>Brains</h2>
          <p>The models behind {agentName}. Connect more than one — say your Claude and your OpenAI — and give each a job. Swap them any time; your data and history stay where they are.</p>
        </header>
        <div className="settings-body">
          <BrainsSection settings={settings} />
        </div>
      </section>

      <section className="card settings-section" id="connections">
        <header>
          <h2>Connections</h2>
          <p>Services {agentName} watches for you. What they surface lands in Needs you on Today.</p>
        </header>
        <div className="settings-body">
          <GmailConnection />
          <CaptureSetup />
        </div>
      </section>

      <section className="card settings-section">
        <header>
          <h2>Spheres</h2>
          <p>Archive a sphere to hide it without losing anything inside.</p>
        </header>
        <div className="settings-body" style={{ gap: 0 }}>
          {allSpheres.map((s) => (
            <div key={s.id} className="list-row" style={{ opacity: s.archived ? 0.55 : 1 }}>
              <Orb hue={s.hue} icon={s.icon} size={28} />
              <span className="grow">{s.name}</span>
              {!s.archived && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => openSheet({ kind: 'sphere', id: s.id })}>
                  Edit
                </button>
              )}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setArchived.mutate({ id: s.id, archived: !s.archived })}>
                {s.archived ? 'Restore' : 'Archive'}
              </button>
            </div>
          ))}
          <div style={{ paddingTop: 12 }}>
            <button type="button" className="btn btn-sm" onClick={() => openSheet({ kind: 'new-sphere' })}>
              <Plus size={14} /> Add a sphere
            </button>
          </div>
        </div>
      </section>

      <section className="card settings-section">
        <header>
          <h2>Memory</h2>
          <p>What {agentName} has chosen to remember about you. Remove anything you'd rather it didn't keep, or add something it should know.</p>
        </header>
        <div className="settings-body" style={{ gap: 0 }}>
          {memories.length === 0 && <p className="hint">Nothing remembered yet.</p>}
          {memories.map((m) => (
            <div key={m.id} className="list-row">
              <span className="grow">{m.content}</span>
              <button type="button" className="icon-btn icon-btn-sm" aria-label={`Forget: ${m.content}`} onClick={() => removeMemory.mutate(m.id)}>
                <X size={14} />
              </button>
            </div>
          ))}
          <form
            className="row"
            style={{ paddingTop: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!memory.trim()) return;
              addMemory.mutate(memory);
              setMemory('');
            }}
          >
            <input className="input" value={memory} onChange={(e) => setMemory(e.target.value)} placeholder="e.g. I plan best on Sunday evenings." maxLength={500} aria-label="Add a memory" />
            <button type="submit" className="btn" disabled={!memory.trim()}>
              Add
            </button>
          </form>
        </div>
      </section>

      <section className="card settings-section">
        <header>
          <h2>Appearance</h2>
        </header>
        <div className="settings-body">
          <Seg
            label="Theme"
            value={theme}
            onChange={(t) => {
              setTheme(t);
              applyTheme(t);
            }}
            options={[
              { value: 'system', label: 'Match device' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
      </section>

      <section className="card settings-section">
        <header>
          <h2>Your data</h2>
          <p>Everything lives in one file on the machine running Terminus. Take a copy whenever you like — it's plain JSON, and API keys are never included.</p>
        </header>
        <div className="settings-body">
          <div className="row-wrap">
            <a className="btn" href="/api/export" download>
              <Download size={15} /> Export everything
            </a>
            <button type="button" className="btn" onClick={() => fileInput.current?.click()} disabled={importData.isPending}>
              <Upload size={15} /> Import from a file
            </button>
            <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => void onImport(e.target.files?.[0])} />
            {auth?.required && (
              <button type="button" className="btn btn-ghost" onClick={() => signOut.mutate(undefined, { onSuccess: () => location.reload() })}>
                Sign out
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
