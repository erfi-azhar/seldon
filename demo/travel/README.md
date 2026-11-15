# Travel-mode demo

The real web app, showing travel mode for the demo data's Tokyo trip at six moments, with a
switcher above the bottom nav:

- **4 days out**: the countdown card on Today.
- **Flight day**: 03:50 in Singapore, 45 minutes before it's time to leave for SQ 636.
- **At airport**: 05:50, at Terminal 3 with check-in still open; tap Check in.
- **In the air**: 11:30 Singapore time, halfway to Tokyo.
- **Landed**: 16:30 at Haneda, welcomed in Japanese.
- **In Tokyo**: away mode, with the stay, today's plan and the trip to-dos.

No server is needed. The build seeds a demo database (`scripts/seed-demo.ts`, plus a few trip
to-dos from `todos.ts`), runs the real server against it with its clock set to each moment, and
records every response the app asks for on Today, both trips and the Travels sphere. In the page, a
stand-in for the server replays those responses and pins the browser clock to the chosen moment.
Ticking or adding to-dos and plan items works in memory. Anything that needs Seldon says it isn't
connected.

```bash
npm run demo:travel
```

That writes `dist/demo/travel/`; serve it with any static server (for example
`npx vite preview --outDir dist/demo/travel`).

| File | What it is |
| --- | --- |
| `main.tsx` | The entry: the app's own `App` under hash routing, and the moment switcher |
| `server.ts` | The stand-in server that replays the recording |
| `clock.ts` | Runs `Date` from the chosen moment |
| `scenarios.json` | The six moments |
| `record.mjs` | Records the real server at each moment (with `fake-now.mjs` preloaded) |
| `todos.ts` | Adds trip to-dos to the demo database |
| `build.mjs`, `vite.config.ts`, `index.html`, `demo.css` | The build |
