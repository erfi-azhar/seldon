import { Link2, Pin, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { NoteKind } from '../../../shared/types.ts';
import { useNotes } from '../api.ts';
import { Loading, Seg, SphereChip, SphereSelect } from '../components/ui.tsx';
import { cx, monthDay, shortDay, todayStr, weekdayLong } from '../lib.ts';
import { useApp } from '../state.tsx';

type Kind = 'all' | NoteKind;

function host(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function Library() {
  const [kind, setKind] = useState<Kind>('all');
  const [sphereId, setSphereId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const { openSheet } = useApp();

  // Search as you type, a beat behind the keystrokes.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  const { data: notes } = useNotes({ kind: kind === 'all' ? undefined : kind, sphereId: sphereId ?? undefined, q: q || undefined });
  const filtered = kind !== 'all' || sphereId !== null || q !== '';

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Library</h1>
          <p className="page-sub">Notes, links and every day's journal — everything you've kept.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => openSheet({ kind: 'new-note', sphereId: sphereId ?? undefined })}>
          <Plus size={15} /> New note
        </button>
      </header>

      <div className="toolbar">
        <Seg
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'All' },
            { value: 'note', label: 'Notes' },
            { value: 'link', label: 'Links' },
            { value: 'journal', label: 'Journal' },
          ]}
        />
        <SphereSelect className="mini" value={sphereId} onChange={setSphereId} noneLabel="Every sphere" />
        <div className="search-input">
          <Search size={15} />
          <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the library" aria-label="Search the library" />
        </div>
      </div>

      {!notes ? (
        <Loading />
      ) : notes.length === 0 ? (
        <div className="empty-block">
          <h3>{filtered ? 'Nothing matches' : 'Nothing kept yet'}</h3>
          <p style={{ maxWidth: '44ch' }}>{filtered ? 'Try a different filter or search.' : 'Save an idea, paste a link, or write in today\'s journal — it all collects here.'}</p>
        </div>
      ) : (
        <div className="masonry">
          {notes.map((n) => {
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
