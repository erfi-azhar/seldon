import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { Scheduler } from './jobs.ts';
import { Store } from './store.ts';
import { defaultDbPath, openDb, setting } from './db.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '../../dist/web');

const port = Number(process.env.PORT || 4321);
const hostname = process.env.HOST || '127.0.0.1';
const passphrase = setting('PASSPHRASE') || undefined;
const allowedHosts = (setting('ALLOWED_HOSTS') ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

const loopback = ['127.0.0.1', 'localhost', '::1'].includes(hostname);
if (!loopback && !passphrase && allowedHosts.length === 0) {
  console.error(
    [
      `Refusing to listen on ${hostname} without protection: anyone who can reach this`,
      'machine could read and change everything in your Terminus.',
      '',
      '  Set TERMINUS_PASSPHRASE to require signing in (recommended), or',
      '  set TERMINUS_ALLOWED_HOSTS=<hostname> if the network itself is private (e.g. a tailnet).',
    ].join('\n'),
  );
  process.exit(1);
}

const dbPath = defaultDbPath();
const db = openDb(dbPath);
const scheduler = new Scheduler(new Store(db));
const app = createApp({ db, passphrase, allowedHosts, scheduler });
// Background work (mail, job alerts, app sync) only runs for the real server, never in tests.
scheduler.start();

if (existsSync(webDir)) {
  // Hashed assets never change; everything else is revalidated so updates show up.
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.status === 200) c.header('cache-control', 'public, max-age=31536000, immutable');
  });
  app.use('*', async (c, next) => {
    await next();
    if (!c.req.path.startsWith('/assets/') && !c.res.headers.has('cache-control')) c.header('cache-control', 'no-cache');
  });
  app.use('*', serveStatic({ root: webDir }));
  // A missing file is a 404, not the app shell: a stale asset link must not cache HTML.
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(c.req.path)) return c.text('Not found', 404);
    await next();
  });
  // Client-side routes: any other path gets the app shell.
  const shell = resolve(webDir, 'index.html');
  app.get('*', async (c) => c.html(await readFile(shell, 'utf8')));
} else {
  app.get('*', (c) =>
    c.text('The web app has not been built yet. Run `npm run build`, or use `npm run dev` while developing.', 503),
  );
}

// SQLite keeps recent writes in a side file (WAL) until a checkpoint. Fold them into the
// main file now and then, and on the way out, so copying the database is a full backup.
const checkpoint = () => {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* busy: the next one will do */
  }
};
setInterval(checkpoint, 5 * 60_000).unref();
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  scheduler.stop();
  checkpoint();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

serve({ fetch: app.fetch, port, hostname }, (info) => {
  const shown = loopback ? 'localhost' : hostname;
  console.log(`Terminus is running at http://${shown}:${info.port}`);
  console.log(`  data: ${dbPath}`);
  console.log(`  sign-in: ${passphrase ? 'passphrase required' : 'off (local only)'}`);
});
