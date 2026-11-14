import { useQuery } from '@tanstack/react-query';
import { AlertCircle, FileText, Image as ImageIcon, Link2, Pin, Play, Plus, Search, Sparkles, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Note, NoteKind } from '../../../shared/types.ts';
import { api, useNotes, useWrite, write } from '../api.ts';
import { Loading, Seg, SphereChip, SphereSelect, Spinner } from '../components/ui.tsx';
import { cx, monthDay, shortDay, todayStr, weekdayLong } from '../lib.ts';
import { useApp } from '../state.tsx';

type Kind = 'all' | 'saved' | NoteKind;

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Paste a link (or some text), or add a picture; Seldon files it. */
function CaptureBar() {
  const [value, setValue] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const { toast, agentName } = useApp();
  const save = useWrite((body: object) => write.post<Note>('/capture', body));
  const upload = useWrite(async (f: File) => {
    const form = new FormData();
    form.set('file', f);
    const res = await fetch('/api/capture', { method: 'POST', body: form, credentials: 'same-origin' });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Upload failed');
    return res.json();
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (!text) return;
    save.mutate(/^https?:\/\/\S+$/i.test(text) ? { url: text } : { text }, {
      onSuccess: () => (setValue(''), toast({ message: `Saved — ${agentName} is reading it.` })),
      onError: (err) => toast({ message: err.message }),
    });
  };

  return (
    <form
      className="capture-bar"
      onSubmit={submit}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) upload.mutate(f, { onError: (err) => toast({ message: err.message }) });
      }}
    >
      <Sparkles size={17} className="faint" aria-hidden />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPaste={(e) => {
          const f = e.clipboardData.files[0];
          if (f) {
            e.preventDefault();
            upload.mutate(f, { onError: (err) => toast({ message: err.message }) });
          }
        }}
        placeholder={`Paste a link — a post, a TikTok, an article — and ${agentName} will file it`}
        aria-label="Save a link"
      />
      <button type="button" className="icon-btn" aria-label="Add a picture" title="Add a picture" onClick={() => file.current?.click()}>
        {upload.isPending ? <Spinner /> : <Upload size={17} />}
      </button>
      <input ref={file} type="file" accept="image/*,application/pdf" hidden onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0], { onError: (err) => toast({ message: err.message }) })} />
      <button type="submit" className="btn btn-primary btn-sm" disabled={!value.trim() || save.isPending}>
        Save
      </button>
    </form>
  );
}

const KIND_ICON = { video: <Play size={12} fill="currentColor" />, image: <ImageIcon size={12} />, pdf: <FileText size={12} />, tweet: <span className="x-mark">𝕏</span>, article: <FileText size={12} />, link: <Link2 size={12} />, text: <Sparkles size={12} /> } as const;

function CaptureCard({ n, onOpen }: { n: Note; onOpen: () => void }) {
  const c = n.capture!;
  const reread = useWrite(() => write.post(`/notes/${n.id}/reprocess`));
  if (n.status === 'processing')
    return (
      <div className="note-card capture-card is-processing" aria-busy="true">
        <div className="capture-shimmer" />
        <span className="note-url">
          <Spinner /> Reading {c.site || 'it'}…
        </span>
      </div>
    );
  return (
    <button type="button" className={cx('note-card capture-card', n.status === 'failed' && 'is-failed')} onClick={onOpen}>
      {c.imageFileId && (
        <div className={cx('capture-image', c.kind === 'video' && 'is-video')}>
          <img src={`/api/files/${c.imageFileId}`} alt="" loading="lazy" />
          {c.kind === 'video' && (
            <span className="play">
              <Play size={16} fill="currentColor" />
            </span>
          )}
        </div>
      )}
      <span className="capture-kind">
        {KIND_ICON[c.kind]} {c.site || c.kind}
        {c.author ? ` · ${c.author}` : ''}
      </span>
      <h4>{n.title || host(n.url)}</h4>
      {c.summary && <p className="note-body">{c.summary}</p>}
      {n.status === 'failed' && (
        <span className="note-url error-text">
          <AlertCircle size={13} /> {c.error}{' '}
          <span
            role="button"
            tabIndex={0}
            className="link"
            onClick={(e) => (e.stopPropagation(), reread.mutate())}
            onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), reread.mutate())}
          >
            Try again
          </span>
        </span>
      )}
      {c.tags.length > 0 && (
        <span className="row-wrap" style={{ gap: 4 }}>
          {c.tags.slice(0, 4).map((t) => (
            <span key={t} className="tag-chip">
              #{t}
            </span>
          ))}
        </span>
      )}
      <span className="note-foot">
        <span className="row" style={{ gap: 6 }}>
          <SphereChip id={n.sphereId} />
          {c.collection && <span className="chip">{c.collection}</span>}
        </span>
        <span>{shortDay(todayStr(new Date(n.createdAt)))}</span>
      </span>
    </button>
  );
}

export function Library() {
  const [kind, setKind] = useState<Kind>('all');
  const [sphereId, setSphereId] = useState<string | null>(null);
  const [collection, setCollection] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const { openSheet } = useApp();
  const { data: collections = [] } = useQuery({ queryKey: ['collections'], queryFn: () => api<string[]>('GET', '/capture/collections') });

  // Search as you type, a beat behind the keystrokes.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  const saved = kind === 'saved';
  const { data: notes } = useNotes({ kind: kind === 'all' || saved ? undefined : kind, saved, sphereId: sphereId ?? undefined, q: q || undefined, collection: saved ? (collection ?? undefined) : undefined });
  const filtered = kind !== 'all' || sphereId !== null || q !== '';

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Library</h1>
          <p className="page-sub">Everything you've kept — saved links and pictures, notes, and every day's journal.</p>
        </div>
        <button type="button" className="btn" onClick={() => openSheet({ kind: 'new-note', sphereId: sphereId ?? undefined })}>
          <Plus size={15} /> New note
        </button>
      </header>

      <CaptureBar />

      <div className="toolbar">
        <Seg
          label="Kind"
          value={kind}
          onChange={(k) => (setKind(k), setCollection(null))}
          options={[
            { value: 'all', label: 'All' },
            { value: 'saved', label: 'Saved' },
            { value: 'note', label: 'Notes' },
            { value: 'journal', label: 'Journal' },
          ]}
        />
        <SphereSelect className="mini" value={sphereId} onChange={setSphereId} noneLabel="Every sphere" />
        <div className="search-input">
          <Search size={15} />
          <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the library" aria-label="Search the library" />
        </div>
      </div>
      {saved && collections.length > 0 && (
        <div className="row-wrap" style={{ gap: 6, marginTop: -8, marginBottom: 18 }}>
          {collections.map((c) => (
            <button key={c} type="button" className={cx('chip', collection === c ? 'chip-on' : 'chip-outline')} onClick={() => setCollection(collection === c ? null : c)}>
              {c}
            </button>
          ))}
        </div>
      )}

      {!notes ? (
        <Loading />
      ) : notes.length === 0 ? (
        <div className="empty-block">
          <h3>{filtered ? 'Nothing matches' : 'Nothing kept yet'}</h3>
          <p style={{ maxWidth: '44ch' }}>{filtered ? 'Try a different filter or search.' : "Paste a link above, share one from your phone, or write in today's journal — it all collects here."}</p>
        </div>
      ) : (
        <div className="masonry">
          {notes.map((n) => {
            if (n.capture) return <CaptureCard key={n.id} n={n} onOpen={() => openSheet({ kind: 'note', id: n.id })} />;
            const journal = n.kind === 'journal';
            return (
              <button key={n.id} type="button" className={cx('note-card', journal && 'is-journal')} onClick={() => openSheet({ kind: 'note', id: n.id })}>
                {journal ? (
                  <>
                    <span className="eyebrow">{weekdayLong(n.date!)}</span>
                    <h4>{monthDay(n.date!)}</h4>
                  </>
                ) : (
                  (n.title || n.url) && <h4>{n.title || host(n.url)}</h4>
                )}
                {n.body && <p className="note-body">{n.body}</p>}
                {n.url && (
                  <span className="note-url">
                    <Link2 size={13} /> {host(n.url)}
                  </span>
                )}
                {!journal && (
                  <span className="note-foot">
                    <span className="row" style={{ gap: 6 }}>
                      {n.pinned && <Pin size={12} />}
                      <SphereChip id={n.sphereId} />
                    </span>
                    <span>{shortDay(todayStr(new Date(n.updatedAt)))}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
