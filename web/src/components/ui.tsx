import { Check as CheckIcon, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    // Focus the first field so typing works immediately.
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], textarea, input, select');
    first?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'modal-wide')} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
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

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
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
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
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
          setDraft(value);
          setEditing(false);
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
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  allowNone?: boolean;
  className?: string;
  noneLabel?: string;
}) {
  const { spheres } = useApp();
  return (
    <select className={cx('select', className)} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Sphere">
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
