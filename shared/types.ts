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
  /** The trip this to-do is for, if any. */
  tripId: string | null;
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
  /** When Open-Meteo last updated it (ISO). */
  observedAt: string;
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
  };
  /** The last six months, oldest first. */
  months: { key: string; income: number; expense: number }[];
  transactions: Transaction[];
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
