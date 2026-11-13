FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache tini && mkdir -p /app/covers && chown -R node:node /app

USER node

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

EXPOSE 4000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]