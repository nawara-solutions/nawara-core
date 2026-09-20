# syntax=docker/dockerfile:1
#
# Built with repo-root context (npm workspaces monorepo: organization-service has no lockfile of its own; the workspace root's
# package.json/package-lock.json is required to resolve its dependencies, including the shared @nawara/service-kit package).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/package.json
COPY apps/organization-service/package.json apps/organization-service/package.json
RUN npm ci --workspace=organization-service --workspace=@nawara/service-kit --include-workspace-root --ignore-scripts
COPY libs/service-kit libs/service-kit
RUN npm run build -w @nawara/service-kit
COPY apps/organization-service apps/organization-service
RUN npm run build --workspace=organization-service

FROM node:22-alpine AS runtime
WORKDIR /app
# Production is the default; configuration comes from the environment at run time (nothing secret is baked into the image).
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/package.json
COPY apps/organization-service/package.json apps/organization-service/package.json
RUN npm ci --workspace=organization-service --workspace=@nawara/service-kit --omit=dev --include-workspace-root --ignore-scripts
COPY --from=build /app/libs/service-kit/dist ./libs/service-kit/dist
COPY libs/service-kit/migrations ./libs/service-kit/migrations
COPY --from=build /app/apps/organization-service/dist ./apps/organization-service/dist
# Schema of record travels with the image so a deploy always applies the migrations that match this exact code.
COPY apps/organization-service/db/migrations ./apps/organization-service/db/migrations
WORKDIR /app/apps/organization-service
# The service only reads its own files and opens sockets: it needs no write access and no privileges (the base image's `node` user).
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
