import './clock.ts';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/eb-garamond';
import '@fontsource-variable/eb-garamond/wght-italic.css';
import '../../web/src/styles.css';
import './demo.css';

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Router } from 'wouter';
import { navigate, useHashLocation } from 'wouter/use-hash-location';
import { App } from '../../web/src/App.tsx';
import { setNow } from './clock.ts';
import { installServer, useScenario, type Recording } from './server.ts';
import scenarios from './scenarios.json';

const KEY = 'terminus.demo.travel';
const saved = (() => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
})();

function pick(id: string) {
  const s = scenarios.find((x) => x.id === id) ?? scenarios[1]!;
  setNow(s.now);
  useScenario(s.id);
  try {
    sessionStorage.setItem(KEY, s.id);
  } catch {
    /* fine */
  }
  return s.id;
}

function Switcher() {
  const qc = useQueryClient();
  const [on, setOn] = useState(() => pick(saved ?? 'departing'));
  return (
    <div className="demo-bar" role="group" aria-label="Jump to a moment in the trip">
      <span className="demo-tag">Demo</span>
      {scenarios.map((s) => (
        <button
          key={s.id}
          type="button"
          className={s.id === on ? 'is-on' : ''}
          aria-pressed={s.id === on}
          title={s.detail}
          onClick={() => {
            setOn(pick(s.id));
            navigate('/');
            void qc.resetQueries();
            window.scrollTo({ top: 0 });
          }}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: false, refetchOnWindowFocus: false } } });

// The recorded responses sit in the page itself (see build.mjs), or beside it in data.json.
const inline = document.getElementById('demo-data')?.textContent;
installServer((inline ? JSON.parse(inline) : await (await fetch('./data.json')).json()) as Recording);
pick(saved ?? 'departing');
if (!location.hash) history.replaceState(null, '', '#/');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <Router hook={useHashLocation}>
        <Switcher />
        <App />
      </Router>
    </QueryClientProvider>
  </StrictMode>,
);
