// The built-in sphere catalog. A sphere is an area of life you want to steward on purpose.
// Each entry ships a "starter kit" — habits and metrics offered as one-tap suggestions,
// never created without the user asking.

import type { Cadence, Direction } from './types.ts';

export interface StarterHabit {
  name: string;
  cadence: Cadence;
  targetPerWeek: number;
}

export interface StarterMetric {
  name: string;
  unit: string;
  direction: Direction;
}

export interface CatalogSphere {
  key: string;
  name: string;
  icon: string;
  hue: number;
  /** One line shown in pickers. */
  blurb: string;
  /** Placeholder that nudges a good vision statement. */
  visionPrompt: string;
  /** Part of the default set offered at onboarding. */
  core: boolean;
  habits: StarterHabit[];
  metrics: StarterMetric[];
  /** Example goals, used as placeholders/suggestions. */
  goalIdeas: string[];
}

const daily = (name: string): StarterHabit => ({ name, cadence: 'daily', targetPerWeek: 7 });
const weekly = (name: string, n = 1): StarterHabit => ({ name, cadence: 'weekly', targetPerWeek: n });
const metric = (name: string, unit = '', direction: Direction = 'up'): StarterMetric => ({
  name,
  unit,
  direction,
});

export const CATALOG: CatalogSphere[] = [
  {
    key: 'health',
    name: 'Health',
    icon: 'heart-pulse',
    hue: 152,
    blurb: 'Body, energy, sleep, food.',
    visionPrompt: 'What does feeling strong and well look like for you?',
    core: true,
    habits: [daily('Move for 30 minutes'), daily('Lights out on time'), weekly('Strength training', 3)],
    metrics: [metric('Weight', 'kg', 'down'), metric('Sleep', 'h'), metric('Resting heart rate', 'bpm', 'down')],
    goalIdeas: ['Run 10 km without stopping', 'Sleep 7+ hours on weeknights'],
  },
  {
    key: 'finances',
    name: 'Finances',
    icon: 'landmark',
    hue: 86,
    blurb: 'Earning, saving, giving, investing.',
    visionPrompt: 'What would financial peace look like — and what is the money for?',
    core: true,
    habits: [weekly('Review spending'), weekly('No-spend day', 2)],
    metrics: [metric('Net worth'), metric('Savings'), metric('Monthly spend', '', 'down')],
    goalIdeas: ['Six months of expenses in an emergency fund', 'Be debt-free'],
  },
  {
    key: 'work',
    name: 'Work',
    icon: 'briefcase',
    hue: 246,
    blurb: 'Career, craft, the day job.',
    visionPrompt: 'What do you want your work to be known for?',
    core: true,
    habits: [weekly('Deep-work block', 5), weekly('Weekly review')],
    metrics: [metric('Deep-work hours', 'h')],
    goalIdeas: ['Lead a project end to end', 'Earn the next level'],
  },
  {
    key: 'side-projects',
    name: 'Side Projects',
    icon: 'rocket',
    hue: 318,
    blurb: 'Things you build because you want to.',
    visionPrompt: 'What are you building, and who is it for?',
    core: true,
    habits: [weekly('Build session', 3), weekly('Ship something small')],
    metrics: [metric('Hours invested', 'h'), metric('Users')],
    goalIdeas: ['Ship v1 to five real users', 'Write up what I learned'],
  },
  {
    key: 'travels',
    name: 'Travels',
    icon: 'plane',
    hue: 208,
    blurb: 'Trips, places, time away.',
    visionPrompt: 'Where do you want to have been — and with whom?',
    core: true,
    habits: [weekly('Plan the next trip')],
    metrics: [metric('Travel fund'), metric('Countries visited'), metric('Days away this year', 'd')],
    goalIdeas: ['A long trip with family this year', 'One weekend away each quarter'],
  },
  {
    key: 'faith',
    name: 'Faith',
    icon: 'moon-star',
    hue: 284,
    blurb: 'Salah, Quran, dhikr, giving.',
    visionPrompt: 'What does a life lived for Allah look like, day to day?',
    core: true,
    habits: [
      daily('Fajr'),
      daily('Dhuhr'),
      daily('Asr'),
      daily('Maghrib'),
      daily('Isha'),
      daily('Quran reading'),
      daily('Morning and evening adhkar'),
      weekly('Fast Monday and Thursday', 2),
      weekly("Jumu'ah at the masjid"),
      weekly('Give sadaqah'),
    ],
    metrics: [metric('Quran pages read', 'pp'), metric('Sadaqah given'), metric('Juz memorised')],
    goalIdeas: ['Complete a khatm of the Quran', "Memorise Juz 'Amma", 'Save for Umrah', 'Pay zakat in full, on time'],
  },
  {
    key: 'family',
    name: 'Family',
    icon: 'users-round',
    hue: 22,
    blurb: 'The people who are yours.',
    visionPrompt: 'What do you want the people closest to you to remember?',
    core: true,
    habits: [weekly('Call parents'), daily('Device-free dinner'), weekly('One-on-one time')],
    metrics: [metric('Quality hours', 'h')],
    goalIdeas: ['A family tradition we keep', 'Visit relatives twice this year'],
  },
  {
    key: 'learning',
    name: 'Learning',
    icon: 'book-open',
    hue: 54,
    blurb: 'Reading, courses, new skills.',
    visionPrompt: 'What do you want to understand or be able to do?',
    core: false,
    habits: [daily('Read 20 pages'), weekly('Study session', 3)],
    metrics: [metric('Books finished'), metric('Study hours', 'h')],
    goalIdeas: ['Read 24 books this year', 'Hold a conversation in a new language'],
  },
  {
    key: 'friends',
    name: 'Friends & Community',
    icon: 'handshake',
    hue: 352,
    blurb: 'Friendships, neighbours, belonging.',
    visionPrompt: 'Who do you want to stay close to, and how do you show up?',
    core: false,
    habits: [weekly('Reach out to a friend', 2), weekly('Host or join something')],
    metrics: [metric('Catch-ups this month')],
    goalIdeas: ['A standing monthly dinner', 'Reconnect with three old friends'],
  },
  {
    key: 'home',
    name: 'Home',
    icon: 'house',
    hue: 118,
    blurb: 'The place you live and its upkeep.',
    visionPrompt: 'What should home feel like when you walk in?',
    core: false,
    habits: [weekly('Reset the house'), weekly('One maintenance job')],
    metrics: [metric('Home fund')],
    goalIdeas: ['Finish the spare room', 'Declutter every cupboard'],
  },
  {
    key: 'creativity',
    name: 'Creativity & Play',
    icon: 'palette',
    hue: 336,
    blurb: 'Making things and having fun.',
    visionPrompt: 'What do you do purely because it delights you?',
    core: false,
    habits: [weekly('Make something', 2), weekly('Play — no goal attached')],
    metrics: [metric('Hours creating', 'h')],
    goalIdeas: ['Finish one piece I am proud of', 'Learn an instrument'],
  },
  {
    key: 'giving',
    name: 'Giving & Service',
    icon: 'hand-heart',
    hue: 176,
    blurb: 'Charity, volunteering, mentoring.',
    visionPrompt: 'Who do you want to be useful to?',
    core: false,
    habits: [weekly('Give'), weekly('Serve or volunteer')],
    metrics: [metric('Given this year'), metric('Hours served', 'h')],
    goalIdeas: ['Give a set share of income', 'Mentor someone for a year'],
  },
  {
    key: 'mind',
    name: 'Mind & Emotions',
    icon: 'brain',
    hue: 266,
    blurb: 'Mental health, rest, attention.',
    visionPrompt: 'What does a calm, clear mind look like for you?',
    core: false,
    habits: [daily('Ten quiet minutes'), daily('Screens off before bed'), weekly('A real day of rest')],
    metrics: [metric('Mood', '/5'), metric('Screen time', 'h', 'down')],
    goalIdeas: ['A phone-free first hour', 'Take every day of leave'],
  },
  {
    key: 'admin',
    name: 'Life Admin',
    icon: 'folder-check',
    hue: 230,
    blurb: 'Paperwork, renewals, insurance, taxes.',
    visionPrompt: 'What would it take for the paperwork to never surprise you?',
    core: false,
    habits: [weekly('Inbox and paperwork to zero')],
    metrics: [metric('Open admin items', '', 'down')],
    goalIdeas: ['Every document findable in a minute', 'Will and beneficiaries up to date'],
  },
  {
    key: 'partner',
    name: 'Marriage & Partner',
    icon: 'heart',
    hue: 6,
    blurb: 'The one you are building a life with.',
    visionPrompt: 'What kind of partner do you want to be?',
    core: false,
    habits: [weekly('Date night'), daily('Check in properly')],
    metrics: [metric('Evenings together')],
    goalIdeas: ['A yearly trip, just us', 'Read one book together'],
  },
];

export const CATALOG_BY_KEY: Record<string, CatalogSphere> = Object.fromEntries(
  CATALOG.map((s) => [s.key, s]),
);

export const HORIZON_LABEL = {
  quarter: 'This quarter',
  year: 'This year',
  someday: 'Someday',
} as const;
