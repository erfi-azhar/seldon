// Types shared by the server and the web client. Everything on the wire is one of these.

export type Actor = 'user' | 'agent';

export interface Sphere {
  id: string;
  /** Catalog key (e.g. "health") when the sphere came from the built-in catalog. */
  key: string | null;
  name: string;
  icon: string;
  /** Hue on the OKLCH wheel, 0–360. Every colour for the sphere derives from it. */
  hue: number;
  vision: string;
  position: number;
  archived: boolean;
  createdAt: string;
}

export interface SphereStats {
  activeGoals: number;
  /** Mean progress (0–1) of active goals, null if there are none. */
  goalProgress: number | null;
  habits: number;
  /** Share of expected habit check-ins done over the last 7 days, null if no habits. */
  habitRate: number | null;
  openTasks: number;
  lastActivityAt: string | null;
  /** Whole days since anything happened here, null if nothing ever has. */
  quietDays: number | null;
  /** 0–1 blend of habit rate and recency: how alive this sphere has been this week. */
  pulse: number;
}

export interface SphereWithStats extends Sphere {
  stats: SphereStats;
}

export type GoalStatus = 'active' | 'paused' | 'done' | 'dropped';
export type Horizon = 'quarter' | 'year' | 'someday';

export interface Milestone {
  id: string;
  goalId: string;
  title: string;
  done: boolean;
  position: number;
  doneAt: string | null;
}

export interface Goal {
  id: string;
  sphereId: string;
  title: string;
  why: string;
  status: GoalStatus;
  horizon: Horizon;
  targetDate: string | null;
  /** Optional metric that drives progress: (latest − start) / (target − start). */
  metricId: string | null;
  startValue: number | null;
  targetValue: number | null;
  manualProgress: number;
  /** 0–1, derived: linked metric, else milestones, else manualProgress. */
  progress: number;
  progressSource: 'metric' | 'milestones' | 'manual' | 'done';
  milestones: Milestone[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  sphereId: string | null;
  goalId: string | null;
  dueDate: string | null;
  done: boolean;
  doneAt: string | null;
  createdAt: string;
}

export type Cadence = 'daily' | 'weekly';

export interface Habit {
  id: string;
  sphereId: string;
  name: string;
  cadence: Cadence;
  /** Target check-ins per week: 7 for daily habits, 1–6 for weekly ones. */
  targetPerWeek: number;
  archived: boolean;
  createdAt: string;
  /** Dates (YYYY-MM-DD) checked in over the last 35 days. */
  log: string[];
  doneToday: boolean;
  /** Check-ins in the trailing 7 days. */
  weekCount: number;
  /** Consecutive days (daily) or weeks on target (weekly). */
  streak: number;
}

export interface MetricEntry {
  id: string;
  metricId: string;
  date: string;
  value: number;
  note: string;
}

export type Direction = 'up' | 'down' | 'none';

export interface Metric {
  id: string;
  sphereId: string;
  name: string;
  unit: string;
  /** Which way is "better": colours the trend. */
  direction: Direction;
  createdAt: string;
  /** Oldest → newest, capped at the most recent 120. */
  entries: MetricEntry[];
  latest: number | null;
  /** latest − first entry in the window, null with fewer than two entries. */
  change: number | null;
}

export type NoteKind = 'note' | 'link' | 'journal';

export interface Note {
  id: string;
  sphereId: string | null;
  kind: NoteKind;
  title: string;
  body: string;
  url: string;
  /** Journal entries only: the day they belong to. */
  date: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** Saved links and pictures: what Seldon made of them. */
  capture: CaptureMeta | null;
  /** "processing" while a saved link is being read. */
  status: 'ready' | 'processing' | 'failed';
}

export type CaptureKind = 'tweet' | 'video' | 'article' | 'image' | 'pdf' | 'link' | 'text';

export interface CaptureMeta {
  kind: CaptureKind;
  site: string;
  author: string;
  /** A locally stored picture or thumbnail, served from /api/files/:id. */
  imageFileId: string | null;
  summary: string;
  keyPoints: string[];
  tags: string[];
  collection: string;
  /** How it arrived: app, shortcut, share sheet, Seldon. */
  via: string;
  error?: string;
}

export interface Memory {
  id: string;
  content: string;
  createdAt: string;
}

export interface Activity {
  id: number;
  ts: string;
  actor: Actor;
  verb: string;
  entityType: string;
  entityId: string;
  sphereId: string | null;
  summary: string;
  undone: boolean;
  /** True when POST /api/activity/:id/undo can reverse it. */
  undoable: boolean;
}

export interface Overview {
  date: string;
  profile: Profile;
  spheres: SphereWithStats[];
  tasks: {
    /** Open and due today or earlier. */
    due: Task[];
    /** Open with no date. */
    anytime: Task[];
    /** Open and due in the next 7 days. */
    upcoming: Task[];
    /** Completed today. */
    doneToday: Task[];
  };
  habits: Habit[];
  journal: Note | null;
  /** Active goals with a target date inside 30 days (or already past). */
  goalsDue: Goal[];
  activity: Activity[];
}

export interface SphereDetail {
  sphere: SphereWithStats;
  goals: Goal[];
  habits: Habit[];
  metrics: Metric[];
  tasks: Task[];
  notes: Note[];
  activity: Activity[];
}

export interface SearchHit {
  type: 'goal' | 'task' | 'note' | 'habit' | 'metric' | 'sphere';
  id: string;
  title: string;
  snippet: string;
  sphereId: string | null;
}

// ── Settings ────────────────────────────────────────────────────────────────

export interface Profile {
  userName: string;
  agentName: string;
  onboarded: boolean;
}

export type ProviderKind = 'anthropic' | 'openai-compatible';

export interface ModelSettings {
  provider: ProviderKind | null;
  /** Preset the user picked in the UI (ollama, lmstudio, openai, openrouter, custom, anthropic). */
  preset: string | null;
  baseUrl: string;
  model: string;
  /** Anthropic only: reasoning effort. "auto" leaves it to the model's default. */
  effort: 'auto' | 'low' | 'medium' | 'high';
  /** Never sent to the client in full. */
  hasApiKey: boolean;
  apiKeyHint: string;
}

/** One model you have connected — a "brain". Keys never leave the server. */
export interface ConnectionView {
  id: string;
  label: string;
  provider: ProviderKind;
  preset: string | null;
  baseUrl: string;
  model: string;
  effort: ModelSettings['effort'];
  hasApiKey: boolean;
  apiKeyHint: string;
}

/** Which brain does what: conversations, and quiet background work (mail, links, sync). */
export interface Brains {
  chat: string | null;
  background: string | null;
}

export interface ConnectionInput {
  label?: string;
  provider: ProviderKind;
  preset?: string | null;
  baseUrl?: string;
  model?: string;
  effort?: ModelSettings['effort'];
  /** Omit to keep the saved key; null clears it. */
  apiKey?: string | null;
}

export interface Settings {
  profile: Profile;
  /** The chat brain, in the shape older clients expect. */
  model: ModelSettings;
  connections: ConnectionView[];
  brains: Brains;
}

export interface SettingsUpdate {
  profile?: Partial<Profile>;
  model?: Partial<Omit<ModelSettings, 'hasApiKey' | 'apiKeyHint'>> & { apiKey?: string | null };
}

// ── Agent ───────────────────────────────────────────────────────────────────

export interface ToolCallView {
  id: string;
  name: string;
  input: unknown;
  /** Present once the tool has run. */
  ok?: boolean;
  summary?: string;
  activityId?: number | null;
  undoable?: boolean;
}

/** A reply is words and actions interleaved, in the order they happened. */
export type ChatPart = { type: 'text'; text: string } | { type: 'tool'; call: ToolCallView };

export interface ChatMessage {
  role: 'user' | 'assistant';
  parts: ChatPart[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  /** The brain this conversation talks to; null means the current chat brain. */
  connectionId: string | null;
}

export interface Conversation extends ConversationSummary {
  messages: ChatMessage[];
}

/** What the client tells the agent about where the user is looking. */
export interface ChatContext {
  date: string;
  time: string;
  timezone: string;
  viewing: string;
}

/** Server-sent events on POST /api/agent/chat. */
export type AgentEvent =
  | { type: 'meta'; conversationId: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | {
      type: 'tool_end';
      id: string;
      ok: boolean;
      summary: string;
      activityId: number | null;
      undoable: boolean;
    }
  | { type: 'error'; message: string }
  | { type: 'done' };

// ── Health screenings ───────────────────────────────────────────────────────
// One document comparing up to two check-ups. `a` is the earlier visit, `b` the latest.

export type ScreenStatus = 'ok' | 'watch' | 'flag' | 'na';
export type ScreenTrend = 'better' | 'worse' | 'same' | 'new' | 'na';

export interface ScreenResult {
  /** Group, e.g. "Heart & cholesterol". */
  g: string;
  n: string;
  sub?: string;
  u?: string;
  a: string | null;
  b: string | null;
  lo?: number;
  hi?: number;
  ref?: string;
  s25?: ScreenStatus;
  s?: ScreenStatus;
  v?: ScreenTrend;
  chl?: string;
  note?: string;
}

export interface Screenings {
  title: string;
  subtitle?: string;
  updated?: string;
  visits: { label: string; date?: string; place?: string }[];
  next?: string;
  ringNotes?: { watch?: string; flag?: string };
  summary?: string[];
  tiles?: { lab: string; a: number; b: number; val: string; u: string; v: 'better' | 'worse' | 'watch'; dir: 'up' | 'down'; st: ScreenStatus; stt: string; sub: string }[];
  actions?: { p: 'high' | 'medium' | 'low'; t: string; body: string; also?: string; src?: string }[];
  moved?: { h: string; s: ScreenStatus; items: [string, string, string][] }[];
  slopes?: { n: string; u: string; a: number; b: number; dp: number; d: [number, number]; band: [number, number]; rng: string; st: ScreenStatus; stt: string; note?: string; ref?: number; refl?: string }[];
  scans?: {
    t: string;
    tags: string[];
    s: ScreenStatus;
    lbl: string;
    compare?: [string, string];
    bars?: { name: string; a: number; b: number }[];
    barNote?: string;
    facts?: [string, string][];
    read?: string;
  }[];
  risks?: { n: string; h: string; now: number; avg: number; tgt: number; mult: number }[];
  riskNote?: string;
  results: ScreenResult[];
  notes?: [string, string][];
  footer?: string[];
}

// ── Signals ─────────────────────────────────────────────────────────────────
// Things from outside that may need you: an important email, a new job opening, a
// trip about to start. Each can carry suggested next steps.

export type SignalAction =
  | { type: 'task'; label: string; title: string; dueDate?: string | null; sphereId?: string | null; notes?: string }
  | { type: 'reply'; label: string; to: string; subject: string; body: string; inReplyTo?: string | null }
  | { type: 'link'; label: string; url: string };

export type SignalStatus = 'new' | 'seen' | 'done' | 'dismissed';

export interface Signal {
  id: string;
  source: string;
  kind: string;
  title: string;
  body: string;
  url: string;
  sphereId: string | null;
  /** 0 low · 1 normal · 2 important · 3 urgent. */
  priority: number;
  actions: SignalAction[];
  status: SignalStatus;
  createdAt: string;
  /** When the thing itself happened (email received, job posted). */
  occurredAt: string;
  data: Record<string, unknown>;
}

// ── Integrations ────────────────────────────────────────────────────────────

export interface IntegrationStatus {
  id: string;
  enabled: boolean;
  configured: boolean;
  /** Non-secret settings, safe to show. */
  settings: Record<string, unknown>;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  running: boolean;
}

// ── Faith: prayer ───────────────────────────────────────────────────────────

export const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
export type PrayerName = (typeof PRAYERS)[number];
/** prayed: in its time · late: prayed after its time · missed: still owed. */
export type PrayerStatus = 'prayed' | 'late' | 'missed';

export interface PrayerSettings {
  lat: number | null;
  lng: number | null;
  label: string;
  timezone: string;
  method: string;
  madhab: 'shafi' | 'hanafi';
  /** Minutes added to each calculated time, to match a local timetable. */
  adjustments: Record<PrayerName, number>;
  /** Missed prayers from before you started tracking, still to make up. */
  backlog: Record<PrayerName, number>;
}

export interface PrayerDay {
  date: string;
  /** ISO instants; sunrise marks the end of Fajr's time. */
  times: Record<PrayerName | 'sunrise', string>;
  log: Partial<Record<PrayerName, PrayerStatus>>;
}

export interface FaithState {
  configured: boolean;
  settings: PrayerSettings;
  today: PrayerDay | null;
  /** The prayer whose time it is now, and the next one to come. */
  current: { prayer: PrayerName; endsAt: string } | null;
  next: { prayer: PrayerName; at: string } | null;
  /** The last seven days, oldest first, including today. */
  week: PrayerDay[];
  /** Past prayers in the last week you haven't marked. */
  unmarked: { date: string; prayer: PrayerName }[];
  /** Missed prayers still to make up: logged misses plus the backlog. */
  owed: Record<PrayerName, number>;
  hijri: string;
  ramadan: { start: string; daysUntil: number; inRamadan: boolean; day: number | null } | null;
}

// ── Health: food, training, body composition ────────────────────────────────

export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface FoodEntry {
  id: string;
  date: string;
  time: string;
  meal: Meal;
  name: string;
  amount: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  source: string;
}

export interface Macros {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface NutritionTargets {
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

export interface WorkoutSet {
  reps: number | null;
  weight: number | null;
}

export interface Workout {
  id: string;
  date: string;
  name: string;
  type: 'strength' | 'run' | 'walk' | 'cycle' | 'swim' | 'cardio' | 'mobility' | 'sport' | 'other';
  durationMin: number | null;
  distanceKm: number | null;
  kcal: number | null;
  notes: string;
  exercises: { name: string; sets: WorkoutSet[] }[];
  source: string;
}

export interface BodyReading {
  id: string;
  date: string;
  weightKg: number | null;
  bodyFatPct: number | null;
  muscleKg: number | null;
  visceralFat: number | null;
  waterPct: number | null;
  bmr: number | null;
  source: string;
  notes: string;
}

export interface HealthState {
  date: string;
  targets: NutritionTargets;
  today: { entries: FoodEntry[]; totals: Macros };
  /** Daily totals for the last 14 days, oldest first. */
  days: ({ date: string } & Macros)[];
  workouts: Workout[];
  week: { sessions: number; minutes: number; strength: number; cardio: number };
  body: BodyReading[];
}

// ── MCP connections ─────────────────────────────────────────────────────────

export interface McpServerView {
  id: string;
  name: string;
  url: string;
  /** What Seldon may do with this server's tools. */
  mode: 'off' | 'read' | 'write';
  status: 'connected' | 'needs_auth' | 'error' | 'unknown';
  error: string | null;
  toolCount: number;
  /** Tools never offered to Seldon: anything marked destructive, and deletes. */
  withheld: string[];
  connectedAt: string | null;
}
