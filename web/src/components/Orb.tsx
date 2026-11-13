import type { CSSProperties } from 'react';
import { SphereIcon } from './Icon.tsx';
import { cx } from '../lib.ts';

const CIRCUMFERENCE = 2 * Math.PI * 46;

/**
 * A sphere, drawn as one. `ring` (0–1) wraps it in a progress arc — used for a sphere's
 * weekly pulse.
 */
export function Orb({
  hue,
  size = 40,
  icon,
  ring,
  title,
}: {
  hue: number;
  size?: number;
  icon?: string;
  ring?: number;
  title?: string;
}) {
  const wrap = ring === undefined ? size : Math.round(size * 1.3);
  const style = { '--h': hue, '--size': `${size}px`, '--wrap': `${wrap}px` } as CSSProperties;
  return (
    <span className="orb-wrap" style={style} title={title}>
      {ring !== undefined && (
        <svg className="orb-ring" viewBox="0 0 100 100" aria-hidden>
          <circle className="track" cx="50" cy="50" r="46" />
          <circle className="arc" cx="50" cy="50" r="46" strokeDasharray={`${Math.max(0, Math.min(1, ring)) * CIRCUMFERENCE} ${CIRCUMFERENCE}`} />
        </svg>
      )}
      <span className="orb">{icon && <SphereIcon name={icon} size={Math.round(size * 0.44)} />}</span>
    </span>
  );
}

/** The agent's own orb: a pearl that breathes while it works. */
export function AgentOrb({ size = 30, thinking = false }: { size?: number; thinking?: boolean }) {
  const style = { '--size': `${size}px`, '--wrap': `${size}px` } as CSSProperties;
  return (
    <span className="orb-wrap" style={style} aria-hidden>
      <span className={cx('orb orb-agent', thinking && 'thinking')} />
    </span>
  );
}
