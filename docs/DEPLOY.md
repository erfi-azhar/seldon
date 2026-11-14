# Hosting Terminus on Railway or Render

Terminus is one Node process with a SQLite database file, so any host needs three things:
an always-on container, a persistent disk mounted at `/data`, and HTTPS. The repository's
`Dockerfile` builds the web app and runs the server; both platforms below build it straight
from GitHub and redeploy when you push.

Terminus will hold your health record, Gmail access and API keys. On a public address it
refuses to start without a passphrase, and both platforms put HTTPS in front of it.

## Before you start

- **Pick a passphrase.** Long and unique: it is the only thing between the internet and your
  data. A password manager's generator is ideal. Changing it later signs every device out.
- **Bring your data, if you have some.** In your current Terminus, Settings → Export
  everything saves a file; after deploying, Settings → Import loads it. Your health
  screenings record is imported from the Screenings page in the Health sphere.
  Exports never contain API keys, the Gmail app password or app sign-ins, so re-enter
  those in Settings on the hosted copy.

## Railway

1. At [railway.com](https://railway.com), sign in with GitHub. Volumes need a paid plan
   (Hobby or above).
2. **New Project → Deploy from GitHub repo →** `seldon`. Railway sees the `Dockerfile` and
   builds with it.
3. **Variables** on the service: add
   - `TERMINUS_PASSPHRASE` = your passphrase
   - `TZ` = `Asia/Singapore` (the zone background jobs think in; your browser's zone is
     used for "today" in the app)
4. **Add a volume**: right-click the service (or the command palette) → *Add Volume*, mount
   path `/data`. This is where `terminus.db` lives; without it every deploy starts empty.
5. **Settings → Networking → Generate Domain.** Railway gives you an
   `….up.railway.app` address with HTTPS. Keep the port it suggests (Railway passes it to
   Terminus as `PORT`).
6. **Settings → Deploy → Healthcheck Path:** `/api/auth/status`.
7. Open the domain, sign in with your passphrase and go through the first-run setup.

## Render

1. At [render.com](https://render.com), sign in with GitHub.
2. **New → Blueprint →** pick the `seldon` repository. Render reads `render.yaml`: a Docker
   web service in Singapore on the smallest paid instance, with a 1 GB disk at `/data` and
   a health check. (A disk needs a paid instance; on the free tier your data would vanish
   on every deploy.)
3. Render asks for `TERMINUS_PASSPHRASE`. Enter your passphrase, then **Apply**.
4. When the deploy finishes, open the `….onrender.com` address, sign in and set up.

## After deploying

- **Install it on your phone.** Open the address in Safari → Share → *Add to Home Screen*
  (Android: Chrome → *Install app*). On Android, Terminus then appears in the share sheet
  for sending links.
- **Connect things from the hosted address.** Brains, Gmail and Gravl are set up in
  Settings → Connections on the hosted copy. Gravl's sign-in returns you to the address you
  are using, so connect it from the domain you'll keep.
- **A custom domain** (e.g. `terminus.yourname.com`) can be added in either dashboard;
  reconnect Gravl afterwards so its sign-in remembers the new address.
- **Backups.** Settings → Export everything any time. Railway and Render can also snapshot
  the volume or disk; see each dashboard.
- **Updates.** Pushing to `main` redeploys. The server checkpoints its database on shutdown,
  so a redeploy loses nothing.

## Anywhere else with Docker

```bash
docker build -t terminus .
```

```bash
docker run -d --name terminus -p 8080:8080 -v terminus-data:/data -e TERMINUS_PASSPHRASE='your passphrase' -e TZ=Asia/Singapore terminus
```

Put an HTTPS proxy (Caddy, Tailscale Serve, a tunnel) in front of port 8080 before
reaching it from outside your machine.
