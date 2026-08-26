FROM node:22-alpine

# tini reaps zombies and forwards SIGTERM so the poller's graceful shutdown runs.
RUN apk add --no-cache tini

WORKDIR /app

# Install deps first so image rebuilds skip npm when only source changed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Drop privileges; the node image ships an unprivileged `node` user.
USER node

ENV NODE_ENV=production PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "start.js"]
