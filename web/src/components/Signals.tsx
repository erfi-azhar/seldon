// The inbox of things that may need you, raised by integrations.

import { Briefcase, Check, ExternalLink, Mail, MoonStar, Plane, Radio, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Signal, SignalAction } from '../../../shared/types.ts';
import { useSignals, useWrite, write } from '../api.ts';
import { cx, hueStyle, timeAgo } from '../lib.ts';
import { useApp } from '../state.tsx';
import { AutoTextarea, Modal } from './ui.tsx';

const SOURCE_ICON: Record<string, ReactNode> = {
  gmail: <Mail size={15} />,
  jobs: <Briefcase size={15} />,
  travel: <Plane size={15} />,
  faith: <MoonStar size={15} />,
};

function ReplySheet({ signal, index, action, onClose }: { signal: Signal; index: number; action: Extract<SignalAction, { type: 'reply' }>; onClose: () => void }) {
  const [body, setBody] = useState(action.body);
  const { toast } = useApp();
  const act = useWrite(() => write.post<{ message: string }>(`/signals/${signal.id}/act`, { index, body }));
  return (
    <Modal
      title="Reply draft"
      onClose={onClose}
      footer={
        <>
          <span className="hint">Saved to your Gmail drafts. Nothing is sent.</span>
          <button className="btn btn-primary btn-sm" disabled={act.isPending || !body.trim()} onClick={() => act.mutate(undefined, { onSuccess: (r) => (toast({ message: r.message }), onClose()) })}>
            Save draft
          </button>
        </>
      }
    >
      <div className="hint">
        To {action.to} · {action.subject}
      </div>
      <AutoTextarea className="textarea" minRows={6} value={body} onChange={setBody} aria-label="Reply" />
      {act.error && <p className="error-text">{act.error.message}</p>}
    </Modal>
  );
}

function SignalRow({ signal }: { signal: Signal }) {
  const { sphere, toast } = useApp();
  const s = sphere(signal.sphereId);
  const [replying, setReplying] = useState<number | null>(null);
  const dismiss = useWrite(() => write.patch(`/signals/${signal.id}`, { status: 'dismissed' }));
  const act = useWrite((index: number) => write.post<{ message: string }>(`/signals/${signal.id}/act`, { index }));

  const run = (a: SignalAction, i: number) => {
    if (a.type === 'link') {
      window.open(a.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (a.type === 'reply') {
      setReplying(i);
      return;
    }
    act.mutate(i, { onSuccess: (r) => toast({ message: r.message }), onError: (e) => toast({ message: e.message }) });
  };

  return (
    <li className={cx('signal tint', signal.priority >= 2 && 'signal-hot')} style={s ? hueStyle(s.hue) : undefined}>
      <span className="signal-icon" aria-hidden>
        {SOURCE_ICON[signal.source] ?? <Radio size={15} />}
      </span>
      <div className="grow">
        <div className="signal-top">
          <b className="clamp-1">{signal.title}</b>
          <time className="faint">{timeAgo(signal.occurredAt)}</time>
        </div>
        {signal.body && <p className="signal-body clamp-2">{signal.body}</p>}
        {signal.actions.length > 0 && (
          <div className="row-wrap" style={{ gap: 6, marginTop: 8 }}>
            {signal.actions.map((a, i) => (
              <button key={i} type="button" className={cx('chip', a.type === 'link' ? 'chip-outline' : 'chip-act')} onClick={() => run(a, i)} disabled={act.isPending}>
                {a.type === 'link' ? <ExternalLink size={12} /> : <Check size={12} />} {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="icon-btn icon-btn-sm" aria-label={`Dismiss: ${signal.title}`} onClick={() => dismiss.mutate()}>
        <X size={14} />
      </button>
      {replying !== null && signal.actions[replying]?.type === 'reply' && (
        <ReplySheet signal={signal} index={replying} action={signal.actions[replying] as Extract<SignalAction, { type: 'reply' }>} onClose={() => setReplying(null)} />
      )}
    </li>
  );
}

export function SignalsCard({ sphereId, source, title = 'Needs you', empty }: { sphereId?: string; source?: string; title?: string; empty?: ReactNode }) {
  const { data: signals = [] } = useSignals({ sphereId, source });
  if (signals.length === 0 && !empty) return null;
  return (
    <section className="card" style={{ paddingBottom: 8 }}>
      <div className="card-head">
        <h2 className="card-title">{title}</h2>
        {signals.length > 0 && <span className="chip">{signals.length}</span>}
      </div>
      {signals.length === 0 ? <div className="empty">{empty}</div> : <ul>{signals.map((s) => <SignalRow key={s.id} signal={s} />)}</ul>}
    </section>
  );
}
