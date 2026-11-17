// The game plan and the one-day reset, after the "fix your life in a day" idea: get honest about
// what you've been tolerating, picture the life you refuse and the one you want, then turn it into
// a mission, a month's project, daily quests and the rules you won't break.
// The prompts are written for Terminus, in its own words.

export interface ResetQuestion {
  id: string;
  text: string;
}

export interface ResetSection {
  id: 'pain' | 'stakes' | 'vision' | 'synthesis';
  title: string;
  when: string;
  intro: string;
  questions: ResetQuestion[];
}

export const RESET_SECTIONS: ResetSection[] = [
  {
    id: 'pain',
    title: 'What you tolerate',
    when: 'Morning',
    intro: 'Answer in your own words, by hand if you can. Seldon will not answer these for you.',
    questions: [
      { id: 'tolerate', text: 'What quiet dissatisfaction have you got so used to that you barely notice it now?' },
      { id: 'complaints', text: 'Which three complaints have you repeated most this year without doing anything about them?' },
      { id: 'revealed', text: 'For each one, look only at what you actually do: what does that say you really want?' },
      { id: 'admit', text: 'What is true about your life right now that you would struggle to say out loud to someone you deeply respect?' },
    ],
  },
  {
    id: 'stakes',
    title: 'The life you refuse',
    when: 'Morning',
    intro: 'Make the cost of staying the same vivid. This becomes your anti-vision: what is at stake.',
    questions: [
      { id: 'five_years', text: 'Suppose nothing changes for five years. Describe an ordinary weekday then, from the moment you wake to the moment you sleep.' },
      { id: 'ten_years', text: 'Push it to ten years. What chances have gone, who has stopped relying on you, and what do people say about you?' },
      { id: 'safe_life', text: 'Picture the end of a life spent playing it safe. What was the price, and what did you never allow yourself?' },
      { id: 'ahead', text: 'Who is already living that future, a few years ahead of you on the same path? How does it feel to picture becoming them?' },
      { id: 'identity_old', text: 'Which "I am the kind of person who…" would you have to give up to change, and what would it cost you socially?' },
      { id: 'real_reason', text: 'Say the reason you have not changed that you would least like anyone to hear.' },
      { id: 'protecting', text: 'What are your habits keeping you safe from, and what price are you paying for that safety?' },
    ],
  },
  {
    id: 'vision',
    title: 'The life you want',
    when: 'Morning',
    intro: 'A first version only. It will sharpen as you live toward it.',
    questions: [
      { id: 'three_years', text: 'Three years on, with realism set aside: describe an ordinary weekday in the life you actually want.' },
      { id: 'identity_new', text: 'What would you need to believe about yourself for that life to feel natural? Finish the sentence "I am the kind of person who…"' },
      { id: 'this_week', text: 'Name one thing that person would do this week, and that you could do too.' },
    ],
  },
  {
    id: 'synthesis',
    title: 'Pull it together',
    when: 'Evening',
    intro: 'Your answers here become the game plan.',
    questions: [
      { id: 'why_stuck', text: 'Looking back over today, why have you really been stuck?' },
      { id: 'enemy', text: 'Name the real opponent: the pattern or belief inside you, not people or circumstances.' },
      { id: 'anti_vision', text: 'In one sentence: the life you refuse to end up in.' },
      { id: 'vision_mvp', text: 'In one sentence: what you are building toward, for now.' },
      { id: 'one_year', text: 'A year from now, what single concrete fact would prove the old pattern is broken? This is your mission.' },
      { id: 'one_month', text: 'Within a month, what do you need to have learned, built or finished to keep that year on track? This is your project.' },
      { id: 'tomorrow', text: 'Two or three things to put in your calendar for tomorrow that the person you are becoming would just do. These are your first quests.' },
      { id: 'rules', text: 'What will you not trade away to get there? These are your rules.' },
    ],
  },
];

/** Through the day: a question at set times to break autopilot. */
export interface DayPrompt {
  id: string;
  /** Local time, HH:MM. */
  at: string;
  text: string;
  /** Also sent on ordinary days when daily prompts are on. */
  daily?: boolean;
}

export const DAY_PROMPTS: DayPrompt[] = [
  { id: 'avoiding', at: '11:00', text: 'Is what I am doing right now a way of not doing something else? What?' },
  { id: 'filmed', at: '13:30', text: 'Watching my last two hours on video, what would a stranger guess I care about?', daily: true },
  { id: 'toward', at: '15:15', text: 'Which way did the last few hours point: the life I am building, or the one I refuse?' },
  { id: 'pretending', at: '17:00', text: 'What important thing am I treating as if it can wait?' },
  { id: 'image', at: '19:30', text: 'What did I do today to keep up how I am seen, rather than because I chose it?' },
  { id: 'alive', at: '21:00', text: 'Which moment today had the most life in it, and which had the least?', daily: true },
];

/** For a walk or a commute on reset day. */
export const WALK_PROMPTS: string[] = [
  'If nobody needed me to stay who I have been, what would I do differently?',
  'Where am I picking comfortable and predictable over what actually moves me?',
  'What is a small, real step tomorrow that the person I am becoming would take without thinking?',
];

/** Sunday evening: the steering check. Act, sense, compare, correct. */
export const WEEKLY_STEER: DayPrompt = { id: 'steer', at: '20:00', text: 'This week, did your days move you toward the vision or toward the anti-vision? What will you change next week?' };

/** Which synthesis answer fills which part of the game plan. */
export const SYNTHESIS_TO_PLAN = {
  anti_vision: 'antiVision',
  vision_mvp: 'vision',
  enemy: 'enemy',
  one_year: 'mission',
  one_month: 'project',
  rules: 'rules',
  identity_new: 'identity',
} as const;
