# Terminus

A place to steward your whole life on purpose — Health, Finances, Work, Side Projects,
Travels, Faith, Family, and whatever else matters — with a personal agent that lives in it.

It runs on your own machine. Everything you put in is stored in one SQLite file you own.
The agent's model is yours to choose and swap: a local one through Ollama or LM Studio, or
a hosted one through your own API key. Nothing here depends on a vendor staying good.

![Today](docs/screenshots/today.png)

## Run it

You need Node 22.18 or newer. Nothing else — no database to install, no build tools.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Then open <http://localhost:4321>. First run walks you through naming your agent, choosing
your spheres and (optionally) connecting a model.

To look around with believable sample data first, without touching your own:

```bash
npm run seed:demo
```

```bash
TERMINUS_DB=data/demo.db npm start
```

## What's in this version

**Spheres.** An area of life, drawn as an orb in its own colour, with a short vision of what
thriving there looks like. The ring around each orb is its *pulse*: how alive it has been
this week, from habit check-ins and recent activity. Spheres you haven't touched in a week
are flagged as quiet, so neglect is visible instead of silent. Seven are offered by default
and eight more are a tap away (Learning, Friends & Community, Home, Creativity & Play,
Giving & Service, Mind & Emotions, Life Admin, Marriage & Partner) — or make your own.

**Goals.** An outcome inside a sphere. Progress comes from the steps you tick off, from a
number you track (reach 76 kg, save 24,000), or from a slider when neither fits.

**Habits.** Daily, or a few times a week. Seven-day dots you can tap to fix yesterday,
streaks that don't break just because today isn't over yet.

**Numbers.** Any metric over time, with a sparkline and one-field logging. Each knows
whether up or down is the good direction.

**Health screenings.** Inside the Health sphere: import a check-up record (JSON) and see
two visits side by side — what's in range, what moved, scans, risk outlook, every result
against its healthy range, and an action plan whose items become tasks with one tap. The
agent can read it too. Your record lives only in your database; none ships with the code.

**Faith, for a Muslim.** The Faith sphere's starter kit is the five daily prayers, Quran
reading, adhkar, Monday and Thursday fasts, Jumu'ah and sadaqah, with Quran pages (a khatm
is 604), sadaqah and memorisation as numbers to track.

**Tasks, journal, library.** One-off to-dos with optional due dates; one journal entry per
day that saves as you type; notes and links filed by sphere.

**Today.** One screen for the day: what's due, habits still open, the journal, what's on
the horizon, and a feed of what changed — including what the agent did, each with Undo.

**The agent.** Opens beside whatever you're looking at (`⌘J`). Tell it things in passing —
"ran 5k, weighed 78.6, remind me to book the dentist" — and it logs the habit, records the
number and adds the task, then says what it did. Ask it to plan the day, run a weekly
review, or tell you what you're neglecting, and it reads your actual data to answer.

**Command palette.** `⌘K` to jump anywhere, search everything, add a task, or hand a
sentence to the agent.

**App and site.** The same thing serves both: open it in a browser, or install it
(*Install app* in Chrome/Edge, *Add to Home Screen* on iOS) for a standalone window and
home-screen icon. Light and dark themes; phone layout with a tab bar.

## The agent, concretely

- **It works through the same rules you do.** Every tool is a validated wrapper over the
  data layer the app itself uses (`server/src/agent/tools.ts`). There are 21: read the
  overview or one sphere; create and update goals, steps, tasks, habits, metrics; log
  check-ins and numbers; read and append to the journal; save notes; search; remember.
- **It cannot delete.** It can add, log, update and complete. Everything it creates or logs
  is attributed to it in the activity feed and can be undone with one tap.
- **Its memory is yours to read.** Facts it chooses to keep are listed in Settings → Memory,
  where you can remove or add to them.
- **Any model.** Two adapters cover the field: Anthropic's Messages API (official SDK), and
  the OpenAI chat-completions dialect, which is what Ollama, LM Studio, llama.cpp, vLLM,
  OpenRouter and OpenAI all speak. For local models, pick one that supports tool calling —
  without it the agent can talk but not act.
- **What leaves your machine.** With a local model: nothing. With a hosted model: the
  conversation, plus a snapshot of your spheres, goals, tasks, habits and latest numbers at
  the start of each conversation, goes to that provider and nowhere else. API keys are
  stored in your database file and are never sent to the browser or included in exports.

## How it's built

```
shared/     Types and the sphere catalog, used by both sides
server/     Node + Hono. No build step: Node runs the TypeScript directly
  db.ts         SQLite schema and migrations (node:sqlite — no native modules)
  store.ts      The data layer. Every read and write, from the API or the agent
  app.ts        HTTP API, sign-in, cross-site protections
  agent/        The loop, the tools, the prompt, and the two provider adapters
web/        React + Vite single-page app, installable as a PWA
scripts/    seed-demo.ts
```

A few decisions worth knowing about:

- **One process, one file.** `npm start` serves the API and the built web app from one
  port and keeps everything in `data/terminus.db`. Backing up is copying that file.
- **The server owns the data; clients are thin.** Your laptop's browser and your phone's
  installed app both talk to the same server, so there is no sync engine to go wrong, and
  a native client later would reuse the whole API.
- **Conversations are append-only.** The system prompt is written once per conversation
  and stored with it; anything that changes (the date, your data, what you're looking at)
  travels inside user messages. This keeps provider prompt caches and local models' KV
  caches warm, and Anthropic's current models require it to accept their own earlier
  reasoning back.
- **The agent loop is provider-neutral** (`server/src/agent/types.ts`). Adding another
  provider is one file that translates to and from that format.

## Configuration

Set these in the environment before `npm start`.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `4321` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to bind. Anything other than loopback requires one of the next two |
| `TERMINUS_PASSPHRASE` | — | Require signing in with this passphrase |
| `TERMINUS_ALLOWED_HOSTS` | — | Comma-separated hostnames the app may be reached at without a passphrase (for a private network such as a tailnet) |
| `TERMINUS_DB` | `data/terminus.db` | Where the database lives |

The older `LIFEOS_*` names still work, and an existing `data/lifeos.db` keeps being used.
| `ANTHROPIC_API_KEY` | — | Used for Anthropic if no key is saved in Settings |

### Using it from your phone

By default Terminus only answers on the machine it runs on. To reach it from another device,
bind it to the network and protect it:

```bash
HOST=0.0.0.0 TERMINUS_PASSPHRASE='something long' npm start
```

Browsers only allow installing an app (and running its offline shell) over HTTPS, so put
it behind something that provides that — Tailscale Serve, Caddy, or any reverse proxy you
already trust. Don't expose it to the open internet without both HTTPS and a passphrase.

## Security model

- Local-only by default, and the server refuses to start on a public address unprotected.
- With a passphrase: an HttpOnly, SameSite session cookie; only its hash is stored;
  repeated wrong attempts are throttled.
- Other websites can't act on your Terminus through your browser: state-changing requests
  from another origin are rejected, and without a passphrase the server only answers to
  hostnames you've allowed (which blocks DNS rebinding).
- Model output is rendered as sanitised Markdown; tool inputs are schema-validated before
  anything runs.
- The database file is not encrypted at rest. Use full-disk encryption on the machine.

## Develop

```bash
npm run dev
```

Runs the server (restarting on change) and Vite with hot reload at <http://localhost:5173>.

```bash
npm test
```

```bash
npm run typecheck
```

The tests cover the data layer, the HTTP API (including sign-in and cross-site
protections), and the agent end to end against stand-in model servers that speak the real
Anthropic and OpenAI streaming formats.

## Where this goes next

This is a first version: the foundation plus the everyday loop. Roughly in order:

**Next**
- *Rhythms.* A morning letter and an evening check-in the agent writes on its own
  schedule; a guided weekly review that ends with next week's three priorities.
- *Nudges.* Notifications for what matters today, and a "waiting" shelf that suggests
  letting go of tasks that have sat for weeks.
- *Quests.* Longer jobs the agent runs unattended (plan the Japan trip, research index
  funds) and reports back on.
- *Capture from anywhere.* Share-sheet target, voice notes, a browser extension, email-in.
- *Semantic search* over notes and journal, using a local embedding model.

**Later**
- *Sphere-native tools.* Accounts and budgets for Finances; trips and itineraries for
  Travels; people and important dates for Family; prayer times and reading plans for
  Faith; workouts and health-app import for Health.
- *Connections.* Calendar and email, so the day's plan reflects the day's meetings and
  commitments made in mail get caught.
- *Native shells.* Capacitor for iOS/Android and Tauri for desktop, wrapping this same web
  app, for widgets, lock-screen capture and background nudges.
- *Shared spheres.* A Family or Finances sphere that two people tend together.
- *Encrypted backup* to a place you choose, and a Docker image for one-line hosting.
