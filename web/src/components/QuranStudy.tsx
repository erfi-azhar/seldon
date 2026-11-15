// Quran study: your place in the mushaf, with three ways into the ayah there — listen and
// repeat it (recitation), read what a mufassir wrote on it (tafsir), and write what it
// says to you (reflection). The Faith sphere has a small card; studying happens on its own
// page at /quran. Text, translation and tafsir come from quran.com via the server.

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import type { Note, QuranChapter, QuranStudy, QuranVerse } from '../../../shared/types.ts';
import { api, useSpheres, useWrite, write } from '../api.ts';
import { cx, hueStyle, plural, shortDay, todayStr } from '../lib.ts';
import { useApp } from '../state.tsx';
import { PlayIcon, RECITER, useRecitation, type Track } from './recitation.tsx';
import { AutoTextarea, Loading, Seg } from './ui.tsx';
import { CheckableAyah } from './RecitationCheck.tsx';

const useStudy = () => useQuery({ queryKey: ['quran-study', todayStr()], queryFn: () => api<QuranStudy>('GET', '/quran/study') });
const useChapters = () => useQuery({ queryKey: ['quran-chapters'], queryFn: () => api<QuranChapter[]>('GET', '/quran/chapters'), staleTime: Infinity, retry: 1 });

function prevKey(list: QuranChapter[], surah: number, ayah: number): string {
  if (ayah > 1) return `${surah}:${ayah - 1}`;
  return surah > 1 ? `${surah - 1}:${list[surah - 2]!.verses}` : `114:${list[113]!.verses}`;
}
function nextKey(list: QuranChapter[], surah: number, ayah: number): string {
  if (ayah < list[surah - 1]!.verses) return `${surah}:${ayah + 1}`;
  return surah < 114 ? `${surah + 1}:1` : '1:1';
}

/** The ayah at your place, and the controls that move it. */
function useStudyPlace() {
  const { data: study } = useStudy();
  const { data: chapters, isError: chaptersFailed } = useChapters();
  const move = useWrite((key: string) => write.put('/quran/study', { key }));
  const mark = useWrite((key: string) => write.post('/quran/study/mark', { key }));
  const verseQuery = useQuery({
    queryKey: ['quran-verse', study?.key, study?.tafsir],
    queryFn: () => api<QuranVerse>('GET', `/quran/verse?key=${study!.key}&tafsir=${study!.tafsir}`),
    enabled: !!study,
    staleTime: Infinity,
    retry: 1,
  });
  return { study, chapters, chaptersFailed, move, mark, ...verseQuery };
}

const statsLine = (study: QuranStudy) =>
  `${study.week ? `${study.week} this week` : 'Nothing studied yet this week'}${study.streak > 1 ? ` · ${study.streak}-day streak` : ''}`;

/** In the Faith sphere: where you are, and the way into the study page. */
export function QuranStudyCard() {
  const { study, chapters, data: verse } = useStudyPlace();
  if (!study) return null;
  const chapter = chapters?.[study.surah - 1];
  const progress = chapter ? study.ayah / chapter.verses : 0;
  return (
    <section className="card quran-card" aria-label="Quran study">
      <div className="card-head">
        <div>
          <h2 className="card-title">Quran study</h2>
          <span className="hint">{statsLine(study)}</span>
        </div>
        {study.studiedToday && (
          <span className="quran-today">
            <Check size={12} /> Today
          </span>
        )}
      </div>
      <Link href="/quran" className="quran-card-body">
        <div className="quran-card-place">
          <b>{chapter?.name ?? `Surah ${study.surah}`}</b>
          <span>
            {chapter ? `${chapter.meaning} · ayah ${study.ayah} of ${chapter.verses}` : `Ayah ${study.ayah}`}
          </span>
        </div>
        {verse && (
          <p className="quran-card-arabic" lang="ar" dir="rtl">
            {verse.arabic}
          </p>
        )}
        <div className="quran-card-progress" aria-hidden>
          <i style={{ width: `${Math.max(2, progress * 100)}%` }} />
        </div>
      </Link>
      <div className="quran-card-foot">
        <span className="hint">Recite · Tafsir · Reflect</span>
        <Link href="/quran" className="btn btn-primary btn-sm">
          {study.total ? 'Continue studying' : 'Start studying'} <ArrowRight size={14} />
        </Link>
      </div>
    </section>
  );
}

/** The study page: one ayah at a time, with room to listen, read and write. */
export function QuranStudyPage() {
  const { study, chapters, chaptersFailed, move, mark, data: verse, isError: verseFailed, refetch } = useStudyPlace();
  const { data: spheres } = useSpheres();
  const [side, setSide] = useState<'tafsir' | 'reflect'>('tafsir');
  const [jumping, setJumping] = useState(false);
  const faith = spheres?.find((x) => x.key === 'faith');

  // ← and → step through the ayat, unless you are typing.
  useEffect(() => {
    if (!study || !chapters) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') move.mutate(prevKey(chapters, study.surah, study.ayah));
      if (e.key === 'ArrowRight') move.mutate(nextKey(chapters, study.surah, study.ayah));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [study, chapters, move]);

  if (!study) return <Loading />;
  const chapter = chapters?.[study.surah - 1];
  const failed = verseFailed || chaptersFailed;

  return (
    <div className="page tint quran-page" style={faith ? hueStyle(faith.hue) : undefined}>
      <Link href={faith ? `/spheres/${faith.id}` : '/spheres'} className="back">
        <ArrowLeft size={15} /> {faith?.name ?? 'Spheres'}
      </Link>

      <header className="quran-page-head">
        <div>
          <span className="quran-eyebrow">Quran study · {statsLine(study)}</span>
          <h1>
            {chapter?.name ?? `Surah ${study.surah}`} <span className="quran-page-arabic-name">{chapter?.nameArabic}</span>
          </h1>
          {chapter && (
            <p className="muted">
              {chapter.meaning} · ayah {study.ayah} of {chapter.verses}
            </p>
          )}
        </div>
        <div className="quran-page-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setJumping((j) => !j)} aria-expanded={jumping}>
            <BookOpen size={14} /> Go to an ayah
          </button>
          {chapters && (
            <div className="quran-nav">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => move.mutate(prevKey(chapters, study.surah, study.ayah))} aria-label="Previous ayah" title="Previous ayah (←)">
                <ChevronLeft size={15} />
              </button>
              <button
                type="button"
                className={cx('btn btn-sm quran-mark', study.studiedToday ? 'btn-ghost' : 'btn-primary')}
                onClick={() => mark.mutate(study.key)}
                disabled={mark.isPending}
              >
                <Check size={14} /> {study.studiedToday ? 'Studied today · next' : 'Studied · next'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => move.mutate(nextKey(chapters, study.surah, study.ayah))} aria-label="Next ayah" title="Next ayah (→)">
                <ChevronRight size={15} />
              </button>
            </div>
          )}
        </div>
      </header>

      {jumping && chapters && (
        <JumpTo
          chapters={chapters}
          study={study}
          onGo={(key) => {
            setJumping(false);
            move.mutate(key);
          }}
        />
      )}

      {failed ? (
        <section className="card quran-failed">
          <p className="muted">quran.com couldn’t be reached just now, so the ayah can’t be shown.</p>
          <button type="button" className="btn btn-sm" onClick={() => void refetch()}>
            Try again
          </button>
        </section>
      ) : !verse ? (
        <Loading />
      ) : (
        <div className="quran-page-grid">
          <section className="card quran-ayah">
            <div className="quran-ayah-recite">
              <RecitePanel verse={verse} />
            </div>
            <CheckableAyah verse={verse} />
            <span className="hint quran-source">
              {verse.translator} translation ·{' '}
              <a href={`https://quran.com/${verse.key}`} target="_blank" rel="noreferrer">
                {verse.key} on quran.com
              </a>
            </span>
          </section>

          <section className="card quran-side">
            <div className="quran-tabs">
              <Seg
                label="Study"
                value={side}
                onChange={setSide}
                options={[
                  { value: 'tafsir', label: 'Tafsir' },
                  { value: 'reflect', label: 'Reflect' },
                ]}
              />
            </div>
            <div className="quran-panel">
              {side === 'tafsir' ? <TafsirPanel verse={verse} study={study} /> : <ReflectPanel verse={verse} chapter={chapter} />}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function JumpTo({ chapters, study, onGo }: { chapters: QuranChapter[]; study: QuranStudy; onGo: (key: string) => void }) {
  const [surah, setSurah] = useState(study.surah);
  const [ayah, setAyah] = useState(String(study.ayah));
  const max = chapters[surah - 1]!.verses;
  const n = Number(ayah);
  const ok = Number.isInteger(n) && n >= 1 && n <= max;
  return (
    <form
      className="quran-jump"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onGo(`${surah}:${n}`);
      }}
    >
      <select className="select" value={surah} onChange={(e) => (setSurah(Number(e.target.value)), setAyah('1'))} aria-label="Surah">
        {chapters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id}. {c.name} · {c.meaning}
          </option>
        ))}
      </select>
      <input className="input" type="number" min={1} max={max} value={ayah} onChange={(e) => setAyah(e.target.value)} aria-label={`Ayah, 1 to ${max}`} />
      <button type="submit" className="btn btn-primary btn-sm" disabled={!ok}>
        Go
      </button>
      <span className="hint">1–{max}</span>
    </form>
  );
}

const REPEATS = [1, 3, 5, 10] as const;

function RecitePanel({ verse }: { verse: QuranVerse }) {
  const [times, setTimes] = useState<number>(1);
  const { pb, toggle } = useRecitation();
  // The same ayah, queued the number of times chosen; `verse` counts the round.
  const tracks: Track[] = Array.from({ length: times }, (_, i) => ({ surah: verse.surah, ayah: verse.ayah, verse: i }));
  const set = `study:${verse.key}:${times}`;
  const active = (pb.state === 'playing' || pb.state === 'paused' || pb.state === 'loading') && pb.set === set ? pb : null;
  const state = active ? (active.state === 'paused' ? 'other' : active.state) : 'other';
  return (
    <div className="quran-recite">
      <button type="button" className={cx('verse-play', state === 'playing' && 'is-playing')} onClick={() => toggle(set, tracks)} aria-label={state === 'playing' ? 'Pause' : 'Play recitation'}>
        <PlayIcon state={state} />
      </button>
      <div className="quran-recite-body">
        <div className="row-wrap" style={{ gap: 8 }}>
          <span className="hint">Repeat</span>
          <Seg label="Repeat" value={String(times)} onChange={(v) => setTimes(Number(v))} options={REPEATS.map((n) => ({ value: String(n), label: `${n}×` }))} />
        </div>
        <span className="hint">
          {pb.state === 'error'
            ? 'The recitation couldn’t load — try again'
            : active && times > 1
              ? `Listening ${active.track.verse + 1} of ${times}`
              : `${RECITER}. Listen, then recite it back from memory.`}
        </span>
      </div>
    </div>
  );
}

function TafsirPanel({ verse, study }: { verse: QuranVerse; study: QuranStudy }) {
  // Beside the ayah on a wide screen there's room for all of it; on a phone, start folded.
  const [all, setAll] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 861px)').matches);
  const choose = useWrite((tafsir: number) => write.put('/quran/study', { tafsir }));
  const t = verse.tafsir;
  const covers = t && t.covers.length > 1 ? `${t.covers[0]}–${t.covers.at(-1)!.split(':')[1]}` : null;
  const blocks = t ? (all ? t.blocks : t.blocks.slice(0, 5)) : [];
  return (
    <div className="quran-tafsir">
      <div className="row-wrap" style={{ gap: 8, justifyContent: 'space-between' }}>
        <select className="select mini-select" value={study.tafsir} onChange={(e) => choose.mutate(Number(e.target.value))} aria-label="Tafsir">
          {study.tafsirs.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        {covers && <span className="hint">One passage on {covers}</span>}
      </div>
      {!t ? (
        <p className="muted">This tafsir has nothing on {verse.key}.</p>
      ) : (
        <>
          <div className="tafsir-text">
            {blocks.map((b, i) =>
              b.kind === 'h' ? (
                <h4 key={i}>{b.text}</h4>
              ) : b.kind === 'ar' ? (
                <p key={i} lang="ar" dir="rtl" className="tafsir-ar">
                  {b.text}
                </p>
              ) : (
                <p key={i}>{b.text}</p>
              ),
            )}
          </div>
          {t.blocks.length > 5 && (
            <button type="button" className="link" onClick={() => setAll((a) => !a)}>
              {all ? 'Show less' : `Read all (${t.blocks.length - 5} more paragraphs)`}
            </button>
          )}
          <span className="hint quran-source">From {t.name}, via quran.com</span>
        </>
      )}
    </div>
  );
}

const PROMPTS = ['What is this ayah asking of me?', 'What does it show me about Allah?', 'Where does it meet my life this week?'];

function ReflectPanel({ verse, chapter }: { verse: QuranVerse; chapter: QuranChapter | undefined }) {
  const { ask } = useApp();
  const [text, setText] = useState('');
  const [prompt, setPrompt] = useState(PROMPTS[0]!);
  const { data: past = [] } = useQuery({ queryKey: ['quran-reflections', verse.key], queryFn: () => api<Note[]>('GET', `/quran/reflections?key=${verse.key}`) });
  const save = useWrite((body: string) => write.post('/quran/reflections', { key: verse.key, text: body }));
  const name = chapter ? `${chapter.name} ${verse.key}` : verse.key;
  return (
    <div className="quran-reflect">
      <div className="row-wrap" style={{ gap: 6 }}>
        {PROMPTS.map((p) => (
          <button key={p} type="button" className={cx('chip', p === prompt ? 'chip-act' : 'chip-outline')} onClick={() => setPrompt(p)}>
            {p}
          </button>
        ))}
      </div>
      <AutoTextarea className="textarea" minRows={3} value={text} onChange={setText} placeholder={prompt} maxLength={5000} aria-label={`Reflection on ${name}`} />
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() =>
            ask(
              `Help me reflect on ${name}. Here is the ayah as quran.com gives it:\n\n${verse.arabic}\n\n“${verse.translation}” (${verse.translator})\n\n` +
                `I'm asking myself: ${prompt} Help me think it through with questions rather than answers. Stay with this ayah's own words; don't quote other ayat or tafsir from memory, and say plainly when something is your own reflection rather than scholarship.`,
            )
          }
        >
          <Sparkles size={13} /> Reflect with Seldon
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!text.trim() || save.isPending} onClick={() => save.mutate(text, { onSuccess: () => setText('') })}>
          Save reflection
        </button>
      </div>
      {past.length > 0 && (
        <div className="quran-past">
          <span className="hint">{plural(past.length, 'earlier reflection')} on this ayah</span>
          {past.map((n) => (
            <figure key={n.id}>
              <figcaption>{shortDay(todayStr(new Date(n.createdAt)))}</figcaption>
              <p>{n.body}</p>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
