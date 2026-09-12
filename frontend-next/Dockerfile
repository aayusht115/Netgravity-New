FROM node:22-alpine AS deps
WORKDIR /workspace/frontend-next
COPY frontend-next/package.json frontend-next/package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /workspace/frontend-next
COPY --from=deps /workspace/frontend-next/node_modules ./node_modules
COPY frontend-next ./
COPY app/frontend /workspace/app/frontend
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /workspace/frontend-next/public ./public
COPY --from=builder --chown=nextjs:nodejs /workspace/frontend-next/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /workspace/frontend-next/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
