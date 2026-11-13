// What you see before the app proper: sign-in, and first-run setup.

import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { CATALOG } from '../../../shared/catalog.ts';
import type { Settings } from '../../../shared/types.ts';
import { useSettings, useWrite, write } from '../api.ts';
import { ModelSetup } from '../components/ModelSetup.tsx';
import { AgentOrb, Orb } from '../components/Orb.tsx';
import { Field } from '../components/ui.tsx';
import { hueStyle } from '../lib.ts';

export function SignIn() {
  const qc = useQueryClient();
  const [passphrase, setPassphrase] = useState('');
  const login = useWrite((p: string) => write.post('/auth/login', { passphrase: p }));

  return (
    <main className="stage">
      <form
        className="stage-inner"
        style={{ maxWidth: 380 }}
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate(passphrase, { onSuccess: () => void qc.invalidateQueries() });
        }}
      >
        <AgentOrb size={54} />
        <h1>LifeOS</h1>
        <Field label="Passphrase">
          <input className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus autoComplete="current-password" />
        </Field>
        {login.error && <p className="error-text">{login.error.message}</p>}
        <div>
          <button type="submit" className="btn btn-primary" disabled={!passphrase || login.isPending}>
            Unlock
          </button>
        </div>
      </form>
    </main>
  );
}

export function Onboarding({ settings }: { settings: Settings }) {
  const [step, setStep] = useState(0);
  const [userName, setUserName] = useState(settings.profile.userName);
  const [agentName, setAgentName] = useState(settings.profile.agentName);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(CATALOG.filter((c) => c.core).map((c) => c.key)));
  // Model setup saves as it goes, so read it live.
  const { data: live = settings } = useSettings();
  const finish = useWrite(() => write.post('/onboarding', { userName, agentName, sphereKeys: CATALOG.filter((c) => picked.has(c.key)).map((c) => c.key) }));

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <main className="stage">
      <div className="stage-inner">
        <div className="steps" aria-hidden>
          {[0, 1, 2].map((i) => (
            <i key={i} className={i <= step ? 'on' : ''} />
          ))}
        </div>

        {step === 0 && (
          <form className="stack" style={{ gap: 22 }} onSubmit={(e) => { e.preventDefault(); setStep(1); }}>
            <AgentOrb size={58} />
            <h1>A place for your whole life — and someone to help you tend it.</h1>
            <p className="lede">LifeOS runs on your machine and keeps everything in one file you own. An agent lives here with you: it can read what you track, capture what you tell it, and help you see what needs attention.</p>
            <div className="field-row">
              <Field label="What should it call you?">
                <input className="input" value={userName} onChange={(e) => setUserName(e.target.value)} maxLength={80} autoFocus placeholder="Your first name" />
              </Field>
              <Field label="And what will you call it?">
                <input className="input" value={agentName} onChange={(e) => setAgentName(e.target.value)} maxLength={40} placeholder="Seldon" />
              </Field>
            </div>
            <div>
              <button type="submit" className="btn btn-primary">
                Continue <ArrowRight size={15} />
              </button>
            </div>
          </form>
        )}

        {step === 1 && (
          <>
            <h1>Which parts of life do you want to tend?</h1>
            <p className="lede">These are your spheres. Each gets its own goals, habits and numbers. Start with the ones that matter now — you can add, rename or archive them whenever you like.</p>
            <div className="pick-grid">
              {CATALOG.map((c) => (
                <button key={c.key} type="button" className="pick tint" style={hueStyle(c.hue)} aria-pressed={picked.has(c.key)} onClick={() => toggle(c.key)}>
                  <Orb hue={c.hue} icon={c.icon} size={34} />
                  <span>
                    <strong>{c.name}</strong>
                    <small>{c.blurb}</small>
                  </span>
                </button>
              ))}
            </div>
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={() => setStep(0)}>
                Back
              </button>
              <button type="button" className="btn btn-primary" disabled={picked.size === 0} onClick={() => setStep(2)}>
                Continue with {picked.size} <ArrowRight size={15} />
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Give {agentName.trim() || 'Seldon'} a mind.</h1>
            <p className="lede">Pick the model it thinks with. A local one keeps every word on this machine; a hosted one is sharper but sends your conversations to that provider. You can change this later, or skip it and use LifeOS on its own.</p>
            <ModelSetup settings={live} />
            {finish.error && <p className="error-text">{finish.error.message}</p>}
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" className="btn btn-primary" disabled={finish.isPending} onClick={() => finish.mutate()}>
                {live.model.provider ? 'Open LifeOS' : 'Skip for now'} <ArrowRight size={15} />
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
