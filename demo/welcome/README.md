# Welcome-stage demo

A playable version of Terminus's sign-in and onboarding scene: a dark shard hovers over a
hill under the sky, drawn as a dot matrix like the Today sky, with a traveller and their
lantern on the near slope. Typing the passphrase brightens the shard's seam; unlocking brings
the shard down to rest on the hilltop, a ring of light runs out across the ground, and the
screen washes to light. Through setup the shard stays open on the hill and the traveller
climbs up beside it. After dark, shooting stars cross now and then; tap the sky for another.

It runs the app's own engine, `web/src/components/Vault.tsx` (drawn by `web/src/hill.ts`),
with a mock of the screens around it. Type anything as the passphrase. A panel (bottom
right) jumps between scenes, switches the time of day, and replays from the start.

```bash
npm run demo:welcome
```

That writes one self-contained file, `dist/demo/welcome.html`, which opens in any browser
with no server.

| File | What it is |
| --- | --- |
| `entry.ts` | The mock screens and controls, driving the engine through `mountVault`, `setVaultScene`, `setVaultAnchor`, `setVaultSun`, `pulseVault` and `playUnlock` |
| `template.html` | The page: screens, panel, and the light and dark page colours and the unlock's `--vault-flash` |
| `build.mjs` | Bundles `entry.ts` with rolldown and inlines it into the template |
