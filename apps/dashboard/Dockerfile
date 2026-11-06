FROM node:26-bookworm-slim AS builder

WORKDIR /app
RUN npm install --global pnpm@11.10.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
RUN pnpm install --frozen-lockfile
COPY apps/dashboard ./apps/dashboard
ENV VITE_API_BASE_URL=/api
RUN pnpm --dir apps/dashboard build

FROM nginx:1.29-alpine

ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1

COPY infra/nginx/dashboard.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /app/apps/dashboard/build/client /usr/share/nginx/html

EXPOSE 80
