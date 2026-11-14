# Terminus

A place to steward your whole life on purpose — Health, Finances, Work, Side Projects,
Travels, Faith, Family, and whatever else matters — with a personal agent, **Seldon**,
that lives in it.

It runs on your own machine. Everything you put in is stored in one SQLite file you own.
Seldon's brain is yours to choose and swap: Claude or OpenAI through your own API key, or
a local model through Ollama or LM Studio. Nothing here depends on a vendor staying good.

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

Then open <http://localhost:4321>. The first run walks you through naming your agent,
choosing your spheres and (optionally) connecting a brain.

To look around with believable sample data first, without touching your own:

```bash
npm run seed:demo
```

```bash
TERMINUS_DB=data/demo.db npm start
```

## What's in it

**Spheres.** An area of life, drawn as an orb in its own colour, with a short vision of
what thriving there looks like. The ring around each orb is its *pulse*: how alive it has
been this week, from habit check-ins and recent activity. Spheres you haven't touched in a
week are flagged as quiet, so neglect is visible instead of silent. Seven are offered by
default and eight more are a tap away (Learning, Friends & Community, Home, Creativity &
Play, Giving & Service, Mind & Emotions, Life Admin, Marriage & Partner) — or make your own.

**Goals, habits, numbers, tasks, journal, library.** Goals whose progress comes from their
steps, from a number you track, or from a slider. Daily or few-times-a-week habits with
seven-day dots and fair streaks. Any metric over time with a sparkline. To-dos, one
journal entry a day that saves as you type, and notes and links filed by sphere.

**Today.** One screen for the day: what needs you (important mail, new job openings,
flights), what's due, habits still open, the journal, what's on the horizon, and a feed of
what changed — including what Seldon did, each with Undo. Your next prayer and your next
flight sit at the top.

**Needs you.** Things from outside that may need you arrive as *signals*, each with
suggested next steps — save a reply as a Gmail draft, add a task, open the posting.

### Health

- **Food.** Calories and macros against daily targets, as rings. Type "nasi lemak and teh
  tarik" or send a photo of the plate, and Seldon estimates the items (Singapore portions
  for local dishes); or add the numbers yourself.
- **Training.** Strength sessions with exercises and sets, runs, rides, swims, classes —
  with this week's sessions and minutes.
- **Body composition.** Weight, body fat, skeletal muscle, visceral fat, body water and BMR,
  typed in or read from a photo of an InBody sheet or a smart-scale app. Weight also feeds
  your Weight metric and any goal it drives.
- **Health screenings.** Import a check-up record (JSON) and see two visits side by side —
  what's in range, what moved, scans, risk outlook and an action plan whose items become
  tasks. Your record lives only in your database; none ships with the code.
- **Apps, through MCP.** Connect Gravl (workouts, and food, weight and measurements with
  Gravl Macros) under Settings → Connections; Terminus signs in with OAuth and syncs every
  three hours. Any other MCP server can be added by URL. See [Health apps](#health-apps).

### Faith, for a Muslim

- **Prayer times where you are**, calculated on your device (no lookups) with the method
  and madhab you choose — MUIS for Singapore by default there, Umm al-Qura, MWL, ISNA and
  others — with per-prayer minute adjustments.
- **A prayer log.** Mark each prayer on time, late or missed. Missed prayers join a count of
  qada still to make up; log make-ups as you go, and set a starting backlog if you have one.
- **Ramadan countdown** once it is 100 days away (estimated from the Umm al-Qura calendar;
  the real start depends on the local moon sighting), with the Hijri date throughout.
- A starter kit of Quran reading, adhkar, Monday and Thursday fasts, Jumu'ah and sadaqah.

### Travels

- **Trips for work or leisure**, with their flights and hotel stays (local times at each
  end, airports resolved to cities and time zones) and a day-by-day plan you can edit and
  tick off. Work trips also show in the Work sphere.
- **KrisFlyer and Marriott Bonvoy standing** — tier, miles or points, progress to the next
  tier, expiry — as wallet cards, plus Priority Pass or any other programme.
- **Bookings find their own way in.** Singapore Airlines and Marriott have no API for
  members, so Terminus reads what already reaches you: with Gmail connected, confirmation
  and statement emails are read for flights, stays and balances, filed onto the right trip
  (making one when needed), and merged when a check-in email repeats a booking. You can
  also paste a confirmation or send a screenshot — a boarding pass, or the KrisFlyer or
  Bonvoy app.
- **Travel mode.** When a trip is near, Seldon gets ahead of it. A week out it drafts a plan
  for the destination (halal food, Jumu'ah on Fridays, fitted around your flights). The day
  before a flight, Today becomes a small app for that moment: the route and countdown, the
  lounge your cabin and status get you into (KrisFlyer tier, Star Alliance Gold, Priority
  Pass), the layover and what to do with it, and where the prayer room is. While away it
  shows the day of the trip, your hotel and its Bonvoy perks, and today's plan.

### Work

- **Job alerts.** Name the companies you would join — by careers page, a job link, or just
  the name — and what fits (titles, places, remote). Terminus finds the Greenhouse, Lever,
  Ashby, Workable or SmartRecruiters board behind them and reads its public API every six
  hours. The first look records what's already open; after that, each new role that fits
  becomes a signal. Roles that disappear are closed.

### Capture anything

Send Terminus a link — a tweet, a TikTok, a YouTube video, an article, a PDF — or a
picture, and Seldon reads it and files it: a title, a short summary and key points, tags,
a sphere and a collection, and a task when there's something to do. From the Library's
capture bar, the share sheet of the installed app on Android, or an iPhone/Mac Shortcut
with a capture token (Settings → Connections shows the exact steps).

### Gmail

Connect Gmail with an app password and Terminus checks for new mail every ten minutes. Your
background brain judges what matters — with no tools, and with the mail marked as untrusted
— and what does becomes a signal with a one-line summary and a suggested follow-up: a reply
you can save as a draft in Gmail, or a task. Nothing is ever sent for you.

1. Turn on 2-Step Verification for your Google account (`myaccount.google.com/security`).
2. Create an app password at `myaccount.google.com/apppasswords`, named "Terminus".
3. In Settings → Connections → Gmail, enter your address and the 16 letters.

The server needs outbound access to `imap.gmail.com` on port 993. With no brain connected,
Gmail's own Important label decides what surfaces. An app password was chosen over
Google's OAuth because personal OAuth apps in testing mode lose access every seven days.

## Two brains: Claude and OpenAI

Terminus can hold several model connections and give each a job: **Chat** answers you in
conversations; **Background** does the quiet work — mail triage, reading saved links,
syncing apps, drafting trip plans. Any conversation can switch brains from the agent
panel's header. Settings → Brains has this guide too.

1. **API keys are separate from subscriptions.** ChatGPT Plus/Pro and Claude Pro/Max do not
   include API access; the API is its own pay-as-you-go account.
2. **Claude:** at `console.anthropic.com`, add credit under Billing, then Settings → API
   keys → Create key. In Terminus: Add a brain → Anthropic → paste → Connect. It uses
   `claude-opus-5-5` by default; you can pick another model and the thinking effort.
3. **OpenAI:** at `platform.openai.com`, add credit under Billing, then API keys → Create
   new secret key. In Terminus: Add a brain → OpenAI → paste → Connect, and choose a model
   that supports tool calling so Seldon can act, not just talk.
4. **Give each a job** — a common split is the stronger model for Chat and the cheaper one
   for Background.
5. **Keep spend in check** with a monthly limit in each console. Keys stay in your Terminus
   database: never sent to the browser, never included in exports.

Want nothing to leave your machine? Add Ollama or LM Studio as a brain and give it both jobs.

## Health apps

| App | Status |
| --- | --- |
| **Gravl** | Official MCP server (`https://mcp.gravl.ai/mcp`). Connect it under Settings → Connections; the sync brings workouts and, with Gravl Macros, food, weight and measurements into Health. |
| **Bevel** | No public MCP server or API yet. Log body readings by photo or by hand; add Bevel by URL under Connections if they publish one. |
| **MacroFactor** | No official API. Community MCP servers exist that sign in with your account; Terminus can connect to any MCP server by URL, but read such code before trusting it with your login. |

Connected MCP servers are read-only by default. Tools a server marks as destructive (or
named like `delete_*`) are never offered to Seldon.

## Seldon, concretely

- **It works through the same rules you do.** Every tool is a validated wrapper over the
  data layer the app itself uses. There are 40, from logging a habit to adding a flight to
  a trip, plus the read tools of any MCP server you connect.
- **It cannot delete.** It can add, log, update and complete. What it adds or logs — tasks,
  goals, habits, check-ins, numbers, notes, food, workouts, trips — is attributed to it in
  the activity feed and can be undone with one tap. Journal writes can't be undone that
  way, so it only writes in the journal when you ask.
- **Outside content is information, not instructions.** Emails, saved pages and MCP output
  reach the model wrapped as untrusted, and the background jobs that read them have no
  tools at all.
- **Its memory is yours to read.** Facts it keeps are listed in Settings → Memory.
- **Any model.** Two adapters cover the field: Anthropic's Messages API (official SDK), and
  the OpenAI chat-completions dialect that Ollama, LM Studio, llama.cpp, vLLM, OpenRouter
  and OpenAI all speak. Local models need tool calling to act.
- **What leaves your machine.** With a local model: nothing but what your connections fetch.
  With a hosted model: the conversation and a snapshot of your spheres, goals, tasks,
  habits, latest numbers, prayers, trips and signals go to that provider and nowhere else.

## How it's built

```
shared/     Types and the sphere catalog, used by both sides
server/     Node + Hono. No build step: Node runs the TypeScript directly
  db.ts         SQLite schema and migrations (node:sqlite — no native modules)
  store.ts      The core data layer. Every read and write, from the API or the agent
  app.ts        HTTP API, sign-in, cross-site protections
  jobs.ts       The background scheduler (mail, job alerts, app sync, travel prep)
  agent/        The loop, the tools, the prompt, and the two provider adapters
  features/     Signals, Gmail, Faith, Capture, Health, MCP, Gravl, Travel, Job alerts —
                each registers its own tables, routes, tools, jobs and snapshot section
web/        React + Vite single-page app, installable as a PWA
scripts/    seed-demo.ts
```

- **One process, one file.** `npm start` serves the API and the built web app from one port
  and keeps everything in `data/terminus.db`. The server folds its write-ahead log into that
  file every few minutes and on shutdown; for a backup, use Settings → Export, or copy the
  file while Terminus is stopped.
- **The server owns the data; clients are thin.** Your laptop's browser and your phone's
  installed app both talk to the same server, so there is no sync engine to go wrong.
- **Conversations are append-only.** The system prompt is written once per conversation;
  anything that changes travels inside user messages. This keeps prompt caches warm, and
  Anthropic's current models require it to accept their own earlier reasoning back.
- **Fetching is guarded.** Links you capture are fetched only from public addresses (checked
  on the actual connection and on every redirect), with size and time limits.

## Configuration

Set these in the environment before `npm start`.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `4321` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to bind. Anything other than loopback requires one of the next two |
| `TERMINUS_PASSPHRASE` | — | Require signing in with this passphrase. Changing it signs everyone out |
| `TERMINUS_ALLOWED_HOSTS` | — | Comma-separated hostnames the app may be reached at without a passphrase (for a private network such as a tailnet) |
| `TERMINUS_DB` | `data/terminus.db` | Where the database lives |
| `ANTHROPIC_API_KEY` | — | Used for Anthropic if no key is saved in Settings |

The older `LIFEOS_*` names still work, and an existing `data/lifeos.db` keeps being used.

Connections need outbound network access: `imap.gmail.com:993` for Gmail; the job boards'
APIs (`boards-api.greenhouse.io`, `api.lever.co`, `api.ashbyhq.com`, `apply.workable.com`,
`api.smartrecruiters.com`); any MCP servers you add; and whatever links you capture.

### Hosting it

To reach Terminus from anywhere, deploy it to Railway or Render: the repository has a
`Dockerfile` and a Render Blueprint (`render.yaml`), and [docs/DEPLOY.md](docs/DEPLOY.md)
walks through both, step by step — passphrase, persistent disk, HTTPS, moving your data.

### Using it from your phone on your own network

By default Terminus only answers on the machine it runs on. To reach it from another
device, bind it to the network and protect it:

```bash
HOST=0.0.0.0 TERMINUS_PASSPHRASE='something long' npm start
```

Browsers only allow installing an app (and the share target) over HTTPS, so put it behind
something that provides that — Tailscale Serve, Caddy, or a reverse proxy you trust. MCP
sign-in sends you back to the address you reached Terminus at, so connect apps from that
same address. Don't expose Terminus to the open internet without both HTTPS and a
passphrase.

## Security model

- Local-only by default; the server refuses to start on a public address unprotected.
- With a passphrase: an HttpOnly, SameSite session cookie whose hash is all that's stored;
  wrong attempts are throttled; changing the passphrase ends every session.
- Other websites can't act on your Terminus through your browser: state-changing requests
  from another origin are rejected, and without a passphrase the server only answers to
  hostnames you've allowed (which blocks DNS rebinding).
- Secrets (API keys, the Gmail app password, MCP tokens) are never sent to the browser or
  included in exports. The capture token is stored hashed and can only save things.
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

The tests cover the data layer, the HTTP API (sign-in and cross-site protections
included), the agent end to end against stand-in model servers that speak the real
Anthropic and OpenAI streaming formats, and every feature against fakes: a mailbox, job
boards, an MCP server with its OAuth server, and model replies for triage and extraction.

## Where this goes next

- *Rhythms.* A morning letter and an evening check-in Seldon writes on its own schedule; a
  guided weekly review that ends with next week's three priorities.
- *Calendar*, so the day's plan and travel mode reflect the day's meetings.
- *Notifications* for prayers, flights and new signals, through the installed app.
- *Finances and Family tools:* accounts and budgets; people and important dates.
- *Native shells* (Capacitor, Tauri) wrapping this same web app, for widgets and
  lock-screen capture.
