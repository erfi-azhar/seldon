import { Check as CheckIcon, X } from 'lucide-react';
import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cx, hueStyle } from '../lib.ts';
import { useApp } from '../state.tsx';

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function Loading() {
  return (
    <div className="loading">
      <Spinner />
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Dialogs open over one another, so the last modal one in the page is on top. */
function isTopDialog(el: HTMLElement): boolean {
  const open = document.querySelectorAll('[aria-modal="true"]');
  return open[open.length - 1] === el;
}

/**
 * Keyboard focus for a dialog: moves in when it opens (to `initial`, else the dialog
 * itself), stays inside on Tab and Shift+Tab while it is the top-most modal dialog, and
 * goes back to where it was when it closes.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, initial?: () => HTMLElement | null | undefined) {
  const pick = useRef(initial);
  pick.current = initial;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opener = document.activeElement as HTMLElement | null;
    (pick.current?.() ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !isTopDialog(el)) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      let next: HTMLElement | undefined;
      if (!first || !last) next = el;
      else if (!el.contains(active)) next = e.shiftKey ? last : first;
      else if (e.shiftKey && (active === first || active === el)) next = last;
      else if (!e.shiftKey && active === last) next = first;
      if (next) {
        e.preventDefault();
        next.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Not when focus has already moved on to the page (a docked panel stays usable).
      const active = document.activeElement;
      if (!active || active === document.body || el.contains(active)) opener?.focus?.();
    };
  }, [ref]);
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Focus the first field so typing works immediately; with none (yet), the dialog.
  useDialogFocus(ref, () => ref.current?.querySelector<HTMLElement>('[data-autofocus], textarea, input, select'));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only the top-most dialog: Escape in the palette over a sheet must not close both.
      if (e.key === 'Escape' && ref.current && isTopDialog(ref.current)) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'modal-wide')} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Controls a Field can name by giving them its id. Anything else (a group of buttons, a
// row holding a control) names itself.
const LABELLED = new Set<unknown>(['input', 'select', 'textarea', AutoTextarea, SphereSelect]);

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const control = isValidElement<{ id?: string; 'aria-describedby'?: string }>(children) && LABELLED.has(children.type) ? children : null;
  const controlId = control?.props.id ?? id;
  return (
    <div className="field">
      <label htmlFor={control ? controlId : undefined}>{label}</label>
      {control ? cloneElement(control, { id: controlId, 'aria-describedby': hint ? `${id}-hint` : control.props['aria-describedby'] }) : children}
      {hint && (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}

export function Seg<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A round checkbox. Takes the sphere colour when one is in scope. */
export function Check({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button type="button" className="check" role="checkbox" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <CheckIcon size={12} strokeWidth={3.2} />
    </button>
  );
}

/** A textarea that grows with its content. */
export function AutoTextarea({
  value,
  onChange,
  className,
  minRows = 1,
  ...rest
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & {
  value: string;
  onChange: (v: string) => void;
  minRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return <textarea ref={ref} rows={minRows} className={className} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

/**
 * Text you edit in place. Saves when you leave the field (or press Enter on single-line
 * text); Escape puts back what was there.
 */
export function InlineEdit({
  value,
  onSave,
  placeholder,
  className,
  multiline,
  label,
}: {
  value: string;
  onSave: (next: string) => void;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  // blur() runs onBlur before React re-renders, so commit would still see the edited
  // draft: Escape marks the edit as cancelled instead.
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(value);
      return;
    }
    const next = draft.trim();
    if (next !== value.trim()) onSave(next);
    else setDraft(value);
  };

  return (
    <AutoTextarea
      aria-label={label}
      className={cx('inline-edit', className)}
      value={draft}
      placeholder={placeholder}
      onChange={setDraft}
      onFocus={() => setEditing(true)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Only the edit is abandoned, not the sheet it sits in.
          e.stopPropagation();
          cancelled.current = true;
          e.currentTarget.blur();
        } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Pick a sphere (or none). */
export function SphereSelect({
  value,
  onChange,
  allowNone = true,
  className,
  noneLabel = 'No sphere',
  id,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  allowNone?: boolean;
  className?: string;
  noneLabel?: string;
  id?: string;
}) {
  const { spheres } = useApp();
  return (
    <select id={id} className={cx('select', className)} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={id ? undefined : 'Sphere'}>
      {allowNone && <option value="">{noneLabel}</option>}
      {spheres.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

/** A small coloured label naming a sphere. */
export function SphereChip({ id }: { id: string | null | undefined }) {
  const s = useApp().sphere(id);
  if (!s) return null;
  return (
    <span className="chip chip-tint tint" style={hueStyle(s.hue)}>
      {s.name}
    </span>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <i style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  );
}

/**
 * A box that scrolls on one axis, and which of its ends still hide something, so the edge blur
 * sits only where there is more to see.
 */
export function useScrollEdges<T extends HTMLElement>(axis: 'x' | 'y', deps: unknown[] = []) {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const [pos, size, total] = axis === 'y' ? [el.scrollTop, el.clientHeight, el.scrollHeight] : [el.scrollLeft, el.clientWidth, el.scrollWidth];
    const start = pos > 2;
    const end = pos + size < total - 2;
    setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
  }, [axis]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    // Content wraps and grows with the width, so watch the children as well as the box.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, ...deps]);
  return { ref, onScroll: update, edges, scrolls: edges.start || edges.end };
}

/**
 * Where a scrolling box cuts its content off, a progressive blur instead of a fade: layers of
 * backdrop blur, each stronger and nearer the edge. Place it beside the scroller, inside a
 * `.blur-wrap` that is exactly the scroller's box.
 */
export function ScrollBlur({ axis, edges }: { axis: 'x' | 'y'; edges: { start: boolean; end: boolean } }) {
  return (
    <>
      {(['start', 'end'] as const).map((side) => (
        <div key={side} className={cx('blur-edge', `is-${axis}`, `is-${side}`, edges[side] && 'is-on')} aria-hidden>
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      ))}
    </>
  );
}

/**
 * Folds you opened or closed, kept in this browser like the view choice. What's saved is the
 * groups you turned away from how they start (closed ones when they start open, and the other
 * way round). `keep` lets go of keys that no longer mean anything (a day gone by, a project
 * archived, a trip with nothing left to do), so the list doesn't grow forever.
 */
export function useFolds(storageKey: string, keep: (key: string) => boolean, startOpen = true) {
  const [changed, setChanged] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      return new Set(Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string' && keep(k)) : []);
    } catch {
      return new Set();
    }
  });
  const isOpen = (key: string) => changed.has(key) !== startOpen;
  const toggle = (key: string, open: boolean) =>
    setChanged((prev) => {
      if (open === (prev.has(key) !== startOpen)) return prev;
      const next = new Set(prev);
      if (open === startOpen) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* the folds just aren't remembered */
      }
      return next;
    });
  return { isOpen, toggle };
}
