# Terminus in one container: the API, the built web app and background jobs on one port,
# with the database on a mounted disk at /data. Works on Railway, Render or any Docker host.

# ── Build the web app (needs the dev dependencies: Vite, React, fonts) ───────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Run: production dependencies, the server source (Node runs it directly) and the build ─
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    TERMINUS_DB=/data/terminus.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/src ./server/src
COPY shared ./shared
COPY --from=build /app/dist ./dist
# Railway volumes and Render disks are mounted owned by root, so the server runs as root
# inside the container to be able to write its database there.
RUN mkdir -p /data
EXPOSE 8080
# The server refuses to listen publicly without TERMINUS_PASSPHRASE (or TERMINUS_ALLOWED_HOSTS).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.ts"]
