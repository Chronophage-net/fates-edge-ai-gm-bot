# ---------------------------------------------------------------
# Fate's Edge AI GM Bot — production image
#
# Primarily an outbound WebSocket client (connects to the socket
# server), but it also serves a small local status dashboard (see
# modules/status-server.js) on STATUS_PORT — EXPOSE it below so it's
# reachable from outside the container if you map the port; set
# STATUS_SERVER=false to disable it and skip the mapping entirely.
# ---------------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 4141

CMD ["node", "ai-gm-bot.js"]
