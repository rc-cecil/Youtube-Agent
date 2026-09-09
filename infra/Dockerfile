FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ffmpeg chromium fonts-liberation && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig*.json ./
RUN npm ci && npm run db:generate && npm run build

FROM nginx:1.28-alpine AS web
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

FROM build AS runtime
RUN mkdir -p /app/.data/storage && chown -R node:node /app/.data
USER node
ENV NODE_ENV=production
ENV REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium
CMD ["npm", "run", "start:api"]
