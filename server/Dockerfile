FROM rust:1.91.1-alpine3.22 AS scanner-builder
WORKDIR /build

COPY native/scanner/Cargo.toml native/scanner/Cargo.lock ./
COPY native/scanner/src ./src
RUN cargo build --release --locked

FROM node:22-alpine3.22 AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine3.22
WORKDIR /app

ENV NODE_ENV=production \
    SCANNER_ENGINE=rust \
    RUST_SCANNER_BIN=/app/bin/tunecloud-scanner \
    RUST_SCANNER_WORKERS=4

RUN apk add --no-cache tini && mkdir -p /app/covers && chown -R node:node /app

USER node

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=scanner-builder /build/target/release/tunecloud-scanner ./bin/tunecloud-scanner
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

EXPOSE 4000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
