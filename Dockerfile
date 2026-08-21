# syntax=docker/dockerfile:1
#
# Production image for AppSkeleton (feature #107: multi-stage, non-root
# user, minimal base).
#
# Two stages:
#
#   1. build   — full `npm ci` (dev + prod deps, needed for `tsc` itself
#      and the type declarations it checks against), then compiles
#      src/ + tests/ (tsconfig.json's own "include") to dist/src/ and
#      dist/tests/. Only dist/src/ is used from here on.
#
#      Every plugin's `plugin.json` manifest is read from disk at runtime
#      (registry.ts's `scanPluginDirectories()`, via server/index.ts's
#      `DEFAULT_PLUGINS_ROOT`) rather than imported by any .ts source
#      file, so `tsc` never emits it into dist/ on its own — copied next
#      to each plugin's compiled index.js by hand below. Without this
#      step every plugin fails discovery ("no plugin.json found") and the
#      kernel can't start (see resolveEntryPointPath's doc comment in
#      src/server/index.ts for the matching entry_point ".ts" -> ".js"
#      resolution fix this image relies on).
#
#   2. runtime — minimal Alpine base, prod-only deps, non-root user, and
#      only the compiled dist/src/ tree (copied in flattened as ./dist,
#      matching package.json's own "start": "node dist/server/index.js").
#      No compiler, no devDependencies, no source ships in the final
#      image.

FROM node:20-alpine AS build
WORKDIR /app

# Install with lockfile-exact versions; --ignore-scripts skips husky's
# "prepare" git-hook install, which is dev-workflow-only and irrelevant
# (and unable to find a .git dir) inside a build context.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build \
  && find src/plugins -name plugin.json -exec sh -c \
     'mkdir -p "dist/$(dirname "$1")" && cp "$1" "dist/$1"' _ {} \;

# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY --from=build /app/dist/src ./dist

# node:20-alpine already ships an unprivileged "node" user (uid/gid 1000);
# reuse it instead of creating a new one, and hand it ownership of /app so
# the app can read its own files without a root-owned process.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# api-gateway's /health route (feature #58) is DB-free and synchronous, so a
# healthy response only proves the kernel booted and the HTTP server is
# listening — that's the whole point of a container healthcheck. busybox
# wget ships in node:*-alpine by default, no extra package needed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "dist/server/index.js"]
