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

/** A named group of to-dos within a sphere, like "Personal Loan (BR)" in Work. */
export interface Project {
  id: string;
  sphereId: string;
  name: string;
  archived: boolean;
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  sphereId: string | null;
  goalId: string | null;
  /** The trip this to-do is for, if any. */
  tripId: string | null;
  /** The project this to-do belongs to, if any. */
  projectId: string | null;
  dueDate: string | null;
  done: boolean;
  doneAt: string | null;
  createdAt: string;
}

/** One next step Seldon suggests for a task, with what you can do about it in a tap. */
export interface FollowupStep {
  title: string;
  detail: string;
  /** Hand this to Seldon: the button's label and what it is asked to do. */
  ask: { label: string; prompt: string } | null;
  /** Add this as a task of its own. */
  task: { title: string; dueDate: string | null } | null;
  /** The task above has been added. */
  added: boolean;
}

/**
 * What Seldon makes of a task. pending: it is thinking; ready: it has suggestions; none: the task
 * needs nothing more; failed: it could not answer; unavailable: no background brain is connected.
 */
export interface TaskFollowups {
  status: 'pending' | 'ready' | 'none' | 'failed' | 'unavailable';
  summary: string;
  steps: FollowupStep[];
  error: string | null;
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
  /** Check-ins this calendar week (Monday to Sunday). */
  weekCount: number;
  /** Consecutive days (daily) or calendar weeks on target (weekly). */
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
  /** The sphere's projects, archived ones left out. */
  projects: Project[];
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
  /** When tracking began (ISO): prayers that ended before this are never counted as missed. */
  since?: string | null;
  /** The last date whose five prayers have all been settled. */
  settledThrough?: string | null;
}

export interface PrayerDay {
  date: string;
  /** ISO instants; sunrise marks the end of Fajr's time. */
  times: Record<PrayerName | 'sunrise', string>;
  log: Partial<Record<PrayerName, PrayerStatus>>;
}

// ── Weather, for the Today sky ──────────────────────────────────────────────

export type WeatherKind = 'clear' | 'cloudy' | 'overcast' | 'fog' | 'drizzle' | 'rain' | 'showers' | 'snow' | 'storm';

/** One hour ahead, for the weather card. */
export interface WeatherHour {
  /** The start of the hour (ISO). */
  at: string;
  kind: WeatherKind;
  code: number;
  /** °C. */
  temperature: number;
  /** Chance of rain or snow, 0–100. */
  rainChance: number;
  isDay: boolean;
}

/** The weather now at a place, from Open-Meteo. */
export interface Weather {
  kind: WeatherKind;
  /** The WMO weather code it was read from. */
  code: number;
  /** Share of the sky under cloud, 0–100. */
  cloudCover: number;
  /** Rain, showers and snow in the last hour, in mm. */
  precipitation: number;
  windKmh: number;
  /** °C, and what it feels like with humidity and wind. */
  temperature: number;
  feelsLike: number;
  /** Relative humidity, 0–100. */
  humidity: number;
  isDay: boolean;
  /** The next few hours, after this one. */
  hours: WeatherHour[];
  /** When Open-Meteo last updated it (ISO). */
  observedAt: string;
}

export interface FaithState {
  configured: boolean;
  settings: PrayerSettings;
  today: PrayerDay | null;
  /** Tomorrow's prayer times, for planning sahur the evening before. */
  tomorrow: PrayerDay['times'] | null;
  /** The prayer whose time it is now, and the next one to come. */
  current: { prayer: PrayerName; endsAt: string } | null;
  next: { prayer: PrayerName; at: string } | null;
  /** The last seven days, oldest first, including today. */
  week: PrayerDay[];
  /** Prayers in the last week whose time passed unmarked, so were counted as missed. Newest first. */
  autoMissed: { date: string; prayer: PrayerName }[];
  /** Missed prayers still to make up: logged misses plus the backlog. */
  owed: Record<PrayerName, number>;
  hijri: string;
  /** The next (or current) Ramadan: its first and last day by the Umm al-Qura calendar. */
  ramadan: { start: string; end: string; daysUntil: number; inRamadan: boolean; day: number | null } | null;
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

// ── Finances ────────────────────────────────────────────────────────────────

export type TxKind = 'income' | 'expense';

export interface Transaction {
  id: string;
  date: string;
  kind: TxKind;
  amount: number;
  currency: string;
  category: string;
  description: string;
  source: string;
  /** The recurring item that logged it, if one did. */
  recurringId: string | null;
}

export type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';

export interface Recurring {
  id: string;
  kind: TxKind;
  name: string;
  amount: number;
  currency: string;
  category: string;
  cadence: Frequency;
  /** The first occurrence; later ones follow the cadence from it. */
  anchor: string;
  /** Day of the month for monthly, quarterly and yearly (31 means the month's last day). */
  day: number | null;
  /** When a date lands on a weekend or public holiday: leave it, or move it to the working day before or after. */
  weekend: 'none' | 'before' | 'after';
  /** Logged by itself when due; otherwise it waits to be marked paid. */
  auto: boolean;
  endDate: string | null;
  /** Paying it pays down this debt instead of logging spending. */
  debtId: string | null;
  /** Paid into this holding (CPF, savings) instead of logged as income or spending. */
  holdingId: string | null;
  active: boolean;
  next: string | null;
  /** What it comes to in an average month, in its own currency. */
  monthly: number;
}

export interface Upcoming {
  recurringId: string;
  name: string;
  kind: TxKind;
  amount: number;
  currency: string;
  date: string;
  auto: boolean;
  debtId: string | null;
  holdingId: string | null;
  overdue: boolean;
}

export type HoldingKind = 'cash' | 'crypto' | 'stock' | 'fund' | 'retirement' | 'property' | 'other';

export interface Holding {
  id: string;
  kind: HoldingKind;
  name: string;
  /** A ticker: BTC for crypto (priced live), AAPL for a stock. Empty for cash or property. */
  symbol: string;
  quantity: number;
  /** What it cost in total, in its own currency. */
  costBasis: number;
  /** Unit price you set; null when it is priced live. */
  price: number | null;
  currency: string;
  notes: string;
  updatedAt: string;
  /** Worked out: unit price used, value and gain, in its own currency and in the base currency. */
  unitPrice: number | null;
  live: boolean;
  value: number | null;
  gain: number | null;
  gainPct: number | null;
  valueBase: number | null;
  change24hPct: number | null;
}

export interface Trade {
  id: string;
  holdingId: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  /** Price per coin, in USD. */
  price: number;
  fee: number;
  /** Profit or loss a sale locked in, in USD; null for a buy. */
  realized: number | null;
  date: string;
  venue: string;
  notes: string;
}

export type DebtKind = 'credit_card' | 'loan' | 'mortgage' | 'car' | 'student' | 'personal' | 'bnpl' | 'other';

export interface Debt {
  id: string;
  name: string;
  kind: DebtKind;
  lender: string;
  balance: number;
  original: number | null;
  apr: number | null;
  minPayment: number | null;
  dueDay: number | null;
  currency: string;
  notes: string;
  closedAt: string | null;
  /** At the minimum payment: months to clear it and the interest paid on the way. null when it never clears. */
  payoff: { months: number; interest: number; date: string } | null;
  paidOffPct: number | null;
  /** The next due date from dueDay. */
  nextDue: string | null;
  payments: { id: string; date: string; amount: number }[];
}

export interface PriceAlert {
  id: string;
  symbol: string;
  direction: 'above' | 'below';
  price: number;
  note: string;
  triggeredAt: string | null;
}

export interface Quote {
  /** The coin, e.g. BTC. Prices are in US dollars. */
  symbol: string;
  price: number;
  open: number;
  high: number;
  low: number;
  changePct: number;
  /** 24h volume in US dollars. */
  volume: number;
  source: 'binance' | 'coinbase' | 'fixed';
  at: number;
}

export interface MarketState {
  quotes: Quote[];
  /** Hourly closes over the last day, oldest first, by coin. */
  sparks: Record<string, number[]>;
  /** How prices are arriving: a live stream, polling, or not at all. */
  status: 'live' | 'polling' | 'offline' | 'idle';
  source: string | null;
  error: string | null;
  /** Coins no venue lists. */
  unknown: string[];
}

export interface PlanRules {
  /** Months of essential spending to keep as an emergency fund. */
  emergencyMonths: number;
  /** The most of your investments crypto may make up, in percent. */
  cryptoCapPct: number;
  /** Pay kept as guilt-free spending each month, in percent. */
  funPct: number;
  /**
   * Singapore tax relief through the year: 'auto' suggests SRS when the top tax rate is 11.5% or
   * more; 'srs' always; 'srs+cpf' adds a CPF cash top-up to your own Special Account; 'off' never.
   */
  reliefs: 'auto' | 'srs' | 'srs+cpf' | 'off';
  /** The yearly SRS contribution cap: S$15,300 for citizens and PRs, S$35,700 for foreigners. */
  srsCap: number;
}

export type PlanBucketKey = 'bills' | 'yearly' | 'everyday' | 'fun' | 'buffer' | 'debt' | 'emergency' | 'relief' | 'crypto' | 'invest';

export interface PlanBucket {
  key: PlanBucketKey;
  label: string;
  amount: number;
  /** Why this much, in a sentence. */
  reason: string;
  /** The move to make this month, when there is one (a transfer, an extra payment). */
  action: string | null;
}

/** The year's tax relief: room left, and what using it would save. */
export interface ReliefPlan {
  year: number;
  /** The last day a contribution counts for the year. */
  deadline: string;
  srs: { cap: number; done: number; left: number };
  /** A CPF cash top-up to your own Special Account; null unless the rules include it. */
  cpf: { cap: number; done: number; left: number } | null;
  /** A rough taxable income from pay (bonuses and RSUs add to it), and its top rate. */
  chargeable: number;
  rate: number;
  /** Tax saved if all the room left is used. */
  saving: number;
}

/** Where this month's pay should go, worked out from what's on file. A rule of thumb, not advice. */
export interface SalaryPlan {
  month: string;
  pay: number;
  /** Where the pay figure came from: recurring income, or the average of recent months. */
  payFrom: 'recurring' | 'history';
  /** Bills, yearly set-asides and everyday spending, in a month. */
  essentials: number;
  emergency: { target: number; have: number };
  buckets: PlanBucket[];
  /** How far pay falls short of essentials; null when it covers them. */
  shortfall: number | null;
  rules: PlanRules;
  notes: string[];
  /** Singapore tax relief for the year, when the rules suggest it. */
  relief: ReliefPlan | null;
}

export interface FinanceState {
  date: string;
  currency: string;
  /** Rates from one US dollar; null until fetched. */
  fx: { rates: Record<string, number>; at: string } | null;
  month: {
    key: string;
    income: number;
    expense: number;
    net: number;
    savingsRate: number | null;
    byCategory: { category: string; kind: TxKind; amount: number; budget: number | null }[];
    /** Pay and bills still to come before the month ends (debt instalments left out, as payments are). */
    expected: { income: number; expense: number; net: number };
  };
  /** The last six months, oldest first. */
  months: { key: string; income: number; expense: number }[];
  transactions: Transaction[];
  recurring: Recurring[];
  /** The next five weeks, and anything waiting to be marked paid. */
  upcoming: Upcoming[];
  /** Recurring income and outgoings in an average month, in the base currency. */
  recurringMonthly: { income: number; expense: number };
  budgets: Record<string, number>;
  holdings: Holding[];
  allocation: { kind: HoldingKind; value: number }[];
  trades: Trade[];
  crypto: { value: number; cost: number; gain: number; realized: number; change24h: number } | null;
  debts: Debt[];
  alerts: PriceAlert[];
  watchlist: string[];
  netWorth: { assets: number; debts: number; net: number; unpriced: string[] };
  market: MarketState;
  /** This month's recommended split of pay; null until there's income to plan. */
  plan: SalaryPlan | null;
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

// ── Travel ──────────────────────────────────────────────────────────────────

export type TripPurpose = 'work' | 'leisure';

export interface Segment {
  id: string;
  tripId: string | null;
  kind: 'flight' | 'stay' | 'train' | 'car' | 'event';
  title: string;
  /** Flights: carrier code and number ("SQ 638"). Stays: the hotel. */
  carrier: string;
  number: string;
  fromCode: string;
  fromName: string;
  toCode: string;
  toName: string;
  /** Local wall-clock times at each end, "YYYY-MM-DDTHH:MM", with their IANA zones. */
  startLocal: string;
  startTz: string;
  endLocal: string;
  endTz: string;
  /** The same two moments as instants (ISO), for ordering and countdowns. */
  startUtc: string;
  endUtc: string;
  cabin: string;
  seat: string;
  confirmation: string;
  /** Flights: the terminals it leaves from and lands at ("3", "1", "T2"), empty when unknown. */
  fromTerminal: string;
  toTerminal: string;
  /** Flights: when you said you'd checked in (ISO), so Today sends you to the gate. */
  checkedInAt?: string | null;
  /** Flights: how many minutes late it leaves (and so lands); 0 or missing when on time. */
  delayMin?: number;
  address: string;
  notes: string;
  source: string;
  /** Flights: the cities at each end, when the airports are known. */
  fromCity?: string;
  toCity?: string;
  /** Flights: each airport's latitude and longitude, when known, for drawing the route. */
  fromGeo?: [number, number] | null;
  toGeo?: [number, number] | null;
  /** Flights: lounges your fare and status get you into. */
  lounges: LoungeAccess[];
  /** Stays: what your hotel status gets you there. */
  perks: string[];
  /** Stays at a Marriott-family hotel: the Bonvoy elite nights it earns and where they leave you. */
  eliteNights?: EliteNights | null;
}

/** Bonvoy elite nights a stay earns, counted on from the nights last recorded on the Bonvoy card. */
export interface EliteNights {
  /** Nights this stay earns: one per night. */
  nights: number;
  /** The calendar year they count towards (the year of check-out). */
  year: number;
  /** Already in the recorded count: it checked out before the count was recorded. */
  counted: boolean;
  /** Nights in that year before this stay, and after it. Null when there is no count to start from. */
  before: number | null;
  after: number | null;
  /** Where `before` comes from: the recorded count (only for the year it was recorded in) and the stays since. */
  recorded: { nights: number; asOf: string } | null;
  earlier: { title: string; nights: number }[];
  /** The highest tier this stay takes you to, if it crosses one; and the next tier after it. */
  reaches: string | null;
  next: { tier: string; at: number } | null;
}

export interface ItineraryItem {
  id: string;
  tripId: string;
  date: string;
  time: string | null;
  title: string;
  place: string;
  notes: string;
  kind: 'activity' | 'food' | 'transit' | 'work' | 'rest';
  done: boolean;
  /** How to get there from where you'll be just before. */
  route: ItemRoute | null;
  /** Everything else worth knowing for it, as small labelled modules. */
  details: ItemDetail[];
}

/** One thing to know for a plan item: hours that day, cost, booking, what to bring, a heads-up… */
export interface ItemDetail {
  kind: 'hours' | 'cost' | 'booking' | 'bring' | 'dress' | 'contact' | 'food' | 'prayer' | 'heads-up' | 'tip';
  /** A few words: "Open 11:00–23:00", "€25 entry", "Book ahead". */
  label: string;
  /** The detail in a sentence or two. */
  text: string;
  url?: string;
}

/** Getting to a plan item: from the stop before it (or the hotel, or the airport), how, how long, step by step. */
export interface ItemRoute {
  from: string;
  mode: 'walk' | 'transit' | 'taxi' | 'drive';
  minutes: number;
  steps: string[];
}

export interface Trip {
  id: string;
  title: string;
  purpose: TripPurpose;
  destination: string;
  startDate: string;
  endDate: string;
  notes: string;
  segments: Segment[];
  itinerary: ItineraryItem[];
  /** To-dos for the trip: open ones by due date, then done ones. */
  todos: Task[];
  /** Flight routings to weigh before booking. */
  options: FlightOption[];
  /** Hotels to weigh before booking, nearest first. */
  stayOptions: StayOption[];
  /** Seldon's airport and layover notes, keyed by flight segment id. */
  companion: Record<string, { lounges: string[]; plan: string[]; generatedAt: string; picks?: LoungePick[] }>;
  /** Know before you go: tips for each city on the trip, written ahead of it. */
  guide: TripGuide | null;
}

/** One flight within a flight option, with local times at each end and the instants they make. */
export interface OptionLeg {
  carrier: string;
  number: string;
  fromCode: string;
  toCode: string;
  fromCity: string;
  toCity: string;
  startLocal: string;
  endLocal: string;
  startTz: string;
  endTz: string;
  startUtc: string;
  endUtc: string;
  /** Great-circle distance in statute miles: what frequent-flyer programmes credit. */
  miles: number;
  /** The cabin booked on this flight. */
  cabin: Cabin;
}

export type Cabin = 'economy' | 'premium' | 'business';

/** A way to make a journey, before it is booked: its flights, and what speaks for and against it. */
export interface FlightOption {
  id: string;
  tripId: string;
  title: string;
  summary: string;
  legs: OptionLeg[];
  notes: string[];
  recommended: boolean;
  /** When its flights were added to the trip as planned flights. */
  chosenAt: string | null;
  createdAt: string;
}

/** A place to stay, before it is booked: where it is, how far from where the days are spent, and what speaks for it. */
export interface StayOption {
  id: string;
  tripId: string;
  name: string;
  /** The chain or programme ("Marriott"), for status perks. */
  brand: string;
  address: string;
  /** The neighbourhood ("Itaim Bibi"). */
  area: string;
  /** Straight-line or walking distance to `distanceFrom`, in kilometres, when known. */
  distanceKm: number | null;
  /** What the distance is measured to ("the office"). */
  distanceFrom: string;
  /** How long it takes to get there ("12–15 min walk"). */
  gettingThere: string;
  summary: string;
  notes: string[];
  recommended: boolean;
  /** When it was added to the trip as a planned stay. */
  chosenAt: string | null;
  createdAt: string;
}

export interface LoyaltyAccount {
  id: string;
  program: string;
  /** krisflyer · bonvoy · other airline or hotel programme · lounge (Priority Pass, a card) */
  kind: 'airline' | 'hotel' | 'lounge';
  tier: string;
  points: number | null;
  /** Progress towards the next tier: elite miles, PPS value, nights. */
  progress: number | null;
  progressTarget: number | null;
  progressLabel: string;
  expires: string | null;
  memberSuffix: string;
  updatedAt: string;
  source: string;
}

/** A lounge the agent found at an airport for one flight, and whether it works for this trip. */
export interface LoungePick {
  name: string;
  /** Terminal, concourse or gates, and airside or landside. */
  where: string;
  /** How they get in: "Revolut Ultra", "Business fare", "Pay at the door, about €40". */
  access: string;
  /** Usable on this trip: airside where they land and leave, and open at the time. */
  reachable: boolean;
  /** One line worth knowing: showers, the best of several, why it doesn't work. */
  note: string;
}

export interface LoungeAccess {
  access: string;
  basis: string;
}

export interface TravelContext {
  /** What is happening now, if anything. */
  mode: 'none' | 'upcoming' | 'departing' | 'away';
  trip: Trip | null;
  /** The next flight in the next 36 hours, with minutes until it leaves. */
  flight: (Segment & { departsInMin: number }) | null;
  /** Where you are staying tonight, on an active trip. */
  stay: Segment | null;
  layovers: { airport: string; city: string; hours: number; afterSegmentId: string; nextSegmentId: string }[];
  dayOfTrip: number | null;
  tripDays: number | null;
  /** Where you are on an active trip, from the last flight that landed or the stay you are in. */
  here: { tz: string; city: string } | null;
  /** Home, from the home airport. */
  home: { tz: string; city: string } | null;
}

export interface TravelSettings {
  homeAirport: string;
}

export interface TravelState {
  settings: TravelSettings;
  trips: Trip[];
  loyalty: LoyaltyAccount[];
  context: TravelContext;
}

// ── Job alerts ──────────────────────────────────────────────────────────────

export type JobBoardKind = 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'smartrecruiters' | 'recruitee';

export interface JobWatch {
  id: string;
  company: string;
  careersUrl: string;
  ats: JobBoardKind;
  board: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  openings: number;
  matching: number;
}

export interface JobPosting {
  id: string;
  watchId: string;
  company: string;
  title: string;
  location: string;
  department: string;
  remote: boolean;
  url: string;
  postedAt: string | null;
  firstSeenAt: string;
  /** new: appeared since you started watching; saved / dismissed: your call; seen: there when you started. */
  status: 'new' | 'seen' | 'saved' | 'dismissed';
  /** At a company, or with a word in its title or team, that you asked to highlight. */
  highlighted: boolean;
}

export interface JobPreferences {
  /** A title must contain one of these (empty: any). */
  keywords: string[];
  /** …and none of these. */
  exclude: string[];
  /** The location must contain one of these (empty: anywhere). */
  locations: string[];
  /** Remote roles count wherever they are. */
  remote: boolean;
  /** Roles at these companies, or with these words in the title or team, come first. */
  highlight: string[];
}

export interface JobsState {
  preferences: JobPreferences;
  watches: JobWatch[];
  /** Open roles that match, newest first. */
  postings: JobPosting[];
  running: boolean;
  lastRunAt: string | null;
}

// ── Access tokens ───────────────────────────────────────────────────────────

export type AccessScope = 'read' | 'write';

export interface AccessToken {
  id: string;
  name: string;
  scope: AccessScope;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/** A trip's route as the phone recorded it, day by day: [lat, lon, ms] points and ground covered. */
export interface TripTrack {
  days: { date: string; points: [number, number, number][]; km: number }[];
  points: number;
}

/** Whether travel notifications reach a device, and whether the tracker app is set up. */
export interface JourneyStatus {
  push: { publicKey: string; devices: { label: string; since: string }[] };
  tracking: { on: boolean; lastAt: string | null };
}

// ── Reading list ────────────────────────────────────────────────────────────

export type BookStatus = 'want' | 'reading' | 'read';

export interface Book {
  id: string;
  title: string;
  author: string;
  year: number | null;
  pages: number | null;
  isbn: string;
  synopsis: string;
  /** Where the synopsis came from: 'Google Books', 'Open Library', the agent's name, or 'you'. */
  synopsisSource: string;
  /** Average rating out of 5, from the source with the most ratings. */
  rating: number | null;
  ratingsCount: number | null;
  ratingSource: string;
  /** Where the cover is served from (this server keeps a copy), or '' when none was found. */
  cover: string;
  buyUrl: string;
  /** The book's page at its source, for more detail. */
  infoUrl: string;
  /** The spine's colour, read from the cover's left edge (#rrggbb), or '' until it is. */
  color: string;
  status: BookStatus;
  note: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** A match for a search, before it is added. */
export interface BookCandidate {
  /** 'ol:OL123W' (Open Library work) or 'gb:abc' (Google Books volume). */
  ref: string;
  title: string;
  author: string;
  year: number | null;
  /** A small cover to tell editions apart by. */
  thumb: string;
}

/** What to know before a trip, city by city: safety first, then money, getting around and the rest. */
export interface TripGuide {
  cities: GuideCity[];
  updatedAt: string;
}

export interface GuideCity {
  name: string;
  /** Numbers to call: "Police 190", "Ambulance 192". */
  emergency: string[];
  sections: GuideSection[];
}

export interface GuideSection {
  kind: 'safety' | 'money' | 'transport' | 'apps' | 'etiquette' | 'food' | 'health' | 'weather' | 'power' | 'language' | 'entry';
  title: string;
  tips: string[];
}

// ── Quran study ─────────────────────────────────────────────────────────────

export interface QuranChapter {
  id: number;
  name: string;
  nameArabic: string;
  /** "The Opener". */
  meaning: string;
  verses: number;
}

/** A paragraph of tafsir: a heading, plain text, or a line of Arabic. */
export interface TafsirBlock {
  kind: 'h' | 'p' | 'ar';
  text: string;
}

export interface QuranVerse {
  key: string;
  surah: number;
  ayah: number;
  arabic: string;
  translation: string;
  translator: string;
  tafsir: { id: number; name: string; covers: string[]; blocks: TafsirBlock[] } | null;
}

export interface QuranStudy {
  surah: number;
  ayah: number;
  key: string;
  tafsir: number;
  tafsirs: { id: number; name: string }[];
  studiedToday: boolean;
  /** Ayat marked studied since Monday, and ever. */
  week: number;
  total: number;
  /** Days in a row with at least one ayah studied, up to today or yesterday. */
  streak: number;
}

// ── Crypto Twitter ──────────────────────────────────────────────────────────

export type XPostKind = 'trade_idea' | 'news' | 'warning' | 'launch' | 'airdrop' | 'macro' | 'analysis' | 'opinion' | 'other';

export interface XAccount {
  id: string;
  username: string;
  name: string;
  bio: string;
  followers: number;
  /** null until classified. */
  crypto: boolean | null;
  tags: string[];
  why: string;
  monitored: boolean;
}

export interface XPost {
  id: string;
  url: string;
  text: string;
  createdAt: string;
  likes: number;
  reposts: number;
  author: { id: string; username: string; name: string };
  /** The background brain's read of it; null until triaged. */
  triage: {
    relevant: boolean;
    kind: XPostKind;
    coins: string[];
    sentiment: 'bullish' | 'bearish' | 'neutral';
    summary: string;
    importance: number;
  } | null;
  /** Coins it mentions that you hold or watch. */
  mine: string[];
}

export interface XCoinBuzz {
  symbol: string;
  mentions: number;
  bullish: number;
  bearish: number;
  /** Held or watched. */
  mine: boolean;
  lastAt: string;
}

export interface XWatchState {
  configured: boolean;
  username: string;
  budgetUsd: number;
  pollMinutes: number;
  spentUsd: number;
  /** What today may still spend, pacing the budget over the month. */
  todayLeftUsd: number;
  followingCount: number | null;
  followingSyncedAt: string | null;
  /** What reading the whole following list once would cost. */
  followingCostUsd: number | null;
  lastPollAt: string | null;
  lastError: string | null;
  running: boolean;
  accounts: XAccount[];
  counts: { following: number; crypto: number; monitored: number; unclassified: number };
  posts: XPost[];
  /** Coins mentioned in the last day, most-mentioned first. */
  buzz: XCoinBuzz[];
}

/** One theme of a tafsir passage, summarised by the background model from that passage alone. */
export interface QuranTheme {
  kind: 'meaning' | 'context' | 'lesson' | 'virtue' | 'language' | 'ruling';
  title: string;
  summary: string;
}

export type QuranThemes =
  | { status: 'ready'; tafsir: string; covers: string[]; themes: QuranTheme[] }
  /** No tafsir passage for this ayah, or no model to read it: nothing to show. */
  | { status: 'none'; reason: string };
