FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:alpine

COPY --chown=101:101 nginx.conf /etc/nginx/conf.d/default.conf

COPY --chown=101:101 --from=builder /app/dist /usr/share/nginx/html

ENV NODE_ENV=production

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
