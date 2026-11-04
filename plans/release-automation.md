# Todo: automated releases matching Actual versions

Status: todo, nothing built yet. Requires the repo to be public first (so
TrueNAS can pull the image without a token).

## Goal

No git clone or image build on TrueNAS. Dockge pulls a ready-made image
tagged with the Actual version it matches, and updating means changing one
line in `.env`.

## Steps

1. **Dependabot** (`.github/dependabot.yml`): watch only `@actual-app/api`
   on npm, exact versions. A new Actual release opens a PR; CI tests it.
   Auto-merge when CI passes (nothing reaches TrueNAS until `.env` changes).
2. **Release workflow**: on every push to `main`, build the image and push
   it to `ghcr.io/<owner>/actual-importer`, tagged with the
   `@actual-app/api` version from `package.json` (e.g. `26.11.0`). x86 only.
3. **compose.yaml**: use
   `image: ghcr.io/<owner>/actual-importer:${ACTUAL_VERSION}` instead of
   `build:`. Keep building from source for local development via a small
   extra compose file.
4. **Docs**: rewrite the README setup, Dockge and "Updating Actual" sections
   (paste compose into a new stack, fill in `.env` and `accounts.json`,
   Start; to update, change `ACTUAL_VERSION` and click Update). Update the
   pinning rule and deployment notes in `CLAUDE.md`.

## Known trade-off

Fixes made after a bump only ship in the newest version's image. Tags for
older Actual versions are not rebuilt.
