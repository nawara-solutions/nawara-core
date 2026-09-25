# syntax=docker/dockerfile:1
#
# Built with repo-root context (npm workspaces monorepo — auth-service has no lockfile of
# its own; the workspace root's package.json/package-lock.json is required to resolve its
# dependencies, including the shared @nawara/service-kit package since Stage 13.2).
# See .github/workflows/auth-service-docker-build.yml for the build invocation.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/package.json
COPY libs/audit-contract/package.json libs/audit-contract/package.json
COPY apps/auth-service/package.json apps/auth-service/package.json
RUN npm ci --workspace=auth-service --workspace=@nawara/service-kit --workspace=@nawara/audit-contract --include-workspace-root --ignore-scripts
COPY libs/service-kit libs/service-kit
RUN npm run build -w @nawara/service-kit
COPY libs/audit-contract libs/audit-contract
RUN npm run build -w @nawara/audit-contract
COPY apps/auth-service apps/auth-service
RUN npm run build --workspace=auth-service

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/package.json
COPY libs/audit-contract/package.json libs/audit-contract/package.json
COPY apps/auth-service/package.json apps/auth-service/package.json
RUN npm ci --workspace=auth-service --workspace=@nawara/service-kit --workspace=@nawara/audit-contract --omit=dev --include-workspace-root --ignore-scripts
COPY --from=build /app/libs/service-kit/dist ./libs/service-kit/dist
COPY --from=build /app/libs/audit-contract/dist ./libs/audit-contract/dist
COPY --from=build /app/apps/auth-service/dist ./apps/auth-service/dist
# Schema of record + the on-server provisioning script travel with the image so a deploy always
# applies the migrations/script that match this exact code (see deploy/provision-and-deploy.sh).
COPY apps/auth-service/db/migrations ./apps/auth-service/db/migrations
COPY apps/auth-service/deploy ./apps/auth-service/deploy
WORKDIR /app/apps/auth-service
# The service only reads its own files and opens sockets: it needs no write access and no privileges (the base image's `node` user).
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
