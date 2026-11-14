// Health sphere panels: today's food against targets, training, body composition.

import { Activity, Bike, Camera, Dumbbell, Footprints, Pencil, Plus, ScanLine, Trash2, Waves, Zap } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { HealthState, Macros, Meal, NutritionTargets, Workout } from '../../../shared/types.ts';
import { healthWrite, postForm, useHealth, useWrite } from '../api.ts';
import { cx, formatNumber, parseDay, shortDay } from '../lib.ts';
import { useApp } from '../state.tsx';
import { Field, Modal, Spinner } from './ui.tsx';

const MEALS: Meal[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const MACROS: { key: keyof Macros & ('protein' | 'carbs' | 'fat'); label: string; hue: number }[] = [
  { key: 'protein', label: 'Protein', hue: 340 },
  { key: 'carbs', label: 'Carbs', hue: 75 },
  { key: 'fat', label: 'Fat', hue: 255 },
];

function Ring({ value, max, size = 132, stroke = 12, hue, children }: { value: number; max: number | null; size?: number; stroke?: number; hue: number; children: ReactNode }) {
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const frac = max ? Math.min(1, value / max) : 0;
  const over = !!max && value > max;
  return (
    <div className="h-ring" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} className="h-ring-track" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          className="h-ring-arc"
          style={{ stroke: over ? 'var(--bad)' : `oklch(0.7 0.15 ${hue})` }}
          strokeDasharray={`${Math.max(0.001, frac) * C} ${C}`}
        />
      </svg>
      <div className="h-ring-center">{children}</div>
    </div>
  );
}

function TargetsSheet({ targets, onClose }: { targets: NutritionTargets; onClose: () => void }) {
  const [t, setT] = useState({ kcal: targets.kcal?.toString() ?? '', protein: targets.protein?.toString() ?? '', carbs: targets.carbs?.toString() ?? '', fat: targets.fat?.toString() ?? '' });
  const save = useWrite(healthWrite.targets);
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  return (
    <Modal
      title="Daily targets"
      onClose={onClose}
      footer={
        <>
          <span className="hint">Leave a box empty for no target.</span>
          <button className="btn btn-primary btn-sm" onClick={() => save.mutate({ kcal: num(t.kcal), protein: num(t.protein), carbs: num(t.carbs), fat: num(t.fat) }, { onSuccess: onClose })}>
            Save
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Calories (kcal)">
          <input className="input num" inputMode="numeric" value={t.kcal} onChange={(e) => setT({ ...t, kcal: e.target.value })} data-autofocus />
        </Field>
        <Field label="Protein (g)">
          <input className="input num" inputMode="numeric" value={t.protein} onChange={(e) => setT({ ...t, protein: e.target.value })} />
        </Field>
        <Field label="Carbs (g)">
          <input className="input num" inputMode="numeric" value={t.carbs} onChange={(e) => setT({ ...t, carbs: e.target.value })} />
        </Field>
        <Field label="Fat (g)">
          <input className="input num" inputMode="numeric" value={t.fat} onChange={(e) => setT({ ...t, fat: e.target.value })} />
        </Field>
      </div>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

export function NutritionCard({ h }: { h: HealthState }) {
  const { toast, agentName } = useApp();
  const [text, setText] = useState('');
  const [targets, setTargets] = useState(false);
  const [manual, setManual] = useState(false);
  const photo = useRef<HTMLInputElement>(null);
  const describe = useWrite((body: { text: string }) => healthWrite.post('/food/describe', body));
  const describePhoto = useWrite((f: File) => {
    const form = new FormData();
    form.set('file', f);
    form.set('text', text);
    return postForm<HealthState>('/health/food/describe', form);
  });
  const remove = useWrite((id: string) => healthWrite.del(`/food/${id}`));
  const t = h.today.totals;
  const left = h.targets.kcal ? h.targets.kcal - t.kcal : null;
  const maxKcal = Math.max(...h.days.map((d) => d.kcal), h.targets.kcal ?? 0, 1);
  const busy = describe.isPending || describePhoto.isPending;

  return (
    <section className="card nutrition">
      <div className="card-head">
        <h2 className="card-title">Today's food</h2>
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setManual(true)}>
            <Plus size={13} /> Add
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTargets(true)}>
            <Pencil size={12} /> Targets
          </button>
        </div>
      </div>
      <div className="nutrition-top">
        <Ring value={t.kcal} max={h.targets.kcal} hue={150}>
          <b className="num">{formatNumber(Math.round(t.kcal))}</b>
          <span>{h.targets.kcal ? (left! >= 0 ? `${formatNumber(Math.round(left!))} left` : `${formatNumber(Math.round(-left!))} over`) : 'kcal'}</span>
        </Ring>
        <div className="macro-gauges">
          {MACROS.map((m) => {
            const target = h.targets[m.key];
            const v = t[m.key];
            return (
              <div key={m.key} className="macro">
                <Ring value={v} max={target} size={78} stroke={8} hue={m.hue}>
                  <b className="num" style={{ fontSize: 15 }}>
                    {Math.round(v)}g
                  </b>
                </Ring>
                <span className="macro-label" style={{ color: `oklch(0.58 0.15 ${m.hue})` }}>
                  {m.label}
                </span>
                <span className="hint">{target ? (v <= target ? `${Math.round(target - v)}g left` : `${Math.round(v - target)}g over`) : 'no target'}</span>
              </div>
            );
          })}
        </div>
      </div>

      <form
        className="describe"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) describe.mutate({ text }, { onSuccess: () => setText(''), onError: (err) => toast({ message: err.message }) });
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Describe what you ate — "chicken rice and a kopi"`} aria-label="Describe what you ate" disabled={busy} />
        <button type="button" className="icon-btn" aria-label="Photo of a meal" title={`Photo of a meal — ${agentName} estimates it`} onClick={() => photo.current?.click()} disabled={busy}>
          <Camera size={17} />
        </button>
        <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files?.[0] && describePhoto.mutate(e.target.files[0], { onSuccess: () => setText(''), onError: (err) => toast({ message: err.message }) })} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim() || busy}>
          {busy ? <Spinner /> : 'Log'}
        </button>
      </form>

      {h.today.entries.length === 0 ? (
        <p className="empty">Nothing logged today. Describe a meal, or tell {agentName}.</p>
      ) : (
        <ul className="food-list">
          {MEALS.filter((m) => h.today.entries.some((e) => e.meal === m)).map((m) => (
            <li key={m}>
              <div className="list-label" style={{ padding: '8px 0 2px' }}>
                {m}
              </div>
              {h.today.entries
                .filter((e) => e.meal === m)
                .map((e) => (
                  <div key={e.id} className="food">
                    <span className="grow">
                      {e.name}
                      {e.amount && <span className="faint"> · {e.amount}</span>}
                      {e.source === 'estimate' || e.source === 'seldon' ? <span className="faint" title="Estimated"> ≈</span> : null}
                    </span>
                    <span className="food-macros num">
                      {Math.round(e.protein)}p · {Math.round(e.carbs)}c · {Math.round(e.fat)}f
                    </span>
                    <span className="num food-kcal">{Math.round(e.kcal)}</span>
                    <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove ${e.name}`} onClick={() => remove.mutate(e.id)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
            </li>
          ))}
        </ul>
      )}

      <div className="kcal-bars" aria-label="Calories, last 14 days">
        {h.days.map((d) => (
          <div key={d.date} className="kcal-bar" title={`${shortDay(d.date)}: ${Math.round(d.kcal)} kcal`}>
            <i style={{ height: `${(d.kcal / maxKcal) * 100}%` }} className={cx(d.date === h.date && 'is-today', !!h.targets.kcal && d.kcal > h.targets.kcal && 'is-over')} />
          </div>
        ))}
        {h.targets.kcal && <span className="kcal-target" style={{ bottom: `${(h.targets.kcal / maxKcal) * 100}%` }} />}
      </div>

      {targets && <TargetsSheet targets={h.targets} onClose={() => setTargets(false)} />}
      {manual && <ManualFood onClose={() => setManual(false)} />}
    </section>
  );
}

function ManualFood({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', amount: '', kcal: '', protein: '', carbs: '', fat: '' });
  const save = useWrite(() => healthWrite.post('/food', { items: [{ name: f.name, amount: f.amount, kcal: Number(f.kcal), protein: Number(f.protein || 0), carbs: Number(f.carbs || 0), fat: Number(f.fat || 0) }] }));
  return (
    <Modal
      title="Add food"
      onClose={onClose}
      footer={
        <>
          <span />
          <button className="btn btn-primary btn-sm" disabled={!f.name.trim() || f.kcal === '' || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Add
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Food">
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-autofocus />
        </Field>
        <Field label="Amount">
          <input className="input" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="1 bowl" />
        </Field>
      </div>
      <div className="adjust-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {(['kcal', 'protein', 'carbs', 'fat'] as const).map((k) => (
          <label key={k}>
            <span>{k === 'kcal' ? 'kcal' : `${k} (g)`}</span>
            <input className="input num" inputMode="decimal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

const WORKOUT_ICON: Record<Workout['type'], ReactNode> = {
  strength: <Dumbbell size={15} />,
  run: <Footprints size={15} />,
  walk: <Footprints size={15} />,
  cycle: <Bike size={15} />,
  swim: <Waves size={15} />,
  cardio: <Zap size={15} />,
  mobility: <Activity size={15} />,
  sport: <Activity size={15} />,
  other: <Activity size={15} />,
};

/** "Bench press 3x8 70" → one exercise with three sets of 8 at 70. */
export function parseExercises(text: string): Workout['exercises'] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)\s+(\d+)\s*[x×]\s*(\d+)(?:\s*[@ ]\s*(\d+(?:\.\d+)?))?\s*(?:kg)?$/i);
      if (!m) return { name: line, sets: [] };
      const sets = Array.from({ length: Number(m[2]) }, () => ({ reps: Number(m[3]), weight: m[4] ? Number(m[4]) : null }));
      return { name: m[1]!.trim(), sets };
    });
}

function WorkoutSheet({ onClose }: { onClose: () => void }) {
  const [w, setW] = useState({ name: '', type: 'strength' as Workout['type'], duration: '', distance: '', exercises: '', notes: '' });
  const save = useWrite(() =>
    healthWrite.post('/workouts', {
      name: w.name,
      type: w.type,
      duration_min: w.duration ? Number(w.duration) : null,
      distance_km: w.distance ? Number(w.distance) : null,
      exercises: parseExercises(w.exercises),
      notes: w.notes,
    }),
  );
  return (
    <Modal
      title="Log a workout"
      onClose={onClose}
      footer={
        <>
          <span />
          <button className="btn btn-primary btn-sm" disabled={!w.name.trim() || save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Log workout
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="What">
          <input className="input" value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} placeholder="Push day, easy run…" data-autofocus />
        </Field>
        <Field label="Type">
          <select className="select" value={w.type} onChange={(e) => setW({ ...w, type: e.target.value as Workout['type'] })}>
            {Object.keys(WORKOUT_ICON).map((t) => (
              <option key={t} value={t}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Minutes">
          <input className="input num" inputMode="numeric" value={w.duration} onChange={(e) => setW({ ...w, duration: e.target.value })} />
        </Field>
        <Field label="Distance (km)">
          <input className="input num" inputMode="decimal" value={w.distance} onChange={(e) => setW({ ...w, distance: e.target.value })} />
        </Field>
      </div>
      {w.type === 'strength' && (
        <Field label="Exercises" hint='One per line, like "Bench press 3x8 70" (sets × reps, then weight).'>
          <textarea className="textarea" value={w.exercises} onChange={(e) => setW({ ...w, exercises: e.target.value })} placeholder={'Bench press 3x8 70\nPull-ups 3x10'} />
        </Field>
      )}
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

export function TrainingCard({ h }: { h: HealthState }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="card" style={{ paddingBottom: 10 }}>
      <div className="card-head">
        <h2 className="card-title">Training</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
          <Plus size={13} /> Log workout
        </button>
      </div>
      <div className="train-stats">
        <div>
          <b className="num">{h.week.sessions}</b>
          <span>sessions this week</span>
        </div>
        <div>
          <b className="num">{h.week.minutes}</b>
          <span>minutes</span>
        </div>
        <div>
          <b className="num">{h.week.strength}</b>
          <span>strength</span>
        </div>
        <div>
          <b className="num">{h.week.cardio}</b>
          <span>cardio</span>
        </div>
      </div>
      {h.workouts.length === 0 ? (
        <p className="empty">No workouts yet.</p>
      ) : (
        <ul>
          {h.workouts.slice(0, 6).map((w) => (
            <li key={w.id} className="workout">
              <span className="signal-icon">{WORKOUT_ICON[w.type]}</span>
              <span className="grow">
                <b>{w.name}</b>
                <span className="hint" style={{ display: 'block' }}>
                  {[w.durationMin && `${w.durationMin} min`, w.distanceKm && `${w.distanceKm} km`, w.exercises.length && `${w.exercises.length} exercises`, w.source !== 'manual' && w.source].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="faint" style={{ fontSize: 12.5 }}>
                {parseDay(w.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {adding && <WorkoutSheet onClose={() => setAdding(false)} />}
    </section>
  );
}

function BodySheet({ onClose }: { onClose: () => void }) {
  const [b, setB] = useState({ weight_kg: '', body_fat_pct: '', muscle_kg: '', visceral_fat: '' });
  const n = (s: string) => (s.trim() === '' ? null : Number(s));
  const save = useWrite(() => healthWrite.post('/body', { weight_kg: n(b.weight_kg), body_fat_pct: n(b.body_fat_pct), muscle_kg: n(b.muscle_kg), visceral_fat: n(b.visceral_fat) }));
  return (
    <Modal
      title="Body composition"
      onClose={onClose}
      footer={
        <>
          <span className="hint">Weight also updates your Weight metric.</span>
          <button className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onClose })}>
            Save reading
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Weight (kg)">
          <input className="input num" inputMode="decimal" value={b.weight_kg} onChange={(e) => setB({ ...b, weight_kg: e.target.value })} data-autofocus />
        </Field>
        <Field label="Body fat (%)">
          <input className="input num" inputMode="decimal" value={b.body_fat_pct} onChange={(e) => setB({ ...b, body_fat_pct: e.target.value })} />
        </Field>
        <Field label="Skeletal muscle (kg)">
          <input className="input num" inputMode="decimal" value={b.muscle_kg} onChange={(e) => setB({ ...b, muscle_kg: e.target.value })} />
        </Field>
        <Field label="Visceral fat (level)">
          <input className="input num" inputMode="decimal" value={b.visceral_fat} onChange={(e) => setB({ ...b, visceral_fat: e.target.value })} />
        </Field>
      </div>
      {save.error && <p className="error-text">{save.error.message}</p>}
    </Modal>
  );
}

function Trend({ values, good }: { values: number[]; good: 'up' | 'down' }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 100).toFixed(1)} ${(30 - ((v - min) / span) * 26).toFixed(1)}`).join(' ');
  const better = good === 'down' ? values.at(-1)! < values[0]! : values.at(-1)! > values[0]!;
  return (
    <svg className="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden style={{ height: 32, margin: '4px 0 0' }}>
      <path className="line" d={d} style={{ stroke: better ? 'var(--good)' : 'var(--bad)' }} />
    </svg>
  );
}

export function BodyCard({ h }: { h: HealthState }) {
  const { toast } = useApp();
  const [adding, setAdding] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const scan = useWrite((f: File) => {
    const form = new FormData();
    form.set('file', f);
    return postForm<HealthState>('/health/body/scan', form);
  });
  const last = h.body.at(-1);
  const first = h.body[0];
  const tiles: { label: string; key: 'weightKg' | 'bodyFatPct' | 'muscleKg' | 'visceralFat'; unit: string; good: 'up' | 'down' }[] = [
    { label: 'Weight', key: 'weightKg', unit: 'kg', good: 'down' },
    { label: 'Body fat', key: 'bodyFatPct', unit: '%', good: 'down' },
    { label: 'Skeletal muscle', key: 'muscleKg', unit: 'kg', good: 'up' },
    { label: 'Visceral fat', key: 'visceralFat', unit: '', good: 'down' },
  ];
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Body composition</h2>
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => file.current?.click()} disabled={scan.isPending} title="Photo of an InBody sheet or scale app">
            {scan.isPending ? <Spinner /> : <ScanLine size={13} />} Scan a result
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add
          </button>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && scan.mutate(e.target.files[0], { onSuccess: () => toast({ message: 'Reading added from the photo.' }), onError: (err) => toast({ message: err.message }) })} />
        </div>
      </div>
      {!last ? (
        <p className="empty">Add a reading from your scale or an InBody scan — or photograph the result.</p>
      ) : (
        <>
          <div className="metric-grid">
            {tiles.map((t) => {
              const series = h.body.map((r) => r[t.key]).filter((v): v is number => v !== null);
              const now = series.at(-1);
              const change = series.length > 1 ? now! - series[0]! : null;
              return (
                <div key={t.key} className="metric">
                  <div className="metric-name">{t.label}</div>
                  <div className="metric-value">
                    {now === undefined ? <span className="faint">—</span> : formatNumber(now)}
                    {now !== undefined && t.unit && <small>{t.unit}</small>}
                  </div>
                  {change !== null && (
                    <div className={cx('metric-delta', (t.good === 'down' ? change < 0 : change > 0) ? 'good' : change !== 0 && 'bad')}>
                      {change > 0 ? '+' : change < 0 ? '−' : '±'}
                      {formatNumber(Math.abs(Math.round(change * 10) / 10))} since {shortDay(first!.date)}
                    </div>
                  )}
                  <Trend values={series} good={t.good} />
                </div>
              );
            })}
          </div>
          <p className="hint" style={{ padding: '0 20px 16px' }}>
            Last reading {shortDay(last.date)}
            {last.source !== 'manual' ? ` · from ${last.source}` : ''}
            {last.bmr ? ` · BMR ${formatNumber(last.bmr)} kcal` : ''}
          </p>
        </>
      )}
      {adding && <BodySheet onClose={() => setAdding(false)} />}
    </section>
  );
}

export function HealthPanels() {
  const { data: h } = useHealth();
  if (!h) return null;
  return (
    <div className="health-panels">
      <NutritionCard h={h} />
      <div className="col">
        <BodyCard h={h} />
        <TrainingCard h={h} />
      </div>
    </div>
  );
}
