// ⌘K: jump anywhere, find anything, capture something, or hand a thought to the agent.

import { ChartLine, CircleCheck, Library, NotebookPen, Orbit, Plus, Repeat, Search, Settings, Sparkles, Sun, Target } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import type { SearchHit } from '../../../shared/types.ts';
import { useSearch, useWrite, write } from '../api.ts';
import { hueStyle } from '../lib.ts';
import { useApp } from '../state.tsx';
import { SphereIcon } from './Icon.tsx';

interface Item {
  id: string;
  group: string;
  label: string;
  sub?: string;
  icon: ReactNode;
  hue?: number;
  run: () => void;
}

const HIT_ICON: Record<SearchHit['type'], ReactNode> = {
  goal: <Target size={15} />,
  task: <CircleCheck size={15} />,
  note: <NotebookPen size={15} />,
  habit: <Repeat size={15} />,
  metric: <ChartLine size={15} />,
  sphere: <Orbit size={15} />,
};

export function Palette({ onClose }: { onClose: () => void }) {
  const { spheres, sphere, openSheet, ask, agentName, toast } = useApp();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const addTask = useWrite((title: string) => write.post('/tasks', { title }));

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 140);
    return () => clearTimeout(t);
  }, [query]);
  const { data: hits = [] } = useSearch(debounced);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    const go = (path: string) => () => navigate(path);
    const pages: Item[] = [
      { id: 'p-today', group: 'Go to', label: 'Today', icon: <Sun size={15} />, run: go('/') },
      { id: 'p-spheres', group: 'Go to', label: 'Spheres', icon: <Orbit size={15} />, run: go('/spheres') },
      { id: 'p-goals', group: 'Go to', label: 'Goals', icon: <Target size={15} />, run: go('/goals') },
      { id: 'p-library', group: 'Go to', label: 'Library', icon: <Library size={15} />, run: go('/library') },
      { id: 'p-settings', group: 'Go to', label: 'Settings', icon: <Settings size={15} />, run: go('/settings') },
      ...spheres.map((s) => ({ id: `s-${s.id}`, group: 'Go to', label: s.name, sub: 'Sphere', icon: <SphereIcon name={s.icon} size={15} />, hue: s.hue, run: go(`/spheres/${s.id}`) })),
    ];
    const create: Item[] = [
      { id: 'c-goal', group: 'Create', label: 'New goal', icon: <Plus size={15} />, run: () => openSheet({ kind: 'new-goal' }) },
      { id: 'c-note', group: 'Create', label: 'New note', icon: <Plus size={15} />, run: () => openSheet({ kind: 'new-note' }) },
      { id: 'c-sphere', group: 'Create', label: 'Add a sphere', icon: <Plus size={15} />, run: () => openSheet({ kind: 'new-sphere' }) },
    ];
    if (!q) return [...pages.slice(0, 5), ...create, ...pages.slice(5)];

    const lower = q.toLowerCase();
    const found: Item[] = hits.map((h) => ({
      id: `h-${h.type}-${h.id}`,
      group: 'Found',
      label: h.title,
      sub: [h.type, sphere(h.sphereId)?.name, h.snippet].filter(Boolean).join(' · '),
      icon: HIT_ICON[h.type],
      hue: sphere(h.sphereId)?.hue,
      run: () => {
        if (h.type === 'goal') openSheet({ kind: 'goal', id: h.id });
        else if (h.type === 'task') openSheet({ kind: 'task', id: h.id });
        else if (h.type === 'note') openSheet({ kind: 'note', id: h.id });
        else if (h.sphereId) navigate(`/spheres/${h.sphereId}`);
      },
    }));
    return [
      { id: 'a-task', group: 'Do', label: `Add task: ${q}`, icon: <Plus size={15} />, run: () => addTask.mutate(q, { onSuccess: () => toast({ message: 'Task added.' }) }) },
      { id: 'a-ask', group: 'Do', label: `Ask ${agentName}: ${q}`, icon: <Sparkles size={15} />, run: () => ask(q) },
      ...found,
      ...[...pages, ...create].filter((p) => p.label.toLowerCase().includes(lower)),
    ];
  }, [query, hits, spheres, sphere, navigate, openSheet, ask, agentName, addTask, toast]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  let lastGroup = '';
  return (
    <div className="scrim palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and commands">
        <div className="palette-input">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search, jump, capture, or ask ${agentName}…`}
            aria-label="Search and commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(items[index]);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header && <div className="eyebrow palette-group">{header}</div>}
                <button type="button" role="option" aria-selected={i === index} className="palette-item tint" style={item.hue === undefined ? undefined : hueStyle(item.hue)} onMouseMove={() => setIndex(i)} onClick={() => choose(item)}>
                  <span className="kind">{item.icon}</span>
                  <span className="grow">
                    <span className="clamp-1">{item.label}</span>
                    {item.sub && <small>{item.sub}</small>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
