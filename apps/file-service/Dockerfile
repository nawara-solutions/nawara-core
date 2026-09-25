# syntax=docker/dockerfile:1
#
# Built with repo-root context (npm workspaces monorepo: file-service has no lockfile of its own; the workspace root's
# package.json/package-lock.json is required to resolve its dependencies, including the shared @nawara/service-kit package).
# The Notification / Organization / Billing image pattern. The migrations (the kit's and, from Stage 17.3, the service's own) travel
# with the image; they are applied by the explicit `npm run migrate` step as the migrator role, never at startup and never with the
# runtime credentials.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/package.json
COPY libs/audit-contract/package.json libs/audit-contract/package.json
COPY apps/file-service/package.json apps/file-service/package.json
RUN npm ci --workspace=file-service --workspace=@nawara/service-kit --workspace=@nawara/audit-contract --include-workspace-root --ignore-scripts
COPY libs/service-kit libs/service-kit
RUN npm run build -w @nawara/service-kit
COPY libs/audit-contract libs/audit-contract
RUN npm run build -w @nawara/audit-contract
COPY apps/file-service apps/file-service
RUN npm run build --workspace=file-service

FROM node:22-alpine AS runtime
WORKDIR /app
# Production is the default; configuration comes from the environment at run time (nothing secret is baked into the image).
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/package.json
COPY libs/audit-contract/package.json libs/audit-contract/package.json
COPY apps/file-service/package.json apps/file-service/package.json
RUN npm ci --workspace=file-service --workspace=@nawara/service-kit --workspace=@nawara/audit-contract --omit=dev --include-workspace-root --ignore-scripts
COPY --from=build /app/libs/service-kit/dist ./libs/service-kit/dist
COPY --from=build /app/libs/audit-contract/dist ./libs/audit-contract/dist
COPY libs/service-kit/migrations ./libs/service-kit/migrations
COPY --from=build /app/apps/file-service/dist ./apps/file-service/dist
# Schema of record travels with the image so a deploy always applies the migrations that match this code (Stage 17.3: the file schema).
COPY apps/file-service/db/migrations ./apps/file-service/db/migrations
WORKDIR /app/apps/file-service
# Stage 17.4: an EMPTY mount point for the development filesystem store (a named volume inherits its owner and mode); it holds nothing
# in the image, and production refuses the filesystem store (bytes go to the S3-compatible provider).
RUN mkdir -p /var/lib/file-service/storage && chown node:node /var/lib/file-service/storage && chmod 700 /var/lib/file-service/storage
# The service reads its own files and opens sockets; the only writable place is that (development) mount point. No privileges: the
# base image's `node` user.
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
