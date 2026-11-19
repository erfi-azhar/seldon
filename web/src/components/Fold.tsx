import { ChevronDown } from 'lucide-react';
import { createContext, type ReactNode, useContext, useSyncExternalStore } from 'react';
import { cx } from '../lib.ts';

/*
 * Folding the cards on Today down to their heads. Which cards are folded is remembered on this
 * device; a card nobody has folded or opened yet takes its default (the game plan starts folded).
 */

const KEY = 'terminus:today:folds';
type Folds = Record<string, boolean>;

function read(): Folds {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Folds) : {};
  } catch {
    return {};
  }
}

let folds: Folds = read();
const subs = new Set<() => void>();

function setFolds(next: Folds) {
  folds = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage is off; remembered until the page reloads.
  }
  subs.forEach((f) => f());
}

function useFolds(): Folds {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    () => folds,
  );
}

/** Today's foldable cards and whether each starts folded. */
export const TODAY_FOLDS = {
  game: true,
  todos: false,
  travel: false,
  signals: false,
  journal: false,
  crypto: false,
  habits: false,
  horizon: false,
} as const;
export type FoldId = keyof typeof TODAY_FOLDS;

const isFolded = (f: Folds, id: FoldId) => f[id] ?? TODAY_FOLDS[id];

/** Fold or open every card on Today at once. */
export function useFoldAll(): { allFolded: boolean; foldAll: (folded: boolean) => void } {
  const f = useFolds();
  const ids = Object.keys(TODAY_FOLDS) as FoldId[];
  return {
    allFolded: ids.every((id) => isFolded(f, id)),
    foldAll: (folded) => setFolds(Object.fromEntries(ids.map((id) => [id, folded]))),
  };
}

interface Fold {
  folded: boolean;
  toggle: () => void;
  label: string;
}
const FoldCtx = createContext<Fold | null>(null);

/** Makes the card inside foldable. Cards read it with `useFold` and stay as they are without it. */
export function Foldable({ id, label, children }: { id: FoldId; label: string; children: ReactNode }) {
  const f = useFolds();
  const folded = isFolded(f, id);
  return <FoldCtx.Provider value={{ folded, label, toggle: () => setFolds({ ...folds, [id]: !folded }) }}>{children}</FoldCtx.Provider>;
}

/** Whether the card is folded; false outside Today, where cards don't fold. */
export function useFold(): boolean {
  return useContext(FoldCtx)?.folded ?? false;
}

/** The chevron in a card's head that folds and opens it. Nothing outside a `Foldable`. */
export function FoldButton() {
  const fold = useContext(FoldCtx);
  if (!fold) return null;
  return (
    <button
      type="button"
      className={cx('icon-btn icon-btn-sm fold-btn', fold.folded && 'is-folded')}
      aria-expanded={!fold.folded}
      aria-label={`${fold.folded ? 'Open' : 'Fold'} ${fold.label}`}
      title={fold.folded ? 'Open' : 'Fold'}
      onClick={fold.toggle}
    >
      <ChevronDown size={15} />
    </button>
  );
}
