# --- build stage: install everything, compile TypeScript ---
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 (used by @actual-app/api) ships prebuilt
# binaries for Linux x64 and arm64, but its install script compiles SQLite from
# source anyway, which took many minutes on TrueNAS.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
COPY public ./public
# Make the files copied from the host readable by the non-root runtime user.
# COPY keeps the host's permissions, so a clone made with a strict umask (e.g.
# as root on TrueNAS) would leave files only root can read. dist is created in
# the image and is readable already.
RUN chmod -R a+rX package.json package-lock.json public

# --- runtime stage: production dependencies and compiled code only ---
# Debian (glibc) rather than Alpine so better-sqlite3, used by @actual-app/api,
# installs from a prebuilt binary.
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    ACTUAL_DATA_DIR=/data/actual-cache
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
# Production dependencies are installed fresh here instead of running
# `npm prune` in the build stage. Never delete, rename or chmod files that an
# earlier layer created: on TrueNAS's Docker storage that copies them up one
# by one and hangs the build (seen with both `npm prune` and `chmod -R`).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# Fixed non-root UID/GID (568 is the "apps" user on TrueNAS SCALE). The data
# folder on the host must be writable by it.
USER 568:568
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
