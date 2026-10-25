# Stage 1: Install dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Stage 2: Build the application
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client before building
RUN npx prisma generate

# Provide dummy env vars for build (validated at runtime, not build time)
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
ENV NEXTAUTH_SECRET="build-placeholder"
ENV NEXTAUTH_URL="http://localhost:3000"

RUN npm run build

# Stage 3: Production runtime
# KNOWN GAP (KD-040, docs/auth-ops.md): the standalone output below carries @typespec/compiler and NO emitter package and no
# node_modules/.bin/tsp, so this image cannot GENERATE a schema target (/api/v1/health reads "degraded", HTTP 200). Five emitters are
# file:../typespec/packages/* links that this build context does not have.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
