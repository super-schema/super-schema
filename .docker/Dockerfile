# Stage 1: Install dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Stage 2: Build the application
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The runtime stage copies public/, which the repository does not have: create it, or the COPY below stops the build.
RUN mkdir -p public

# Generate Prisma client before building
RUN npx prisma generate

# Provide dummy env vars for build (validated at runtime, not build time). The image is PostgreSQL only, so the build must not open
# the embedded database either: DB_PROVIDER decides which database src/lib/db-adapter.ts opens, and when it is unset that is PGlite.
ENV DB_PROVIDER="postgresql"
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
ENV NEXTAUTH_SECRET="build-placeholder"
ENV NEXTAUTH_URL="http://localhost:3000"

RUN npm run build

# Stage 3: The one-shot migrator of the compose stack (service `migrate` in docker-compose.yml). It is the build stage, which has the
# Prisma CLI, tsx and the sources that the runtime image does not have. `npm run db:deploy` applies the committed migrations and then
# installs the built-in message properties, and exits. NODE_ENV=production keeps the seed (`npm run db:seed`, which a `docker compose run`
# can start here) from making the development administrator admin@admin.com (src/lib/admin-bootstrap.ts, planSeedAdmin).
FROM build AS migrate
ENV NODE_ENV=production
CMD ["npm", "run", "db:deploy"]

# Stage 4: Production runtime
# KNOWN GAP (KD-040, docs/auth-ops.md): the standalone output below carries @typespec/compiler and NO emitter package and no
# node_modules/.bin/tsp, so this image cannot GENERATE a schema target (/api/v1/health reads "degraded", HTTP 200). Five emitters are
# file:../typespec/packages/* links that this build context does not have.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# PostgreSQL only: this image carries no migrations for the embedded database, so it must not open one (it would start empty).
ENV DB_PROVIDER=postgresql

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
