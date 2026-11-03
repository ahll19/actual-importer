# --- build stage: install everything, compile TypeScript ---
FROM node:24-bookworm-slim AS build
# Compiler toolchain in case better-sqlite3 (used by @actual-app/api) has no
# prebuilt binary for this platform. Only in the build stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
COPY public ./public
# Make the files copied from the host readable by the non-root runtime user.
# COPY keeps the host's permissions, so a clone made with a strict umask (e.g.
# as root on TrueNAS) would leave files only root can read. node_modules and
# dist are created in the image and are readable already. Don't chmod them:
# that copies every file into a new layer and takes many minutes.
RUN chmod -R a+rX package.json public

# --- runtime stage: production dependencies and compiled code only ---
# Debian (glibc) rather than Alpine so better-sqlite3, used by @actual-app/api,
# installs from a prebuilt binary.
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    ACTUAL_DATA_DIR=/data/actual-cache
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# Fixed non-root UID/GID (568 is the "apps" user on TrueNAS SCALE). The data
# folder on the host must be writable by it.
USER 568:568
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
