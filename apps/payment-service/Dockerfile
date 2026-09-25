# syntax=docker/dockerfile:1
#
# Built with repo-root context (npm workspaces monorepo — payment-service has no lockfile of its
# own; the workspace root's package.json/package-lock.json is required to resolve its
# dependencies, including the shared @nawara/service-kit workspace package).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/package.json
COPY libs/audit-contract/package.json libs/audit-contract/package.json
COPY apps/payment-service/package.json apps/payment-service/package.json
RUN npm ci --workspace=payment-service --workspace=@nawara/service-kit --workspace=@nawara/audit-contract --include-workspace-root --ignore-scripts
COPY libs/service-kit libs/service-kit
RUN npm run build -w @nawara/service-kit
COPY libs/audit-contract libs/audit-contract
RUN npm run build -w @nawara/audit-contract
COPY apps/payment-service apps/payment-service
RUN npm run build --workspace=payment-service

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY libs/service-kit/package.json libs/service-kit/package.json
COPY libs/audit-contract/package.json libs/audit-contract/package.json
COPY apps/payment-service/package.json apps/payment-service/package.json
RUN npm ci --workspace=payment-service --workspace=@nawara/service-kit --workspace=@nawara/audit-contract --omit=dev --include-workspace-root --ignore-scripts
COPY --from=build /app/libs/service-kit/dist ./libs/service-kit/dist
COPY --from=build /app/libs/audit-contract/dist ./libs/audit-contract/dist
COPY libs/service-kit/migrations ./libs/service-kit/migrations
COPY --from=build /app/apps/payment-service/dist ./apps/payment-service/dist
# Schema of record travels with the image so a deploy always applies the migrations that match this exact code.
COPY apps/payment-service/db/migrations ./apps/payment-service/db/migrations
WORKDIR /app/apps/payment-service
# The service only reads its own files and opens sockets: it needs no write access and no privileges (the base image's `node` user).
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
