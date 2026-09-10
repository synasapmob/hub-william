FROM node:26-bookworm-slim AS builder

WORKDIR /app
RUN npm install --global pnpm@11.10.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/frontend/package.json ./apps/frontend/package.json
RUN pnpm install --frozen-lockfile
COPY contributors ./contributors
COPY apps/frontend ./apps/frontend
ENV VITE_API_BASE_URL=/api
ENV VITE_BASE_PATH=/
RUN pnpm --dir apps/frontend build

FROM nginx:1.29-alpine

ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1

COPY infra/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /app/apps/frontend/build/client /usr/share/nginx/html

EXPOSE 80
