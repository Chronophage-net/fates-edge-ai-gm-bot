# ---------------------------------------------------------------
# Fate's Edge AI GM Bot — production image
#
# Primarily an outbound WebSocket client (connects to the socket
# server), but it also serves a small local status dashboard (see
# modules/status-server.js) on STATUS_PORT — EXPOSE it below so it's
# reachable from outside the container if you map the port; set
# STATUS_SERVER=false to disable it and skip the mapping entirely.
# ---------------------------------------------------------------
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

USER node

EXPOSE 4141

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.STATUS_PORT || '4141') + '/', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "ai-gm-bot.js"]
