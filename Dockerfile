# Single image for the API (serves the web app too) and the monitoring worker.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# Downloads retried on slow or unsteady connections; npm itself sometimes stops mid-way ("Exit handler
# never called"), so the install is tried up to three times.
ENV npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=20000 npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_maxsockets=6 npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
RUN npm ci || (sleep 10 && npm ci) || (sleep 30 && npm ci)
COPY . .
RUN npm run build && npm prune --omit=dev && mkdir -p server/node_modules

FROM node:22-alpine
ENV NODE_ENV=production PORT=4000 WEB_DIST_DIR=/app/web/dist
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/migrations ./server/migrations
COPY --from=build /app/web/dist ./web/dist
WORKDIR /app/server
# Holds the generated credential encryption key; mounted as a volume so it survives rebuilds.
RUN mkdir -p /app/server/data && chown node:node /app/server/data
# The camera Ping button: iputils ping sends ICMP without root (Docker allows ICMP sockets by default).
RUN apk add --no-cache iputils-ping
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "dist/index.js"]
