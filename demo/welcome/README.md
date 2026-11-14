# Welcome-stage demo

A playable version of Terminus's sign-in and onboarding animation: a monochrome shard of
particles with holographic light turns slowly; unlocking sinks it and opens it on a core
of light; from the spheres step on, the particles gather into an older man's head and
shoulders, turned three-quarters toward you. The shard and the face are original designs.

It runs the app's own engine, `web/src/components/Vault.tsx`, with a mock of the screens
around it. Type anything as the passphrase. A panel (bottom right) jumps between scenes,
switches between Dusk and Daylight, and replays from the start.

```bash
npm run demo:welcome
```

That writes one self-contained file, `dist/demo/welcome.html`, which opens in any browser
with no server.

| File | What it is |
| --- | --- |
| `entry.ts` | The mock screens and controls, driving the engine through `mountVault`, `setVaultScene`, `setVaultAnchor` and `playUnlock` |
| `template.html` | The page: screens, panel, and the Dusk and Daylight palettes (the same `--vault-*` tokens the app uses) |
| `build.mjs` | Bundles `entry.ts` with rolldown and inlines it into the template |
