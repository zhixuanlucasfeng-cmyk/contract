# One image: gateway (API + dashboard) and worker (background jobs).
FROM node:22-alpine AS dashboard
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ ./
RUN npx vite build

FROM node:22-alpine AS gateway
WORKDIR /app/gateway
COPY gateway/package*.json ./
RUN npm ci
COPY gateway/ ./
RUN npx tsc -p . && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/gateway
COPY --from=gateway /app/gateway/node_modules ./node_modules
COPY --from=gateway /app/gateway/dist ./dist
COPY --from=gateway /app/gateway/package.json ./
COPY --from=dashboard /app/dashboard/dist /app/dashboard/dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
