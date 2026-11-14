import { useQueryClient } from '@tanstack/react-query';
import { Library as LibraryIcon, Orbit, Search, Settings as SettingsIcon, Sun, Target } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import type { Settings as SettingsData } from '../../shared/types.ts';
import { useAgentChat } from './agent.ts';
import { SIGNED_OUT, useAuth, useSettings, useSpheres } from './api.ts';
import { AgentPanel } from './components/AgentPanel.tsx';
import { AgentOrb } from './components/Orb.tsx';
import { Palette } from './components/Palette.tsx';
import { Sheets } from './components/sheets.tsx';
import { Loading } from './components/ui.tsx';
import { cx } from './lib.ts';
import { AppContext, type AppState, type Sheet, type Toast } from './state.tsx';
import { Goals } from './views/Goals.tsx';
import { Library } from './views/Library.tsx';
import { Screenings } from './views/Screenings.tsx';
import { Settings } from './views/Settings.tsx';
import { SphereDetail, Spheres } from './views/Spheres.tsx';
import { Today } from './views/Today.tsx';
import { Onboarding, SignIn } from './views/Welcome.tsx';

const TABS = [
  { href: '/', label: 'Today', icon: Sun, match: (p: string) => p === '/' },
  { href: '/spheres', label: 'Spheres', icon: Orbit, match: (p: string) => p.startsWith('/spheres') },
  { href: '/goals', label: 'Goals', icon: Target, match: (p: string) => p.startsWith('/goals') },
  { href: '/library', label: 'Library', icon: LibraryIcon, match: (p: string) => p.startsWith('/library') },
];

export function App() {
  const qc = useQueryClient();
  const auth = useAuth();

  // Any request that comes back "not signed in" sends us back to the door.
  useEffect(() => {
    const onSignedOut = () => void qc.invalidateQueries({ queryKey: ['auth'] });
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, [qc]);

  if (auth.isError) {
    return (
      <main className="stage">
        <div className="stage-inner" style={{ maxWidth: 420 }}>
          <h1>Can't reach LifeOS</h1>
          <p className="lede">The server isn't answering. Check that it's running, then try again.</p>
          <div>
            <button className="btn btn-primary" onClick={() => void auth.refetch()}>
              Try again
            </button>
          </div>
        </div>
      </main>
    );
  }
  if (!auth.data) return <Loading />;
  if (auth.data.required && !auth.data.authenticated) return <SignIn />;
  return <Gate />;
}

function Gate() {
  const { data: settings } = useSettings();
  if (!settings) return <Loading />;
  if (!settings.profile.onboarded) return <Onboarding settings={settings} />;
  return <Shell settings={settings} />;
}

function Shell({ settings }: { settings: SettingsData }) {
  const [location] = useLocation();
  const { data: spheres } = useSpheres();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const agentName = settings.profile.agentName;

  // What the agent is told the person is looking at, read at send time.
  const where = useRef('Today');
  where.current = useMemo(() => {
    const sphereId = location.match(/^\/spheres\/([^/]+)/)?.[1];
    if (sphereId) return `The ${spheres?.find((s) => s.id === sphereId)?.name ?? 'a'} sphere`;
    if (location === '/') return 'Today';
    return { '/spheres': 'All spheres', '/goals': 'Goals', '/library': 'Library', '/settings': 'Settings' }[location] ?? 'LifeOS';
  }, [location, spheres]);
  const chat = useAgentChat(useCallback(() => where.current, []));
  const { send } = chat;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === 'j') {
        e.preventDefault();
        setAgentOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    // Braces matter: scrollTo returns a Promise in current browsers, and an effect
    // must not return one.
    window.scrollTo(0, 0);
  }, [location]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const app = useMemo<AppState>(() => {
    const list = spheres ?? [];
    const byId = new Map(list.map((s) => [s.id, s]));
    return {
      spheres: list,
      sphere: (id) => (id ? byId.get(id) : undefined),
      agentName,
      openSheet: setSheet,
      closeSheet: () => setSheet(null),
      agentOpen,
      setAgentOpen,
      ask: (prompt) => {
        setAgentOpen(true);
        send(prompt);
      },
      openPalette: () => setPaletteOpen(true),
      toast: setToast,
    };
  }, [spheres, agentName, agentOpen, send]);

  if (!spheres) return <Loading />;

  return (
    <AppContext.Provider value={app}>
      <div className="app">
        <div className="app-main">
          <header className="topbar">
            <div className="topbar-left">
              <button type="button" className="agent-button" aria-pressed={agentOpen} onClick={() => setAgentOpen((v) => !v)} title={`Talk to ${agentName} (⌘J)`}>
                <AgentOrb size={28} thinking={chat.streaming} />
                <span>{agentName}</span>
              </button>
              <Link href="/" className="wordmark serif">
                LifeOS
              </Link>
            </div>
            <nav className="nav" aria-label="Main">
              <button type="button" className="nav-search" onClick={() => setPaletteOpen(true)} aria-label="Search and commands">
                <Search size={15} />
                <kbd>⌘K</kbd>
              </button>
              {TABS.map((t) => (
                <Link key={t.href} href={t.href} className={cx(t.match(location) && 'active')}>
                  {t.label}
                </Link>
              ))}
            </nav>
            <div className="topbar-right">
              <button type="button" className="icon-btn only-mobile" onClick={() => setPaletteOpen(true)} aria-label="Search and commands">
                <Search size={18} />
              </button>
              <Link href="/settings" className={cx('icon-btn', location === '/settings' && 'active')} aria-label="Settings">
                <SettingsIcon size={18} />
              </Link>
            </div>
          </header>

          <main>
            <Switch>
              <Route path="/" component={Today} />
              <Route path="/spheres" component={Spheres} />
              <Route path="/spheres/:id/screenings">{(params) => <Screenings sphereId={params.id} />}</Route>
              <Route path="/spheres/:id">{(params) => <SphereDetail key={params.id} id={params.id} />}</Route>
              <Route path="/goals" component={Goals} />
              <Route path="/library" component={Library} />
              <Route path="/settings" component={Settings} />
              <Route>
                <div className="page">
                  <div className="empty-block">
                    <h3>Nothing at this address</h3>
                    <Link href="/" className="btn">
                      Back to Today
                    </Link>
                  </div>
                </div>
              </Route>
            </Switch>
          </main>
        </div>

        {agentOpen && <AgentPanel chat={chat} settings={settings} onClose={() => setAgentOpen(false)} />}
      </div>

      {!agentOpen && (
        <button type="button" className="askbar" onClick={() => setAgentOpen(true)}>
          <AgentOrb size={36} thinking={chat.streaming} />
          Ask {agentName} anything
          <kbd>⌘J</kbd>
        </button>
      )}

      <nav className="tabbar" aria-label="Main">
        <button type="button" className="tabbar-round" onClick={() => setPaletteOpen(true)} aria-label="Search and commands">
          <Search size={21} />
        </button>
        <div className="tabbar-pill">
          {TABS.map((t) => (
            <Link key={t.href} href={t.href} className={cx(t.match(location) && 'active')}>
              <t.icon size={20} strokeWidth={1.9} />
              {t.label}
            </Link>
          ))}
        </div>
        <button type="button" className="tabbar-round tab-agent" onClick={() => setAgentOpen(true)} aria-label={`Talk to ${agentName}`}>
          <AgentOrb size={52} thinking={chat.streaming} />
        </button>
      </nav>

      <Sheets sheet={sheet} onClose={() => setSheet(null)} />
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
      {toast && (
        <div className="toast" role="status">
          {toast.message}
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action!.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </AppContext.Provider>
  );
}
