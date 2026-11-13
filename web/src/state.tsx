import { createContext, useContext } from 'react';
import type { SphereWithStats } from '../../shared/types.ts';

/** Editors that open over the current page. */
export type Sheet =
  | { kind: 'goal'; id: string }
  | { kind: 'new-goal'; sphereId?: string }
  | { kind: 'task'; id: string }
  | { kind: 'note'; id: string }
  | { kind: 'new-note'; sphereId?: string }
  | { kind: 'sphere'; id: string }
  | { kind: 'new-sphere' }
  | { kind: 'habit'; sphereId: string; id?: string }
  | { kind: 'metric'; sphereId: string; id?: string };

export interface Toast {
  message: string;
  action?: { label: string; run: () => void };
}

export interface AppState {
  /** Active spheres, in order. Always loaded before anything that reads it renders. */
  spheres: SphereWithStats[];
  sphere: (id: string | null | undefined) => SphereWithStats | undefined;
  agentName: string;
  openSheet: (sheet: Sheet) => void;
  closeSheet: () => void;
  agentOpen: boolean;
  setAgentOpen: (open: boolean) => void;
  /** Open the agent and send it this message. */
  ask: (prompt: string) => void;
  openPalette: () => void;
  toast: (toast: Toast) => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp outside of AppContext');
  return ctx;
}
