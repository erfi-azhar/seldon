import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
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
  `
  ALTER TABLE conversations ADD COLUMN connection_id TEXT;
  `,
  `
  CREATE TABLE signals (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    sphere_id TEXT REFERENCES spheres(id) ON DELETE SET NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    actions TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'new',
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX signals_once ON signals(source, external_id);
  CREATE INDEX signals_open ON signals(status, priority, occurred_at);

  CREATE TABLE integrations (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '{}',
    secrets TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT '{}',
    last_run_at TEXT,
    last_ok_at TEXT,
    last_error TEXT
  );
  `,
  `
  CREATE TABLE prayer_log (
    date TEXT NOT NULL,
    prayer TEXT NOT NULL,
    status TEXT NOT NULL,
    logged_at TEXT NOT NULL,
    made_up_at TEXT,
    PRIMARY KEY (date, prayer)
  );
  `,
  `
  ALTER TABLE notes ADD COLUMN capture TEXT;
  ALTER TABLE notes ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';

  -- Pictures and thumbnails kept with your data, so the app never loads them from elsewhere.
  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE food_log (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    meal TEXT NOT NULL,
    name TEXT NOT NULL,
    amount TEXT NOT NULL DEFAULT '',
    kcal REAL NOT NULL,
    protein REAL NOT NULL DEFAULT 0,
    carbs REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    external_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX food_by_date ON food_log(date);

  CREATE TABLE workouts (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    duration_min REAL,
    distance_km REAL,
    kcal REAL,
    notes TEXT NOT NULL DEFAULT '',
    exercises TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'manual',
    external_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX workouts_by_date ON workouts(date);

  CREATE TABLE body_readings (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    weight_kg REAL,
    body_fat_pct REAL,
    muscle_kg REAL,
    visceral_fat REAL,
    water_pct REAL,
    bmr REAL,
    source TEXT NOT NULL DEFAULT 'manual',
    external_id TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  `,
  // travel — trips (work or leisure), their flights and stays, a day plan, loyalty accounts.
  `
  CREATE TABLE trips (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'leisure',
    destination TEXT NOT NULL DEFAULT '',
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    companion TEXT NOT NULL DEFAULT '{}',
    drafted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE trip_segments (
    id TEXT PRIMARY KEY,
    trip_id TEXT REFERENCES trips(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    carrier TEXT NOT NULL DEFAULT '',
    number TEXT NOT NULL DEFAULT '',
    from_code TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT '',
    to_code TEXT NOT NULL DEFAULT '',
    to_name TEXT NOT NULL DEFAULT '',
    start_local TEXT NOT NULL,
    start_tz TEXT NOT NULL DEFAULT 'UTC',
    end_local TEXT NOT NULL,
    end_tz TEXT NOT NULL DEFAULT 'UTC',
    start_utc TEXT NOT NULL,
    end_utc TEXT NOT NULL,
    cabin TEXT NOT NULL DEFAULT '',
    seat TEXT NOT NULL DEFAULT '',
    confirmation TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    external_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX trip_segments_by_start ON trip_segments(start_utc);

  CREATE TABLE itinerary_items (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    time TEXT,
    title TEXT NOT NULL,
    place TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'activity',
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX itinerary_by_trip ON itinerary_items(trip_id, date, time);

  CREATE TABLE loyalty_accounts (
    id TEXT PRIMARY KEY,
    program TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT '',
    points INTEGER,
    progress REAL,
    progress_target REAL,
    progress_label TEXT NOT NULL DEFAULT '',
    expires TEXT,
    member_suffix TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    updated_at TEXT NOT NULL
  );
  `,
  // job alerts — companies you watch and the openings on their job boards.
  `
  CREATE TABLE job_watches (
    id TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    careers_url TEXT NOT NULL DEFAULT '',
    ats TEXT NOT NULL,
    board TEXT NOT NULL,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (ats, board)
  );

  CREATE TABLE job_postings (
    id TEXT PRIMARY KEY,
    watch_id TEXT NOT NULL REFERENCES job_watches(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    remote INTEGER NOT NULL DEFAULT 0,
    url TEXT NOT NULL DEFAULT '',
    posted_at TEXT,
    first_seen_at TEXT NOT NULL,
    closed_at TEXT,
    matched INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'seen',
    UNIQUE (watch_id, external_id)
  );
  CREATE INDEX job_postings_open ON job_postings(closed_at, matched);
  `,
  // What an action replaced, so undoing it can put that back instead of deleting.
  `
  ALTER TABLE activity ADD COLUMN undo_data TEXT;
  `,
  // Personal access tokens: let another program (Claude Code, a script) act as Seldon.
  `
  CREATE TABLE access_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT
  );
  `,
  // A prayer whose time passed unmarked is recorded as missed, flagged so the person can correct it.
  `
  ALTER TABLE prayer_log ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
  `,
  // A to-do can belong to a trip (book the hotel, check in online), and shows with it.
  `
  ALTER TABLE tasks ADD COLUMN trip_id TEXT REFERENCES trips(id) ON DELETE SET NULL;
  CREATE INDEX tasks_by_trip ON tasks(trip_id, done);
  `,
  // What Seldon suggests doing next for a task: who to see, what to bring, what it can do for you.
  `
  CREATE TABLE task_followups (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    steps TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // Flight options for a trip: routings to weigh before booking, each a few legs.
  `
  CREATE TABLE trip_options (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    legs TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '[]',
    recommended INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    chosen_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX trip_options_by_trip ON trip_options(trip_id, position);
  `,
  // What choosing a flight option put on its trip, so it can be taken off again.
  `
  ALTER TABLE trip_options ADD COLUMN added TEXT NOT NULL DEFAULT '{}';
  `,
  // Hotel options for a trip: places to stay to weigh before booking, nearest to where the days are spent first.
  `
  CREATE TABLE trip_stay_options (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    brand TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    area TEXT NOT NULL DEFAULT '',
    distance_km REAL,
    distance_from TEXT NOT NULL DEFAULT '',
    getting_there TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '[]',
    recommended INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    chosen_at TEXT,
    added_segment TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX trip_stay_options_by_trip ON trip_stay_options(trip_id, position);
  `,
  // finances — money in and out, what you own (crypto priced live), what you owe, price alerts.
  `
  CREATE TABLE fin_transactions (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL
  );
  CREATE INDEX fin_transactions_by_date ON fin_transactions(date);

  CREATE TABLE fin_holdings (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL DEFAULT 0,
    cost_basis REAL NOT NULL DEFAULT 0,
    price REAL,
    currency TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE fin_trades (
    id TEXT PRIMARY KEY,
    holding_id TEXT REFERENCES fin_holdings(id) ON DELETE SET NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    fee REAL NOT NULL DEFAULT 0,
    cost_out REAL NOT NULL DEFAULT 0,
    realized REAL,
    date TEXT NOT NULL,
    venue TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_holding INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX fin_trades_by_date ON fin_trades(date);

  CREATE TABLE fin_debts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    lender TEXT NOT NULL DEFAULT '',
    balance REAL NOT NULL,
    original REAL,
    apr REAL,
    min_payment REAL,
    due_day INTEGER,
    currency TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    closed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE fin_debt_payments (
    id TEXT PRIMARY KEY,
    debt_id TEXT NOT NULL REFERENCES fin_debts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX fin_debt_payments_by_debt ON fin_debt_payments(debt_id, date);

  CREATE TABLE fin_alerts (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    price REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    triggered_at TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // Recurring money: pay, bills and instalments that come round on a schedule. `done` counts the
  // occurrences already logged or skipped; the next one is worked out from the anchor and day.
  `
  CREATE TABLE fin_recurring (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    category TEXT NOT NULL,
    cadence TEXT NOT NULL,
    anchor TEXT NOT NULL,
    day INTEGER,
    done INTEGER NOT NULL DEFAULT 0,
    weekend TEXT NOT NULL DEFAULT 'none',
    auto INTEGER NOT NULL DEFAULT 1,
    end_date TEXT,
    debt_id TEXT REFERENCES fin_debts(id) ON DELETE SET NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  ALTER TABLE fin_transactions ADD COLUMN recurring_id TEXT REFERENCES fin_recurring(id) ON DELETE SET NULL;
  ALTER TABLE fin_transactions ADD COLUMN recurring_n INTEGER;
  `,
  // Projects: named groups of to-dos within a sphere (Work's "Personal Loan (BR)").
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    sphere_id TEXT NOT NULL REFERENCES spheres(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX projects_by_sphere ON projects(sphere_id, archived);
  ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
  CREATE INDEX tasks_by_project ON tasks(project_id, done);
  `,
  // The reading list: books you want to read, are reading, or have read, with what was
  // found about each (synopsis, ratings, cover). Covers are cached apart, and not exported.
  `
  CREATE TABLE reading_books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    year INTEGER,
    pages INTEGER,
    isbn TEXT NOT NULL DEFAULT '',
    synopsis TEXT NOT NULL DEFAULT '',
    synopsis_source TEXT NOT NULL DEFAULT '',
    rating REAL,
    ratings_count INTEGER,
    rating_source TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL DEFAULT '',
    buy_url TEXT NOT NULL DEFAULT '',
    info_url TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'want',
    note TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX reading_books_by_status ON reading_books(status, position);

  CREATE TABLE reading_covers (
    book_id TEXT PRIMARY KEY REFERENCES reading_books(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes BLOB,
    fetched_at TEXT NOT NULL
  );
  `,
  // Recurring money paid into a holding (CPF contributions, a standing order into savings).
  // Plain text, not a foreign key: a holding removed must pause the item, not turn it into income.
  `
  ALTER TABLE fin_recurring ADD COLUMN holding_id TEXT;
  `,
  // Where you went on a trip, as your phone reported it (OwnTracks), and the devices that get travel notifications.
  `
  CREATE TABLE trip_track (
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    acc REAL,
    alt REAL,
    vel REAL,
    PRIMARY KEY (trip_id, at)
  );
  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE push_sent (
    key TEXT PRIMARY KEY,
    sent_at TEXT NOT NULL
  );
  `,
  // What a plan item needs: how to get there from the stop before it, and what to know for it.
  `
  ALTER TABLE itinerary_items ADD COLUMN route TEXT;
  ALTER TABLE itinerary_items ADD COLUMN details TEXT NOT NULL DEFAULT '[]';
  `,
  // The terminals a flight leaves from and lands at, for the card at a glance.
  `
  ALTER TABLE trip_segments ADD COLUMN from_terminal TEXT NOT NULL DEFAULT '';
  ALTER TABLE trip_segments ADD COLUMN to_terminal TEXT NOT NULL DEFAULT '';
  `,
  // Know before you go: each trip's city guides.
  `
  ALTER TABLE trips ADD COLUMN guide TEXT;
  `,
];

/** TERMINUS_* settings, still honouring the LIFEOS_* names from before the rename. */
export function setting(name: string): string | undefined {
  return process.env[`TERMINUS_${name}`] ?? process.env[`LIFEOS_${name}`];
}

export function defaultDbPath(): string {
  const configured = setting('DB');
  if (configured) return configured;
  // Installs from before the rename keep using their existing file.
  const legacy = resolve('data/lifeos.db');
  const current = resolve('data/terminus.db');
  return existsSync(legacy) && !existsSync(current) ? legacy : current;
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
