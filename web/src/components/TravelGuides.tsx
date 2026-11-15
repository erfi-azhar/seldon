// Travel guides in the Travels sphere: places you're researching. Each has its own page where you
// drop in research (links, notes, screenshots, PDFs, read and summarised like anything you save)
// and Seldon builds a guide from it, every item pointing back to the material it came from.

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, Camera, ChevronRight, Compass, ExternalLink, Globe, Landmark, Lightbulb, Link2, Loader2, MapPin, Plus, ShieldAlert, ShoppingBag, Sparkles, Ticket, TrainFront, UtensilsCrossed, Wallet, X, BedDouble, Handshake, PiggyBank } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import type { Note, PlaceGuideSection, TravelGuide, TravelGuideSummary } from '../../../shared/types.ts';
import { api, postForm, useWrite, write } from '../api.ts';
import { cx, plural } from '../lib.ts';
import { useApp } from '../state.tsx';
import { Spinner } from './ui.tsx';

const useGuides = () => useQuery({ queryKey: ['guides'], queryFn: () => api<{ guides: TravelGuideSummary[] }>('GET', '/guides') });
// While a material is still being read, look again every few seconds.
const useGuide = (id: string) =>
  useQuery({
    queryKey: ['guide', id],
    queryFn: () => api<TravelGuide>('GET', `/guides/${id}`),
    refetchInterval: (q) => (q.state.data?.materials.some((m) => m.status === 'processing') ? 4000 : false),
  });

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** The Travel guides card on the Travels page: one tile per place, and a box to start another. */
export function TravelGuides() {
  const { data } = useGuides();
  const [, navigate] = useLocation();
  const [place, setPlace] = useState('');
  const create = useWrite((p: string) => write.post<TravelGuide>('/guides', { place: p }));
  const start = () => {
    if (!place.trim()) return;
    create.mutate(place.trim(), { onSuccess: (g) => navigate(`/guides/${g.id}`) });
  };
  const guides = data?.guides ?? [];
  return (
    <section className="card guides-card">
      <div className="card-head">
        <h2 className="card-title">
          <Compass size={15} /> Travel guides
        </h2>
      </div>
      <div className="guides-body">
        {guides.length === 0 && <p className="empty">Gather links, notes and screenshots about a place, and Seldon builds a guide from them.</p>}
        {guides.length > 0 && (
          <div className="guides-list">
            {guides.map((g) => (
              <Link key={g.id} href={`/guides/${g.id}`} className="guide-tile">
                <span className="guide-tile-icon" aria-hidden>
                  <Globe size={16} />
                </span>
                <span className="guide-tile-text">
                  <b>{g.place}</b>
                  <small>
                    {plural(g.materials, 'material')} · {g.builtAt ? `guide built ${when(g.builtAt)}` : 'not built yet'}
                  </small>
                </span>
                <ChevronRight size={16} className="faint" aria-hidden />
              </Link>
            ))}
          </div>
        )}
        <form
          className="guides-new"
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <input className="input" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="A place to research: Kyoto, the Amalfi Coast…" maxLength={80} aria-label="New travel guide" />
          <button type="submit" className="btn btn-sm" disabled={!place.trim() || create.isPending}>
            {create.isPending ? <Spinner /> : <Plus size={14} />} New guide
          </button>
        </form>
        {create.error && <p className="error-text">{create.error.message}</p>}
      </div>
    </section>
  );
}

const ICON: Record<PlaceGuideSection['kind'], ReactNode> = {
  see: <Landmark size={15} aria-hidden />,
  do: <Ticket size={15} aria-hidden />,
  food: <UtensilsCrossed size={15} aria-hidden />,
  areas: <MapPin size={15} aria-hidden />,
  stay: <BedDouble size={15} aria-hidden />,
  transport: <TrainFront size={15} aria-hidden />,
  safety: <ShieldAlert size={15} aria-hidden />,
  money: <Wallet size={15} aria-hidden />,
  etiquette: <Handshake size={15} aria-hidden />,
  shopping: <ShoppingBag size={15} aria-hidden />,
  budget: <PiggyBank size={15} aria-hidden />,
  tips: <Lightbulb size={15} aria-hidden />,
};

/** One place: its materials on one side, the guide built from them on the other. */
export function GuidePage({ id }: { id: string }) {
  const { spheres, agentName } = useApp();
  const travels = spheres.find((s) => s.key === 'travels');
  const { data: g, isError } = useGuide(id);
  const [focus, setFocus] = useState<string | null>(null);
  const back = (
    <Link href={travels ? `/spheres/${travels.id}` : '/spheres'} className="back">
      <ArrowLeft size={15} /> {travels?.name ?? 'Spheres'}
    </Link>
  );
  if (!g)
    return (
      <div className="page">
        {back}
        {isError && (
          <div className="empty-block">
            <h3>This guide isn't here</h3>
            <p>It may have been deleted.</p>
          </div>
        )}
      </div>
    );
  return (
    <div className="page guide-page">
      {back}
      <header className="page-head">
        <div>
          <h1 className="page-title">{g.place}</h1>
          <p className="guide-page-sub">
            {plural(g.materials.length, 'material')} · {g.builtAt ? `guide built ${when(g.builtAt)}` : 'guide not built yet'}
          </p>
        </div>
      </header>
      <div className="guide-cols">
        <Materials guide={g} focus={focus} />
        <BuiltGuide guide={g} agentName={agentName} onSource={(noteId) => setFocus(noteId)} />
      </div>
    </div>
  );
}

function Materials({ guide: g, focus }: { guide: TravelGuide; focus: string | null }) {
  const [text, setText] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const add = useWrite((body: { text: string }) => write.post(`/guides/${g.id}/materials`, body));
  const upload = useWrite((f: File) => {
    const form = new FormData();
    form.append('file', f);
    return postForm(`/guides/${g.id}/materials`, form);
  });
  const remove = useWrite((noteId: string) => write.del(`/guides/${g.id}/materials/${noteId}`));
  const notes = useWrite((v: string) => write.patch(`/guides/${g.id}`, { notes: v }));
  return (
    <section className="card guide-materials">
      <div className="card-head">
        <h2 className="card-title">
          <BookOpen size={15} /> Research
        </h2>
      </div>
      <div className="guide-materials-body">
        <label className="guide-notes">
          <small>What's the trip about?</small>
          <input className="input" defaultValue={g.notes} placeholder="A week in December, museums, halal food, a day trip…" maxLength={2000} onBlur={(e) => e.target.value !== g.notes && notes.mutate(e.target.value)} />
        </label>
        <form
          className="guide-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) add.mutate({ text: text.trim() }, { onSuccess: () => setText('') });
          }}
        >
          <textarea className="textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a link, or jot down a tip, a place, a quote from a friend…" maxLength={20000} />
          <div className="guide-add-row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => file.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? <Spinner /> : <Camera size={14} />} Screenshot or PDF
            </button>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" hidden onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0], { onSettled: () => (e.target.value = '') })} />
            <button type="submit" className="btn btn-sm" disabled={!text.trim() || add.isPending}>
              {add.isPending ? <Spinner /> : <Plus size={14} />} Add
            </button>
          </div>
        </form>
        {(add.error || upload.error) && <p className="error-text">{(add.error ?? upload.error)!.message}</p>}
        {g.materials.length === 0 ? (
          <p className="empty">Nothing yet. Links are read and summarised; pictures and PDFs too.</p>
        ) : (
          <ul className="guide-mats">
            {[...g.materials].reverse().map((m) => (
              <MaterialRow key={m.id} m={m} focused={focus === m.id} onRemove={() => remove.mutate(m.id)} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function MaterialRow({ m, focused, onRemove }: { m: Note; focused: boolean; onRemove: () => void }) {
  const c = m.capture;
  const thumb = c?.imageFileId ? `/api/files/${c.imageFileId}` : null;
  return (
    <li id={`mat-${m.id}`} className={cx('guide-mat', focused && 'is-focused')}>
      {thumb ? <img src={thumb} alt="" className="guide-mat-thumb" loading="lazy" /> : <span className="guide-mat-icon">{m.url ? <Link2 size={14} /> : <BookOpen size={14} />}</span>}
      <span className="guide-mat-text">
        <b>{m.title || (m.url ? c?.site : 'Note') || 'Saved'}</b>
        {m.status === 'processing' ? (
          <small className="guide-mat-reading">
            <Loader2 size={11} className="spin" aria-hidden /> Reading…
          </small>
        ) : (
          // A typed note's title is its opening words: show the rest only when there is more.
          (c?.summary || m.body.length > m.title.length) && <small>{c?.summary || m.body.slice(0, 240)}</small>
        )}
        {m.url && (
          <a href={m.url} target="_blank" rel="noreferrer" className="guide-mat-link">
            <ExternalLink size={11} aria-hidden /> {c?.site || new URL(m.url).hostname}
          </a>
        )}
      </span>
      <button type="button" className="icon-btn icon-btn-sm" aria-label="Take off this guide" title="Take off this guide (it stays in the Library)" onClick={onRemove}>
        <X size={13} />
      </button>
    </li>
  );
}

function BuiltGuide({ guide: g, agentName, onSource }: { guide: TravelGuide; agentName: string; onSource: (noteId: string) => void }) {
  const build = useWrite(() => write.post(`/guides/${g.id}/build`));
  const reading = g.materials.some((m) => m.status === 'processing');
  const titleOf = (id: string) => g.materials.find((m) => m.id === id)?.title || 'a material';
  const jump = (id: string) => {
    onSource(id);
    document.getElementById(`mat-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const button = (
    <button type="button" className="btn btn-sm" disabled={build.isPending} onClick={() => build.mutate(undefined)}>
      {build.isPending ? <Spinner /> : <Sparkles size={13} />} {g.guide ? 'Rebuild' : `Build the guide with ${agentName}`}
    </button>
  );
  return (
    <section className="card guide-built">
      <div className="card-head">
        <h2 className="card-title">
          <Compass size={15} /> Guide
        </h2>
        {g.guide && button}
      </div>
      <div className="guide-built-body">
        {build.error && <p className="error-text">{build.error.message}</p>}
        {reading && <p className="hint">Some research is still being read; build again once it's done to include it.</p>}
        {!g.guide ? (
          <div className="guide-built-empty">
            <p className="empty">Add what you've found, then {agentName} builds the guide: what to see and do, where to eat (halal), areas, getting around, safety, money, and sample days, each pointing back to your research.</p>
            {button}
          </div>
        ) : (
          <>
            <p className="pg-overview">{g.guide.overview}</p>
            {g.guide.bestTime && (
              <p className="pg-best">
                <b>Best time:</b> {g.guide.bestTime}
              </p>
            )}
            <div className="pg-sections">
              {g.guide.sections.map((s) => (
                <section key={s.kind + s.title} className={cx('pg-sec', s.kind === 'safety' && 'is-safety')}>
                  <h3>
                    {ICON[s.kind]} {s.title}
                  </h3>
                  <ul>
                    {s.items.map((i) => (
                      <li key={i.name + i.text}>
                        {i.name && <b>{i.name}</b>} {i.text}
                        {i.sources.length > 0 && (
                          <span className="pg-sources">
                            {i.sources.map((src) => (
                              <button key={src} type="button" className="pg-source" title={titleOf(src)} onClick={() => jump(src)}>
                                {titleOf(src).slice(0, 28)}
                              </button>
                            ))}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            {g.guide.days && g.guide.days.length > 0 && (
              <section className="pg-days">
                <h3>Sample days</h3>
                <div className="pg-days-grid">
                  {g.guide.days.map((d) => (
                    <div key={d.title} className="pg-day">
                      <b>{d.title}</b>
                      <ol>
                        {d.items.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </section>
  );
}
