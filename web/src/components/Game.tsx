import { ChevronRight, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { DAY_PROMPTS, RESET_SECTIONS, WALK_PROMPTS, WEEKLY_STEER, type DayPrompt } from '../../../shared/game.ts';
import type { GameAim, GamePlan, GameState, Quest } from '../../../shared/types.ts';
import { gameWrite, useGame, useWrite } from '../api.ts';
import { cx, daysFrom, shortDay, todayStr } from '../lib.ts';
import { useApp } from '../state.tsx';
import { TravelNotifications } from './Journey.tsx';
import { AutoTextarea, Check, InlineEdit, Loading } from './ui.tsx';
import { FoldButton, useFold } from './Fold.tsx';

const ALL_PROMPTS: DayPrompt[] = [...DAY_PROMPTS, WEEKLY_STEER];

const isEmpty = (p: GamePlan) => !p.vision && !p.antiVision && !p.mission.text && !p.project.text;

const daysLeft = (aim: GameAim) => {
  if (!aim.by) return null;
  const d = daysFrom(todayStr(), aim.by);
  return d < 0 ? `${-d}d over` : d === 0 ? 'today' : `${d}d left`;
};

const nowHHMM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The question that is due now (its time has passed today) and not answered yet. */
function duePrompt(g: GameState): DayPrompt | null {
  const resetToday = g.reset && g.reset.date === g.date && !g.reset.finishedAt;
  const sunday = new Date(`${g.date}T12:00:00`).getDay() === 0;
  const list = resetToday ? DAY_PROMPTS : [...(g.prompts.daily ? DAY_PROMPTS.filter((p) => p.daily) : []), ...(g.prompts.weekly && sunday ? [WEEKLY_STEER] : [])];
  const now = nowHHMM();
  return [...list].reverse().find((p) => p.at <= now && !g.answered[p.id]) ?? null;
}

/** Saves a piece of text a moment after typing stops, and when the field is left. */
function useAutosave(initial: string, save: (v: string) => void) {
  const [text, setText] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const last = useRef(initial);
  const flush = (v = text) => {
    clearTimeout(timer.current);
    if (v === last.current) return;
    last.current = v;
    save(v);
  };
  const change = (v: string) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(v), 900);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { text, change, flush };
}

// ── Today ───────────────────────────────────────────────────────────────────

/** The game plan at a glance on Today: how you win, what's at stake, the mission, the boss fight, and today's quests. */
export function GameCard() {
  const { data: g } = useGame();
  const folded = useFold();
  if (!g) return null;
  const p = g.plan;
  const resetOn = g.reset && !g.reset.finishedAt;
  if (isEmpty(p) && !resetOn) {
    return (
      <section className="card game-card game-invite">
        <div className="game-invite-body">
          <span className="game-kicker">Reset day</span>
          <h2 className="game-vision">Get honest about where you are headed, then turn it into a game you want to play.</h2>
          <p className="hint">One day: questions in the morning, a few pauses through the day, and an evening that turns your answers into a vision, a mission, this month's project and daily quests.</p>
        </div>
        <Link href="/game" className="btn btn-primary">
          Start <ChevronRight size={15} />
        </Link>
      </section>
    );
  }
  const prompt = duePrompt(g);
  const questsDone = g.quests.filter((q) => q.done).length;
  return (
    <section className={cx('card game-card', folded && 'is-folded')}>
      <div className="game-head">
        <Link href="/game" className="game-head-link">
          <span className="game-kicker">{resetOn ? `Reset day · ${Object.keys(g.reset!.answers).length} answers so far` : 'Game plan'}</span>
          <ChevronRight size={16} className="faint" />
        </Link>
        <div className="card-head-end">
          {folded && g.quests.length > 0 && (
            <span className="hint">
              {questsDone} of {g.quests.length} quests done
            </span>
          )}
          <FoldButton />
        </div>
      </div>
      {folded ? null : (
        <>
          {p.vision && <p className="game-vision">{p.vision}</p>}
          {p.antiVision && (
            <p className="game-stake">
              <span>At stake</span> {p.antiVision}
            </p>
          )}
          {(p.mission.text || p.project.text) && (
            <div className="game-aims">
              {p.mission.text && <Aim label="Mission" aim={p.mission} />}
              {p.project.text && <Aim label="Boss fight" aim={p.project} />}
            </div>
          )}
          <Quests g={g} />
          {prompt && <PromptBox prompt={prompt} answer={g.answered[prompt.id] ?? ''} />}
        </>
      )}
    </section>
  );
}

function Aim({ label, aim }: { label: string; aim: GameAim }) {
  const left = daysLeft(aim);
  return (
    <div className="game-aim">
      <span className="game-aim-label">
        {label}
        {left && <span className="hint"> · {left}</span>}
      </span>
      <span className="game-aim-text">{aim.text}</span>
    </div>
  );
}

/** Today's two or three quests, with a time block each. */
function Quests({ g }: { g: GameState }) {
  const toggle = useWrite((id: string) => gameWrite.post(`/quests/${id}/toggle`));
  const save = useWrite((qs: { title: string; time: string }[]) => gameWrite.put('/quests', { quests: qs }));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ title: string; time: string }[]>([]);
  const { ask } = useApp();
  const open = () => {
    setDraft(g.quests.length ? g.quests.map((q) => ({ title: q.title, time: q.time })) : [{ title: '', time: '' }]);
    setEditing(true);
  };
  const done = g.quests.filter((q) => q.done).length;

  if (editing) {
    const commit = () => {
      save.mutate(draft.filter((d) => d.title.trim()));
      setEditing(false);
    };
    return (
      <div className="game-quests">
        <div className="game-quests-head">
          <span className="game-aim-label">Today's quests</span>
          <span className="hint">two or three, with a time each</span>
        </div>
        {draft.map((d, i) => (
          <div key={i} className="quest-edit">
            <input type="time" className="input" value={d.time} aria-label="Time" onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))} />
            <input
              className="input grow"
              value={d.title}
              placeholder={g.plan.levers[i] ?? 'What would the person you are becoming do today?'}
              aria-label="Quest"
              maxLength={160}
              autoFocus={i === draft.length - 1}
              onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
              onKeyDown={(e) => e.key === 'Enter' && commit()}
            />
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Remove" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
              <X size={14} />
            </button>
          </div>
        ))}
        <div className="row" style={{ gap: 8, padding: '6px 0 0' }}>
          {draft.length < 3 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft([...draft, { title: '', time: '' }])}>
              <Plus size={14} /> Another
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={commit}>
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="game-quests">
      <div className="game-quests-head">
        <span className="game-aim-label">
          Today's quests{g.quests.length > 0 && <span className="hint"> · {done} of {g.quests.length}</span>}
        </span>
        <button type="button" className="link" onClick={open}>
          {g.quests.length ? 'Change' : 'Set them'}
        </button>
      </div>
      {g.quests.length === 0 ? (
        <p className="hint" style={{ margin: '2px 0 0' }}>
          No quests yet.{' '}
          <button type="button" className="link" onClick={() => ask("Suggest two or three quests for today from my game plan, each with a time block that fits around prayer times. Don't set them until I say yes.")}>
            Ask for some
          </button>
        </p>
      ) : (
        <ul className="quest-list">
          {g.quests.map((q: Quest) => (
            <li key={q.id} className={cx('quest', q.done && 'is-done')}>
              <Check checked={q.done} onChange={() => toggle.mutate(q.id)} label={`${q.done ? 'Undo' : 'Done'}: ${q.title}`} />
              {q.time && <span className="quest-time">{q.time}</span>}
              <span className="quest-title">{q.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A timed question, answered right where it shows up. */
function PromptBox({ prompt, answer }: { prompt: DayPrompt; answer: string }) {
  const save = useWrite((text: string) => gameWrite.put(`/prompts/${prompt.id}`, { text }));
  const { text, change, flush } = useAutosave(answer, (v) => save.mutate(v));
  return (
    <div className="game-pause">
      <span className="game-aim-label">
        {prompt.id === WEEKLY_STEER.id ? 'Weekly steer' : 'Pause'} <span className="hint">· {prompt.at}</span>
      </span>
      <p className="game-pause-q">{prompt.text}</p>
      <AutoTextarea className="textarea" value={text} onChange={change} onBlur={() => flush()} placeholder="A sentence is enough." minRows={2} aria-label={prompt.text} />
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

export function GamePage() {
  const { data: g } = useGame();
  const asked = new URLSearchParams(window.location.search).get('q');
  if (!g) return <Loading />;
  const resetOn = !!g.reset && !g.reset.finishedAt;
  const fromNotification = asked ? ALL_PROMPTS.find((p) => p.id === asked) : null;
  return (
    <div className="page game-page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{resetOn ? 'Reset day' : 'Game plan'}</h1>
          <p className="page-sub">
            {resetOn
              ? 'Write in your own words. Everything saves as you type, and nothing here is shared.'
              : 'What is at stake, how you win, the mission, this month’s boss fight, today’s quests, and the rules you play by.'}
          </p>
        </div>
      </header>
      {fromNotification && !resetOn && (
        <section className="card card-pad">
          <PromptBox prompt={fromNotification} answer={g.answered[fromNotification.id] ?? ''} />
        </section>
      )}
      {resetOn ? <ResetFlow g={g} /> : <PlanView g={g} />}
    </div>
  );
}

function PlanView({ g }: { g: GameState }) {
  const save = useWrite((patch: object) => gameWrite.put('/plan', patch));
  const start = useWrite(() => gameWrite.post('/reset'));
  const settings = useWrite((body: object) => gameWrite.put('/prompt-settings', body));
  const p = g.plan;
  const field = (label: string, hint: string, value: string, key: keyof GamePlan, big = false) => (
    <div className="game-field">
      <span className="game-aim-label">{label}</span>
      <span className="hint">{hint}</span>
      <InlineEdit value={value} onSave={(v) => save.mutate({ [key]: v })} placeholder="Not written yet" multiline label={label} className={cx(big && 'game-vision')} />
    </div>
  );
  const aim = (label: string, hint: string, a: GameAim, key: 'mission' | 'project') => (
    <div className="game-field">
      <span className="game-aim-label">
        {label}
        {daysLeft(a) && <span className="hint"> · {daysLeft(a)}</span>}
      </span>
      <span className="hint">{hint}</span>
      <InlineEdit value={a.text} onSave={(v) => save.mutate({ [key]: { text: v, by: a.by } })} placeholder="Not set yet" multiline label={label} />
      <label className="hint game-by">
        By{' '}
        <input type="date" className="input" value={a.by ?? ''} onChange={(e) => save.mutate({ [key]: { text: a.text, by: e.target.value || null } })} />
        {a.by && <span> · {shortDay(a.by)}</span>}
      </label>
    </div>
  );
  const list = (label: string, hint: string, items: string[], key: 'levers' | 'rules') => (
    <div className="game-field">
      <span className="game-aim-label">{label}</span>
      <span className="hint">{hint}</span>
      <InlineEdit value={items.join('\n')} onSave={(v) => save.mutate({ [key]: v.split('\n') })} placeholder="One per line" multiline label={label} />
    </div>
  );
  return (
    <>
      <div className="detail-grid">
        <section className="card card-pad game-plan">
          {field('Vision', 'How you win, for now. It will sharpen as you go.', p.vision, 'vision', true)}
          {field('Anti-vision', 'The life you refuse. What is at stake if nothing changes.', p.antiVision, 'antiVision')}
          {field('Identity', '"I am the kind of person who…"', p.identity, 'identity')}
          {field('The pattern to beat', 'Not people or circumstances: the habit of mind that keeps you stuck.', p.enemy, 'enemy')}
        </section>
        <section className="card card-pad game-plan">
          {aim('Mission', 'One year: one concrete thing that proves the old pattern is broken.', p.mission, 'mission')}
          {aim('Boss fight', 'This month: what you will learn, build or finish to keep the mission on track.', p.project, 'project')}
          {list('Daily levers', 'The kinds of action that move the boss fight. Quests are drawn from these.', p.levers, 'levers')}
          {list('Rules', 'What you will not trade away to get there.', p.rules, 'rules')}
        </section>
      </div>

      <section className="card card-pad game-quests-card">
        <Quests g={g} />
      </section>

      <div className="detail-grid">
        <section className="card card-pad">
          <span className="game-aim-label">Reset day</span>
          <p className="hint" style={{ margin: '6px 0 12px' }}>
            A day set aside to look hard at where you are and rewrite the plan. Morning questions, six pauses through the day, and an evening that turns it into your game plan. Worth doing every few months, or whenever you feel stuck.
          </p>
          {g.reset?.finishedAt && <p className="hint">Last one: {shortDay(g.reset.date)}.</p>}
          <button type="button" className="btn btn-primary" onClick={() => start.mutate()} disabled={start.isPending}>
            <Sparkles size={15} /> Start a reset day today
          </button>
        </section>
        <section className="card card-pad game-settings">
          <span className="game-aim-label">Questions through the day</span>
          <label className="game-toggle">
            <input type="checkbox" checked={g.prompts.daily} onChange={(e) => settings.mutate({ daily: e.target.checked })} />
            <span>
              Two pauses every day
              <span className="hint"> · {DAY_PROMPTS.filter((x) => x.daily).map((x) => x.at).join(' and ')}</span>
            </span>
          </label>
          <label className="game-toggle">
            <input type="checkbox" checked={g.prompts.weekly} onChange={(e) => settings.mutate({ weekly: e.target.checked })} />
            <span>
              A weekly steer
              <span className="hint"> · Sundays at {WEEKLY_STEER.at}</span>
            </span>
          </label>
          <p className="hint">They reach your lock screen when notifications are on for this device{g.push ? '' : ', and show on Today either way'}.</p>
          <TravelNotifications />
        </section>
      </div>
    </>
  );
}

function ResetFlow({ g }: { g: GameState }) {
  const r = g.reset!;
  const finish = useWrite(() => gameWrite.post('/reset/finish'));
  const [, navigate] = useLocation();
  const today = r.date === g.date;
  const answered = (ids: string[]) => ids.filter((id) => r.answers[id]?.trim()).length;
  const synthesis = RESET_SECTIONS.find((s) => s.id === 'synthesis')!;
  return (
    <div className="reset-flow">
      {RESET_SECTIONS.filter((s) => s.id !== 'synthesis').map((s) => (
        <ResetSectionCard key={s.id} title={s.title} when={s.when} intro={s.intro} count={answered(s.questions.map((q) => q.id))} total={s.questions.length}>
          {s.questions.map((q) => (
            <ResetAnswer key={q.id} id={q.id} question={q.text} answer={r.answers[q.id] ?? ''} />
          ))}
        </ResetSectionCard>
      ))}

      <ResetSectionCard title="Pauses through the day" when="Day" intro={today ? `Each question arrives at its time${g.push ? ' on your lock screen' : ' (turn on notifications to get them on your lock screen)'}. Answer when it lands.` : 'Answer each one when its time comes.'} count={answered(DAY_PROMPTS.map((p) => p.id))} total={DAY_PROMPTS.length}>
        {DAY_PROMPTS.map((p) => (
          <ResetAnswer key={p.id} id={p.id} question={p.text} answer={r.answers[p.id] ?? ''} at={p.at} prompt />
        ))}
        <div className="reset-walk">
          <span className="game-aim-label">For a walk or the commute</span>
          <ul>
            {WALK_PROMPTS.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      </ResetSectionCard>

      <ResetSectionCard title={synthesis.title} when={synthesis.when} intro={synthesis.intro} count={answered(synthesis.questions.map((q) => q.id))} total={synthesis.questions.length}>
        {synthesis.questions.map((q) => (
          <ResetAnswer key={q.id} id={q.id} question={q.text} answer={r.answers[q.id] ?? ''} />
        ))}
        <div className="row" style={{ gap: 10, paddingTop: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={finish.isPending || !['anti_vision', 'vision_mvp', 'one_year', 'one_month'].some((id) => r.answers[id]?.trim())}
            onClick={() => finish.mutate(undefined, { onSuccess: () => navigate('/game') })}
          >
            Turn this into my game plan
          </button>
          <span className="hint">Your one-sentence answers become the plan; tomorrow's actions become tomorrow's quests. You can edit everything after.</span>
        </div>
      </ResetSectionCard>
    </div>
  );
}

function ResetSectionCard({ title, when, intro, count, total, children }: { title: string; when: string; intro: string; count: number; total: number; children: React.ReactNode }) {
  return (
    <section className="card card-pad reset-section">
      <div className="reset-section-head">
        <span className="game-kicker">{when}</span>
        <span className="hint">
          {count} of {total}
        </span>
      </div>
      <h2 className="reset-title">{title}</h2>
      <p className="hint reset-intro">{intro}</p>
      <div className="reset-answers">{children}</div>
    </section>
  );
}

function ResetAnswer({ id, question, answer, at, prompt = false }: { id: string; question: string; answer: string; at?: string; prompt?: boolean }) {
  const save = useWrite((text: string) => (prompt ? gameWrite.put(`/prompts/${id}`, { text }) : gameWrite.put(`/reset/answers/${id}`, { text })));
  const { text, change, flush } = useAutosave(answer, (v) => save.mutate(v));
  return (
    <label className="reset-answer">
      <span className="reset-q">
        {at && <span className="quest-time">{at}</span>} {question}
      </span>
      <AutoTextarea className="textarea" value={text} onChange={change} onBlur={() => flush()} minRows={2} aria-label={question} />
    </label>
  );
}
