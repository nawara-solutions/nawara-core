# syntax=docker/dockerfile:1
#
# Built with repo-root context (npm workspaces monorepo: audit-service has no lockfile of its own; the workspace root's
# package.json/package-lock.json is required to resolve its dependencies, including the shared @nawara/service-kit package and, from
# Stage 18.4, the shared @nawara/audit-contract package: both are built here and only their dist travels to the runtime image).
# The File / Notification image pattern. The migrations (the kit's and, from Stage 18.3, the service's own) travel with the image;
# they are applied by the explicit `npm run migrate` step as the migrator role, never at startup and never with the runtime credentials.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/package.json
COPY libs/audit-contract/package.json libs/audit-contract/package.json
COPY apps/audit-service/package.json apps/audit-service/package.json
RUN npm ci --workspace=audit-service --workspace=@nawara/service-kit --workspace=@nawara/audit-contract --include-workspace-root --ignore-scripts
COPY libs/service-kit libs/service-kit
RUN npm run build -w @nawara/service-kit
COPY libs/audit-contract libs/audit-contract
RUN npm run build -w @nawara/audit-contract
COPY apps/audit-service apps/audit-service
RUN npm run build --workspace=audit-service

FROM node:22-alpine AS runtime
WORKDIR /app
# Production is the default; configuration comes from the environment at run time (nothing secret is baked into the image).
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/package.json
COPY libs/audit-contract/package.json libs/audit-contract/package.json
COPY apps/audit-service/package.json apps/audit-service/package.json
RUN npm ci --workspace=audit-service --workspace=@nawara/service-kit --workspace=@nawara/audit-contract --omit=dev --include-workspace-root --ignore-scripts
COPY --from=build /app/libs/service-kit/dist ./libs/service-kit/dist
COPY --from=build /app/libs/audit-contract/dist ./libs/audit-contract/dist
COPY libs/service-kit/migrations ./libs/service-kit/migrations
COPY --from=build /app/apps/audit-service/dist ./apps/audit-service/dist
# Schema of record travels with the image so a deploy always applies the migrations that match this code (none of its own before 18.3).
COPY apps/audit-service/db/migrations ./apps/audit-service/db/migrations
WORKDIR /app/apps/audit-service
# The service only reads its own files and opens sockets: it needs no write access and no privileges (the base image's `node` user).
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
