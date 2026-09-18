# syntax=docker/dockerfile:1
#
# Built with repo-root context (npm workspaces monorepo — auth-service has no lockfile of
# its own; the workspace root's package.json/package-lock.json is required to resolve its
# dependencies). See .github/workflows/auth-service-docker-build.yml for the build invocation.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/auth-service/package.json apps/auth-service/package.json
RUN npm ci --workspace=auth-service --include-workspace-root --ignore-scripts
COPY apps/auth-service apps/auth-service
RUN npm run build --workspace=auth-service

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/auth-service/package.json apps/auth-service/package.json
RUN npm ci --workspace=auth-service --omit=dev --include-workspace-root --ignore-scripts
COPY --from=build /app/apps/auth-service/dist ./apps/auth-service/dist
# Schema of record + the on-server provisioning script travel with the image so a deploy always
# applies the migrations/script that match this exact code (see deploy/provision-and-deploy.sh).
COPY apps/auth-service/db/migrations ./apps/auth-service/db/migrations
COPY apps/auth-service/deploy ./apps/auth-service/deploy
WORKDIR /app/apps/auth-service
EXPOSE 3000
CMD ["node", "dist/main.js"]
