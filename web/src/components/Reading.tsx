// The reading list, in the Learning sphere: books stand on a shelf spine-out, each in its
// cover's colour. Point at one and it turns to show its cover; open it and the book sits
// in your hand, tilting as you move, with its synopsis, ratings and where to buy it.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Plus, RefreshCw, Search, ShoppingBag, Trash2, X } from 'lucide-react';
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Book, BookCandidate, BookStatus } from '../../../shared/types.ts';
import { booksWrite, useBooks, useWrite } from '../api.ts';
import { cx, plural, shortDay, todayStr } from '../lib.ts';
import { useApp } from '../state.tsx';
import { InlineEdit, Modal, ScrollBlur, Seg, Spinner, useDialogFocus, useScrollEdges } from './ui.tsx';

// ── Colour and size ─────────────────────────────────────────────────────────

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
};

/** Cloth and paper colours for a book with no cover to read one from. */
const BINDINGS = ['#1f3a5f', '#7a2e2e', '#2f4f3a', '#c9a227', '#3d2b56', '#e9e2d0', '#0f4c5c', '#b5651d', '#264653', '#8f2d3c', '#d8cbb3', '#33415c'];

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** Ink that reads on a binding of this colour. */
const inkOn = (hex: string) => (luminance(hex) > 0.36 ? '#1b1a17' : '#fbf8f1');

/** The spine's colour: the cover's left edge, averaged. Same-origin, so the canvas can be read. */
async function readSpineColour(src: string): Promise<string | null> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const w = 24;
  const h = 36;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, 3, h);
  let r = 0;
  let g = 0;
  let b = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i]!;
    g += data[i + 1]!;
    b += data[i + 2]!;
  }
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Spine colours being read right now, so two renders don't both read one. */
const reading = new Set<string>();

/** The book's binding colour: saved, else read from its cover once (and saved), else one picked by its title. */
function useBinding(book: Book): string {
  const qc = useQueryClient();
  const fallback = BINDINGS[hash(book.title) % BINDINGS.length]!;
  useEffect(() => {
    if (book.color || !book.cover || reading.has(book.id)) return;
    reading.add(book.id);
    readSpineColour(book.cover)
      .then(async (color) => {
        if (!color) return;
        const saved = await booksWrite.patch(book.id, { color });
        qc.setQueryData<Book[]>(['books'], (list) => list?.map((b) => (b.id === saved.id ? saved : b)));
      })
      .catch(() => undefined)
      .finally(() => reading.delete(book.id));
  }, [book.id, book.color, book.cover, qc]);
  return book.color || fallback;
}

/** Thicker books have wider spines; and not every book is the same height. */
function spineSize(book: Book) {
  const s = book.pages ? Math.round(Math.min(60, Math.max(28, 20 + book.pages / 13))) : 36;
  const h = 228 + (hash(book.id) % 26);
  return { s, h, c: Math.round(h * 0.66) };
}

/** What a spine has room for: the first author's surname ("Munger" for "Charles T. Munger"). */
const surname = (author: string) => {
  const first = author.split(',')[0]!.trim();
  return first.split(/\s+/).filter((w) => !/^(jr|sr|ii|iii|phd)\.?$/i.test(w)).pop() ?? first;
};

const STATUS_LABEL: Record<BookStatus, string> = { want: 'Want to read', reading: 'Reading', read: 'Read' };

// ── The shelf ───────────────────────────────────────────────────────────────

type Shelf = 'shelf' | 'read';

export function ReadingList() {
  const { data: books } = useBooks();
  const [shelf, setShelf] = useState<Shelf>('shelf');
  const [open, setOpen] = useState<{ id: string; origin: Origin | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const all = books ?? [];
  // Books being read lead the shelf; the rest keep the order they were added in, newest first.
  const onShelf = [...all.filter((b) => b.status === 'reading'), ...all.filter((b) => b.status === 'want')];
  const done = all.filter((b) => b.status === 'read').sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
  const shown = shelf === 'shelf' ? onShelf : done;
  const scroll = useScrollEdges<HTMLDivElement>('x', [shown.length, shelf]);
  const current = all.find((b) => b.id === open?.id) ?? null;

  return (
    <section className="card reading-card">
      <div className="card-head">
        <div className="row" style={{ gap: 10 }}>
          <h2 className="card-title">Reading list</h2>
          {all.length > 0 && <span className="hint">{shelf === 'shelf' ? plural(onShelf.length, 'book') : `${done.length} finished`}</span>}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {done.length > 0 && (
            <Seg
              label="Which books"
              value={shelf}
              onChange={setShelf}
              options={[
                { value: 'shelf', label: 'To read' },
                { value: 'read', label: 'Read' },
              ]}
            />
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add a book
          </button>
        </div>
      </div>

      {books && shown.length === 0 ? (
        <button type="button" className="shelf-empty" onClick={() => setAdding(true)}>
          <span className="shelf-ghosts" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            <b>{shelf === 'shelf' ? 'Your shelf is empty' : 'Nothing finished yet'}</b>
            <span className="muted">{shelf === 'shelf' ? 'Add a book you want to read. Its cover, synopsis and ratings are found for you.' : 'Books you finish move here.'}</span>
          </span>
        </button>
      ) : (
        <div className="blur-wrap shelf-wrap">
          <div className="shelf" ref={scroll.ref} onScroll={scroll.onScroll} role="list" aria-label={shelf === 'shelf' ? 'Books to read' : 'Books read'}>
            {shown.map((b) => (
              <Spine key={b.id} book={b} away={open?.id === b.id} onOpen={(origin) => setOpen({ id: b.id, origin })} />
            ))}
          </div>
          <ScrollBlur axis="x" edges={scroll.edges} />
        </div>
      )}

      {adding && (
        <AddBookSheet
          onClose={() => setAdding(false)}
          onAdded={(b) => {
            setAdding(false);
            setShelf(b.status === 'read' ? 'read' : 'shelf');
            setOpen({ id: b.id, origin: null });
          }}
        />
      )}
      {current && <BookModal key={current.id} book={current} origin={open?.origin ?? null} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** Where a book left the shelf from: its place on screen, how it was turned, and its cover's shape. */
interface Origin {
  rect: Box;
  /** The 3D book's turn that matches how it stood: 90° spine-out, 16° when pointed at (cover showing). */
  angle: number;
  aspect: number | null;
}
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
const boxOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height });

/** The shelf slot a book stands in, to fly it back to. */
const slotOf = (id: string) => document.querySelector<HTMLElement>(`[data-book-slot="${CSS.escape(id)}"]`);

function Spine({ book, away, onOpen }: { book: Book; away: boolean; onOpen: (origin: Origin) => void }) {
  const colour = useBinding(book);
  const { s, h, c } = spineSize(book);
  const style = { '--s': `${s}px`, '--c': `${c}px`, '--bh': `${h}px`, '--binding': colour, '--binding-ink': inkOn(colour) } as CSSProperties;
  return (
    <div role="listitem" className={cx('spine-slot', away && 'is-away')} style={style} data-book-slot={book.id}>
      <button
        type="button"
        className="spine-btn"
        onClick={(e) => {
          const slot = e.currentTarget.parentElement!;
          const img = slot.querySelector<HTMLImageElement>('.spine-cover img');
          // Pointed at (or focused), the book has already turned to show its cover.
          const turned = slot.matches(':hover') || e.currentTarget.matches(':focus-visible');
          onOpen({ rect: boxOf(slot.getBoundingClientRect()), angle: turned ? 16 : 90, aspect: img?.naturalWidth ? img.naturalHeight / img.naturalWidth : null });
        }} aria-label={`${book.title}${book.author ? `, ${book.author}` : ''} — ${STATUS_LABEL[book.status]}`}>
        <span className="spine-book" aria-hidden>
          <span className="spine-face">
            <span className="spine-title">{book.title}</span>
            {book.author && <span className="spine-author">{surname(book.author)}</span>}
            <span className="spine-mark" />
          </span>
          <span className="spine-cover">
            <Cover book={book} colour={colour} />
          </span>
        </span>
        {book.status === 'reading' && <span className="spine-ribbon" aria-hidden />}
      </button>
    </div>
  );
}

/** The front cover: the real one when it was found, else one set in type. */
function Cover({ book, colour, onAspect }: { book: Book; colour: string; onAspect?: (a: number) => void }) {
  const [failed, setFailed] = useState(false);
  if (book.cover && !failed)
    return (
      <img
        className="cover-img"
        src={book.cover}
        alt=""
        draggable={false}
        onLoad={(e) => onAspect?.(e.currentTarget.naturalHeight / e.currentTarget.naturalWidth)}
        onError={() => setFailed(true)}
      />
    );
  return (
    <span className="cover-type" style={{ '--binding': colour, '--binding-ink': inkOn(colour) } as CSSProperties}>
      <span className="cover-type-title">{book.title}</span>
      <span className="cover-type-rule" />
      {book.author && <span className="cover-type-author">{book.author}</span>}
    </span>
  );
}

// ── The book, in hand ───────────────────────────────────────────────────────

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The book in hand's size: a little smaller on phones, as tall as its cover's shape, as thick as its pages. */
function bookSize(book: Book, aspect: number) {
  const W = typeof matchMedia !== 'undefined' && matchMedia('(max-width: 760px)').matches ? 180 : 230;
  const H = Math.round(W * Math.min(1.7, Math.max(1.2, aspect)));
  const D = book.pages ? Math.round(Math.min(46, Math.max(14, book.pages / 11))) : 26;
  return { W, H, D };
}

/** The six faces of a book: cover, back, spine, and the page block at the fore-edge, head and tail. */
function BookFaces({ book, colour, onAspect }: { book: Book; colour: string; onAspect?: (a: number) => void }) {
  return (
    <>
      <div className="b3d-face b3d-front">
        <Cover book={book} colour={colour} onAspect={onAspect} />
        <span className="b3d-hinge" />
        <span className="b3d-glare" />
      </div>
      <div className="b3d-face b3d-back" />
      <div className="b3d-face b3d-spine">
        <span className="spine-title">{book.title}</span>
        {book.author && <span className="spine-author">{surname(book.author)}</span>}
      </div>
      <div className="b3d-face b3d-edge" />
      <div className="b3d-face b3d-top" />
      <div className="b3d-face b3d-bottom" />
    </>
  );
}

/** Where the book rests when nothing is moving it: turned a little, to show it has depth. */
const REST = { x: 4, y: -12 };
/** How far it may lean either way: always the front, with no more than a glimpse of spine or pages. */
const LIMIT = { x: 16, y: 30 };
const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));

/**
 * A book that leans toward the pointer as it moves over the stage (or under a finger as it
 * drags), and settles back when let go. It only ever tilts: the front always faces you.
 */
function Book3D({ book, colour, aspect: known, hidden }: { book: Book; colour: string; aspect: number | null; hidden: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(known ?? 1.5);
  const target = useRef({ ...REST });
  const angle = useRef({ ...REST });
  const drag = useRef<{ id: number; x: number; y: number; from: { x: number; y: number } } | null>(null);
  const frame = useRef(0);

  const { W, H, D } = bookSize(book, aspect);

  const paint = () => {
    const el = body.current;
    if (!el) return;
    const { x, y } = angle.current;
    el.style.transform = `rotateX(${x.toFixed(2)}deg) rotateY(${y.toFixed(2)}deg)`;
    // Light from the upper left: the glare slides across the cover as it turns.
    el.style.setProperty('--glare-x', `${(50 - y * 1.6).toFixed(1)}%`);
    el.style.setProperty('--glare-y', `${(30 + x * 2).toFixed(1)}%`);
    stage.current?.style.setProperty('--shadow-x', `${(-y * 0.9).toFixed(1)}px`);
  };

  const run = () => {
    cancelAnimationFrame(frame.current);
    const step = () => {
      const a = angle.current;
      const t = target.current;
      const k = drag.current ? 0.35 : 0.1;
      a.x += (t.x - a.x) * k;
      a.y += (t.y - a.y) * k;
      paint();
      if (Math.abs(t.x - a.x) > 0.05 || Math.abs(t.y - a.y) > 0.05) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    paint();
    return () => cancelAnimationFrame(frame.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lean = (e: ReactPointerEvent) => {
    if (reducedMotion() || e.pointerType === 'touch') return;
    const r = stage.current!.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
    target.current = { x: clamp(REST.x - ny * 12, LIMIT.x), y: clamp(REST.y + nx * 22, LIMIT.y) };
    run();
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: { ...angle.current } };
    stage.current?.classList.add('is-dragging');
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return lean(e);
    target.current = { x: clamp(d.from.x - (e.clientY - d.y) * 0.25, LIMIT.x), y: clamp(d.from.y + (e.clientX - d.x) * 0.3, LIMIT.y) };
    run();
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    stage.current?.classList.remove('is-dragging');
    target.current = { ...REST };
    run();
  };

  const style = { '--w': `${W}px`, '--h': `${H}px`, '--d': `${D}px`, '--binding': colour, '--binding-ink': inkOn(colour) } as CSSProperties;
  return (
    <div
      className={cx('book-stage', hidden && 'is-hidden')}
      ref={stage}
      onPointerMove={onMove}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={(e) => {
        if (drag.current) return;
        if (e.pointerType !== 'touch') {
          target.current = { ...REST };
          run();
        }
      }}
      style={style}
      aria-hidden
    >
      <div className="b3d" ref={body}>
        <BookFaces book={book} colour={colour} onAspect={setAspect} />
      </div>
      <div className="b3d-shadow" />
    </div>
  );
}

const IN_PLACE = `translate3d(0px, 0px, 0px) scale(1, 1) rotateX(${REST.x}deg) rotateY(${REST.y}deg)`;

interface Flight {
  /** Where the book in hand sits in the window, untransformed. */
  box: Box;
  frames: [string, string];
  out: boolean;
}

/**
 * A copy of the book that travels between the shelf and the window, above everything, turning
 * as it goes: spine-out on the shelf, cover-on in the window. It sits on the window's book and
 * is moved by its transform, so where it lands the real one takes over without a seam.
 */
function FlyingBook({ book, colour, aspect, flight, onDone }: { book: Book; colour: string; aspect: number | null; flight: Flight; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const anim = el.animate(
      flight.frames.map((transform) => ({ transform })),
      flight.out ? { duration: 460, easing: 'cubic-bezier(0.5, 0, 0.25, 1)', fill: 'forwards' } : { duration: 620, easing: 'cubic-bezier(0.2, 0.75, 0.2, 1)', fill: 'forwards' },
    );
    anim.finished.then(() => done.current()).catch(() => undefined);
    return () => anim.cancel();
  }, [flight]);
  const { W, H, D } = bookSize(book, aspect ?? 1.5);
  const { box } = flight;
  return createPortal(
    <div className="book-flight" style={{ perspectiveOrigin: `${box.left + box.width / 2}px ${box.top + box.height / 2}px` }} aria-hidden>
      <div className="b3d b3d-flying" ref={ref} style={{ left: box.left, top: box.top, transform: flight.frames[0], '--w': `${W}px`, '--h': `${H}px`, '--d': `${D}px`, '--binding': colour, '--binding-ink': inkOn(colour) } as CSSProperties}>
        <BookFaces book={book} colour={colour} />
      </div>
    </div>,
    document.body,
  );
}

/**
 * The transform that puts a book laid out at `box` where `to` is, as tall, turned by `angle`.
 * Spine-out (90°), its spine is also widened to the shelf's: shelf spines are drawn thicker
 * than the book in hand, and the copy should land exactly on the one it becomes.
 */
function placeAt(box: Box, to: Box, angle: number, depth: number): string {
  const dx = to.left + to.width / 2 - (box.left + box.width / 2);
  const dy = to.top + to.height / 2 - (box.top + box.height / 2);
  const sy = to.height / box.height;
  const sx = angle === 90 ? to.width / depth : sy;
  return `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)}) rotateX(0deg) rotateY(${angle}deg)`;
}

/** The book in hand's own box, as laid out, without its tilt. */
function untilted(el: HTMLElement): Box {
  const t = el.style.transform;
  el.style.transform = 'none';
  const box = boxOf(el.getBoundingClientRect());
  el.style.transform = t;
  return box;
}

function Stars({ value }: { value: number }) {
  return (
    <span className="stars" aria-hidden>
      <span className="stars-base">★★★★★</span>
      <span className="stars-fill" style={{ width: `${(value / 5) * 100}%` }}>
        ★★★★★
      </span>
    </span>
  );
}

/** "Buy on Amazon.sg" — the shop, from the link. */
function shopName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.startsWith('amazon.') ? `Amazon.${host.slice(7)}` : host;
  } catch {
    return 'the shop';
  }
}

function useArmed(): [boolean, () => void, () => void] {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return [armed, () => setArmed(true), () => setArmed(false)];
}

/** Synopses can carry Markdown emphasis and Windows line breaks; show them as plain prose. */
const plainText = (s: string) => s.replace(/\r\n?/g, '\n').replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|[.,;:!?]|$)/g, '$1$2');

function BookModal({ book, origin, onClose }: { book: Book; origin: Origin | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const flying = !!origin && !reducedMotion();
  const [flight, setFlight] = useState<Flight | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [waiting, setWaiting] = useState(flying);
  const colour = useBinding(book);
  const { agentName } = useApp();
  const [more, setMore] = useState(false);
  const [armed, arm, disarm] = useArmed();
  const patch = useWrite((body: Parameters<typeof booksWrite.patch>[1]) => booksWrite.patch(book.id, body));
  const refresh = useWrite(() => booksWrite.refresh(book.id));
  const remove = useWrite(() => booksWrite.del(book.id));
  useDialogFocus(ref);

  const bookEl = () => ref.current?.querySelector<HTMLElement>('.book-stage .b3d') ?? null;

  // Before the first paint: hold the page still, then set the book off from the shelf.
  useLayoutEffect(() => {
    document.body.style.overflow = 'hidden';
    const el = bookEl();
    if (flying && origin && el) {
      const box = untilted(el);
      setFlight({ box, frames: [placeAt(box, origin.rect, origin.angle, bookSize(book, 1.5).D), IN_PLACE], out: false });
    } else setWaiting(false);
    return () => {
      document.body.style.overflow = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Close by putting the book back on the shelf, when its place there can be seen; else just close. */
  const close = useRef(() => {});
  close.current = () => {
    if (leaving) return;
    const el = bookEl();
    const slot = slotOf(book.id);
    const to = slot?.getBoundingClientRect();
    if (reducedMotion() || !el || !to || to.width === 0 || to.bottom < 0 || to.top > innerHeight) return onClose();
    const box = untilted(el);
    // From however it is tilted right now.
    const tilt = el.style.transform || `rotateX(${REST.x}deg) rotateY(${REST.y}deg)`;
    setLeaving(true);
    setWaiting(true);
    setFlight({ box, frames: [`translate3d(0px, 0px, 0px) scale(1, 1) ${tilt}`, placeAt(box, boxOf(to), 90, bookSize(book, 1.5).D)], out: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !ref.current) return;
      const open = document.querySelectorAll('[aria-modal="true"]');
      if (open[open.length - 1] !== ref.current) return;
      e.stopPropagation();
      close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const sourceName = book.infoUrl.includes('openlibrary') ? 'Open Library' : 'Google Books';
  const paragraphs = plainText(book.synopsis).split(/\n\s*\n/);
  const long = book.synopsis.length > 420;
  const source = book.synopsisSource === 'you' ? 'Written by you' : book.synopsisSource === agentName ? `Written by ${agentName}` : book.synopsisSource ? `From ${book.synopsisSource}` : '';
  const ratingTitle = book.rating !== null ? `${book.rating.toFixed(1)} out of 5${book.ratingsCount ? ` from ${book.ratingsCount.toLocaleString()} ${book.ratingsCount === 1 ? 'rating' : 'ratings'}` : ''}${book.ratingSource ? ` on ${book.ratingSource}` : ''}` : '';
  const since =
    book.status === 'read' && book.finishedAt ? `Finished ${shortDay(todayStr(new Date(book.finishedAt)))}` : book.status === 'reading' && book.startedAt ? `Since ${shortDay(todayStr(new Date(book.startedAt)))}` : '';

  return (
    <div className={cx('scrim book-scrim', leaving && 'is-leaving')} onMouseDown={(e) => e.target === e.currentTarget && close.current()}>
      {flight && (
        <FlyingBook
          book={book}
          colour={colour}
          aspect={origin?.aspect ?? null}
          flight={flight}
          onDone={() => {
            if (flight.out) return onClose();
            setFlight(null);
            setWaiting(false);
          }}
        />
      )}
      <div className={cx('book-modal', flying && 'is-arriving', leaving && 'is-leaving')} role="dialog" aria-modal="true" aria-label={book.title} ref={ref} tabIndex={-1} style={{ '--binding': colour } as CSSProperties}>
        <button type="button" className="icon-btn book-close" onClick={() => close.current()} aria-label="Close">
          <X size={18} />
        </button>
        <div className="book-modal-stage">
          <Book3D book={book} colour={colour} aspect={origin?.aspect ?? null} hidden={waiting} />
          <p className="book-stage-hint">
            <span className="for-pointer">Move to tilt</span>
            <span className="for-touch">Drag to tilt</span>
          </p>
        </div>

        <div className="book-modal-side">
          <div className="book-modal-info">
            <header className="book-head">
              <h2 className="book-title">{book.title}</h2>
              {book.author && <p className="book-author">{book.author}</p>}
              {(book.rating !== null || book.year || book.pages) && (
                <p className="book-meta">
                  {book.rating !== null && (
                    <span className="book-meta-rating" title={ratingTitle}>
                      <Stars value={book.rating} />
                      <b>{book.rating.toFixed(1)}</b>
                      {book.ratingsCount ? <span className="faint">({book.ratingsCount.toLocaleString()})</span> : null}
                    </span>
                  )}
                  {book.year && <span>{book.year}</span>}
                  {book.pages && <span>{book.pages} pages</span>}
                </p>
              )}
            </header>

            <div className="book-status">
              <Seg label="Where you are with it" value={book.status} onChange={(status) => patch.mutate({ status })} options={(['want', 'reading', 'read'] as const).map((v) => ({ value: v, label: STATUS_LABEL[v] }))} />
              {since && <span className="hint">{since}</span>}
            </div>

            <section className="book-section">
              <div className="book-section-head">
                <h3>Synopsis</h3>
                {book.synopsis && source && <span className="faint">{source}</span>}
              </div>
              {book.synopsis ? (
                <>
                  <div className={cx('book-synopsis-text', long && !more && 'is-clamped')}>
                    {paragraphs.map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                  </div>
                  {long && (
                    <button type="button" className="link-btn" onClick={() => setMore((v) => !v)}>
                      {more ? 'Show less' : 'Read more'}
                    </button>
                  )}
                </>
              ) : (
                <InlineEdit label="Synopsis" multiline value="" placeholder="No synopsis was found. Write one, or look it up again." onSave={(synopsis) => patch.mutate({ synopsis })} />
              )}
            </section>

            <section className="book-note">
              <h3>Why it's on the list</h3>
              <InlineEdit label="Why it's on the list" multiline value={book.note} placeholder="Who recommended it, what you hope to get from it…" onSave={(note) => patch.mutate({ note })} />
            </section>
            {(patch.error || refresh.error || remove.error) && <p className="error-text">{(patch.error ?? refresh.error ?? remove.error)!.message}</p>}
          </div>

          <footer className="book-foot">
            <a className="btn btn-primary" href={book.buyUrl} target="_blank" rel="noreferrer noopener">
              <ShoppingBag size={15} /> Buy on {shopName(book.buyUrl)}
            </a>
            {book.infoUrl && (
              <a className="btn btn-ghost btn-sm" href={book.infoUrl} target="_blank" rel="noreferrer noopener" title={`See it on ${sourceName}`} aria-label={`See it on ${sourceName}`}>
                <span className="book-foot-label">{sourceName}</span> <ExternalLink size={12} />
              </a>
            )}
            <span className="grow" />
            <button type="button" className="icon-btn icon-btn-sm" title="Look it up again" aria-label="Look it up again" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
              {refresh.isPending ? <Spinner /> : <RefreshCw size={15} />}
            </button>
            {armed ? (
              <button type="button" className="btn btn-danger btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(undefined, { onSuccess: onClose })} onBlur={disarm} autoFocus>
                Remove
              </button>
            ) : (
              <button type="button" className="icon-btn icon-btn-sm" title="Remove from the list" aria-label="Remove from the list" onClick={arm}>
                <Trash2 size={15} />
              </button>
            )}
          </footer>
        </div>
      </div>
    </div>
  );
}

// ── Adding ──────────────────────────────────────────────────────────────────

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function AddBookSheet({ onClose, onAdded }: { onClose: () => void; onAdded: (b: Book) => void }) {
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 450);
  const { toast } = useApp();
  const results = useQuery({ queryKey: ['book-search', term], queryFn: () => booksWrite.search(term), enabled: term.length >= 2, staleTime: 5 * 60_000 });
  const [picked, setPicked] = useState<string | null>(null);
  const add = useWrite(booksWrite.add);
  const choose = (key: string, body: { ref?: string; title: string; author?: string }) => {
    setPicked(key);
    add.mutate(body, {
      onSuccess: (b) => {
        toast({ message: `“${b.title}” is on your reading list` });
        onAdded(b);
      },
      onError: () => setPicked(null),
    });
  };
  const list: BookCandidate[] = useMemo(() => (term.length >= 2 ? (results.data ?? []) : []), [results.data, term]);

  return (
    <Modal title="Add a book" onClose={onClose}>
      <div className="book-search">
        <Search size={16} className="faint" />
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Title, author or ISBN"
          aria-label="Find a book"
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list[0] && !add.isPending) choose(list[0].ref, list[0]);
          }}
        />
        {results.isFetching && <Spinner />}
      </div>
      {add.isPending && <p className="hint">Finding its cover, synopsis and ratings…</p>}
      {list.length > 0 && (
        <ul className="book-results">
          {list.map((c) => (
            <li key={c.ref}>
              <button type="button" className={cx('book-result', picked === c.ref && 'is-picked')} disabled={add.isPending} onClick={() => choose(c.ref, c)}>
                <span className="book-result-thumb">{c.thumb ? <img src={c.thumb} alt="" loading="lazy" /> : null}</span>
                <span className="grow">
                  <b className="clamp-1">{c.title}</b>
                  <span className="muted clamp-1">{[c.author, c.year].filter(Boolean).join(' · ')}</span>
                </span>
                {picked === c.ref ? <Spinner /> : <Plus size={15} className="faint" />}
              </button>
            </li>
          ))}
        </ul>
      )}
      {term.length >= 2 && !results.isFetching && results.data && (
        <button type="button" className={cx('book-result book-result-typed', picked === 'typed' && 'is-picked')} disabled={add.isPending} onClick={() => choose('typed', { title: term })}>
          <span className="grow">
            {list.length ? 'Not here? ' : 'Nothing found. '}Add “{term}” as typed
          </span>
          {picked === 'typed' ? <Spinner /> : <Plus size={15} className="faint" />}
        </button>
      )}
      {results.error && <p className="error-text">{results.error.message}</p>}
      {add.error && <p className="error-text">{add.error.message}</p>}
    </Modal>
  );
}
