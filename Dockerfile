# ---------------------------------------------------------------
# Fate's Edge AI GM Bot — production image
#
# This is an outbound WebSocket client (connects to the socket
# server; it doesn't listen on any port itself), so there's no
# EXPOSE/HEALTHCHECK against an HTTP endpoint here — just a lean
# runtime image running the bot process directly.
# ---------------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["node", "ai-gm-bot.js"]
