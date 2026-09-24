# syntax=docker/dockerfile:1
#
# Built with repo-root context (npm workspaces monorepo: notification-service has no lockfile of its own; the workspace root's
# package.json/package-lock.json is required to resolve its dependencies, including the shared @nawara/service-kit package).
# The Organization / Billing image pattern (SDD notification-service §18). Stage 16.3 has no database yet: the migrations directory
# (the service's own and the kit's) joins the runtime stage with persistence in Stage 16.4.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/package.json
COPY apps/notification-service/package.json apps/notification-service/package.json
RUN npm ci --workspace=notification-service --workspace=@nawara/service-kit --include-workspace-root --ignore-scripts
COPY libs/service-kit libs/service-kit
RUN npm run build -w @nawara/service-kit
COPY apps/notification-service apps/notification-service
RUN npm run build --workspace=notification-service

FROM node:22-alpine AS runtime
WORKDIR /app
# Production is the default; configuration comes from the environment at run time (nothing secret is baked into the image).
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/package.json
COPY apps/notification-service/package.json apps/notification-service/package.json
RUN npm ci --workspace=notification-service --workspace=@nawara/service-kit --omit=dev --include-workspace-root --ignore-scripts
COPY --from=build /app/libs/service-kit/dist ./libs/service-kit/dist
COPY --from=build /app/apps/notification-service/dist ./apps/notification-service/dist
WORKDIR /app/apps/notification-service
# The service only reads its own files and opens sockets: it needs no write access and no privileges (the base image's `node` user).
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
