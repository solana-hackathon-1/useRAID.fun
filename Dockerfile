FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y openssl --no-install-recommends && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY .npmrc ./
COPY prisma ./prisma
COPY vendor ./vendor
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build
RUN npm prune --omit=dev && npx prisma generate

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y openssl --no-install-recommends && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.json /app/next.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
RUN chown -R node:node /app/.next
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
