// Quran study: your place in the mushaf, with three ways into the ayah there — listen and
// repeat it (recitation), read what a mufassir wrote on it (tafsir), and write what it
// says to you (reflection). Text, translation and tafsir come from quran.com via the server.

import { useQuery } from '@tanstack/react-query';
import { BookOpen, Check, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { Note, QuranChapter, QuranStudy, QuranVerse } from '../../../shared/types.ts';
import { api, useWrite, write } from '../api.ts';
import { cx, plural, shortDay, todayStr } from '../lib.ts';
import { useApp } from '../state.tsx';
import { arabicDigits, PlayIcon, RECITER, useRecitation, type Track } from './recitation.tsx';
import { AutoTextarea, Seg } from './ui.tsx';

type Tab = 'recite' | 'tafsir' | 'reflect';

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

export function QuranStudyCard() {
  const { data: study } = useStudy();
  const { data: chapters, isError: chaptersFailed } = useChapters();
  const [tab, setTab] = useState<Tab>('recite');
  const [jumping, setJumping] = useState(false);
  const move = useWrite((key: string) => write.put('/quran/study', { key }));
  const mark = useWrite((key: string) => write.post('/quran/study/mark', { key }));
  const { data: verse, isError: verseFailed, refetch } = useQuery({
    queryKey: ['quran-verse', study?.key, study?.tafsir],
    queryFn: () => api<QuranVerse>('GET', `/quran/verse?key=${study!.key}&tafsir=${study!.tafsir}`),
    enabled: !!study,
    staleTime: Infinity,
    retry: 1,
  });
  if (!study) return null;
  const chapter = chapters?.[study.surah - 1];
  const failed = verseFailed || chaptersFailed;

  return (
    <section className="card quran-study" aria-label="Quran study">
      <div className="card-head">
        <div>
          <h2 className="card-title">Quran study</h2>
          <span className="hint">
            {study.week ? `${study.week} this week` : 'Nothing studied yet this week'}
            {study.streak > 1 && ` · ${study.streak}-day streak`}
          </span>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setJumping((j) => !j)} aria-expanded={jumping}>
          <BookOpen size={13} /> {chapter ? `${chapter.name} ${study.key}` : study.key}
        </button>
      </div>

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
        <div className="quran-failed">
          <p className="muted">quran.com couldn’t be reached just now, so the ayah can’t be shown.</p>
          <button type="button" className="btn btn-sm" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      ) : !verse ? (
        <div className="quran-loading" aria-busy>
          <span className="spinner" />
        </div>
      ) : (
        <>
          <p className="quran-arabic" lang="ar" dir="rtl">
            {verse.arabic} <span className="verse-end">﴿{arabicDigits(verse.ayah)}﴾</span>
          </p>
          <p className="quran-translation">{verse.translation}</p>

          <div className="quran-tabs">
            <Seg
              label="Study"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'recite', label: 'Recite' },
                { value: 'tafsir', label: 'Tafsir' },
                { value: 'reflect', label: 'Reflect' },
              ]}
            />
          </div>
          <div className="quran-panel">
            {tab === 'recite' && <RecitePanel verse={verse} />}
            {tab === 'tafsir' && <TafsirPanel verse={verse} study={study} />}
            {tab === 'reflect' && <ReflectPanel verse={verse} chapter={chapter} />}
          </div>
        </>
      )}

      {chapters && (
        <div className="quran-nav">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => move.mutate(prevKey(chapters, study.surah, study.ayah))} aria-label="Previous ayah">
            <ChevronLeft size={15} />
          </button>
          <button type="button" className={cx('btn btn-sm quran-mark', study.studiedToday ? 'btn-ghost' : 'btn-primary')} onClick={() => mark.mutate(study.key)} disabled={mark.isPending}>
            <Check size={14} /> {study.studiedToday ? 'Studied today · next' : 'Studied · next'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => move.mutate(nextKey(chapters, study.surah, study.ayah))} aria-label="Next ayah">
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </section>
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
  const [all, setAll] = useState(false);
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
