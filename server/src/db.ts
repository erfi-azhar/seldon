import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type DB = DatabaseSync;

/** Ordered, append-only. PRAGMA user_version records how many have run. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE spheres (
    id TEXT PRIMARY KEY,
    key TEXT,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    hue INTEGER NOT NULL,
    vision TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE metrics (
    id TEXT PRIMARY KEY,
    sphere_id TEXT NOT NULL REFERENCES spheres(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    direction TEXT NOT NULL DEFAULT 'up',
    created_at TEXT NOT NULL
  );
  CREATE TABLE metric_entries (
    id TEXT PRIMARY KEY,
    metric_id TEXT NOT NULL REFERENCES metrics(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    value REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX metric_entries_by_metric ON metric_entries(metric_id, date);

  CREATE TABLE goals (
    id TEXT PRIMARY KEY,
    sphere_id TEXT NOT NULL REFERENCES spheres(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    why TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    horizon TEXT NOT NULL DEFAULT 'year',
    target_date TEXT,
    metric_id TEXT REFERENCES metrics(id) ON DELETE SET NULL,
    start_value REAL,
    target_value REAL,
    manual_progress INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX goals_by_sphere ON goals(sphere_id, status);

  CREATE TABLE milestones (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    done_at TEXT
  );
  CREATE INDEX milestones_by_goal ON milestones(goal_id, position);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    sphere_id TEXT REFERENCES spheres(id) ON DELETE SET NULL,
    goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
    due_date TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX tasks_open ON tasks(done, due_date);

  CREATE TABLE habits (
    id TEXT PRIMARY KEY,
    sphere_id TEXT NOT NULL REFERENCES spheres(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cadence TEXT NOT NULL DEFAULT 'daily',
    target_per_week INTEGER NOT NULL DEFAULT 7,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE habit_logs (
    habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    PRIMARY KEY (habit_id, date)
  );

  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    sphere_id TEXT REFERENCES spheres(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'note',
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    date TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX notes_one_journal_per_day ON notes(date) WHERE kind = 'journal';

  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    verb TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    sphere_id TEXT,
    summary TEXT NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX activity_by_sphere ON activity(sphere_id, ts);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    turn TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_by_conversation ON messages(conversation_id, id);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );
  `,
  `
  -- Structured health-screening record shown in the Health sphere: one JSON document.
  CREATE TABLE screenings (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

export function defaultDbPath(): string {
  return process.env.LIFEOS_DB ?? resolve('data/lifeos.db');
}

export function openDb(path: string = defaultDbPath()): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
