# actual-importer

> **AI disclaimer:** most of this project's code and documentation was written
> with an AI assistant (Claude Code) and reviewed by the owner. Read the code
> before trusting it with your own budget.

A small LAN-only web page that imports CSV exports from Netbank on the BEC
platform (used by several Danish banks) into a self-hosted [Actual Budget](https://actualbudget.org).

Drop a CSV on the page, check the preview, click **Import**. Uploading the same
(or an overlapping) export again is safe: rows already in Actual are skipped.

## Setup

Only Docker is needed.

1. Create `.env` from the example and fill it in:

   ```bash
   cp .env.example .env
   ```

   | Variable | Required | Meaning |
   |---|---|---|
   | `ACTUAL_SERVER_URL` | yes | e.g. `https://budget.example.com` |
   | `ACTUAL_PASSWORD` | yes | Actual server password |
   | `ACTUAL_SYNC_ID` | yes | Actual → Settings → Advanced settings → Sync ID |
   | `ACTUAL_E2E_PASSWORD` | no | Only if end-to-end encryption is turned on |
   | `CREATE_MISSING_ACCOUNTS` | no | `true` creates accounts named in `accounts.json` that the budget doesn't have, with the bank's starting balance. Meant for a test budget; leave unset for the real one |
   | `DATA_PATH` | no | Host folder for `/data`. Default `./data` |

2. Create the data folder with your account mapping, and make it writable by
   the container's user (UID 568):

   ```bash
   mkdir -p data && cp accounts.example.json data/accounts.json
   ```

   ```bash
   sudo chown -R 568:568 data
   ```

   `accounts.json` maps the bank's account number (`Exportkonto`) to the
   **name** of an account in Actual. Edits take effect on the next upload.

3. Start it:

   ```bash
   docker compose up -d --build
   ```

   The page is at http://localhost:3010, and http://localhost:3010/healthz
   returns `{"ok":true}`.

## Running in Dockge

1. Clone the repo into Dockge's stacks folder as its own stack (the default
   is `/opt/stacks`):

   ```bash
   git clone <repo-url> /opt/stacks/actual-importer
   ```

2. Do steps 1 and 2 of [Setup](#setup) inside that folder.
3. In Dockge, open the `actual-importer` stack and click **Start**. Dockge
   builds the image from the folder.

**To update:** `git pull` in the stack folder, then **Update** (or
**Restart**) in Dockge. The image is always rebuilt from the folder
(`pull_policy: build`), so nothing is pulled from a registry.

**If the container can't resolve the Actual hostname**, set
`ACTUAL_SERVER_URL` to Actual's address on the LAN instead, e.g.
`http://<host-ip>:<actual-port>`.

## Updating Actual

The importer only works with the exact Actual version it was built for
(currently `26.10.0`). So whenever you upgrade Actual, update the importer
to the same version:

1. On any computer with Docker, open a terminal in your copy of this repo.
2. Set the version you are upgrading Actual to, then run the update command.
   It runs `npm` inside a throwaway container, so Node doesn't need to be
   installed:

   ```bash
   VERSION=26.11.0

   docker run --rm \
     --user "$(id -u):$(id -g)" -e HOME=/tmp \
     -v "$PWD":/app:z -w /app \
     node:24-bookworm-slim \
     npm install --package-lock-only --save-exact "@actual-app/api@$VERSION"
   ```

3. Check that only `package.json` and `package-lock.json` changed
   (`git status`), then commit and push them.
4. Upgrade the Actual server.
5. Update the importer: `git pull` in the stack folder, then **Update** in
   Dockge (see [Running in Dockge](#running-in-dockge)). Don't import between
   steps 4 and 5.
6. Upload a recent export. The preview should show every row as already
   imported. Close the page without importing.

## Good to know

- **Rejected lines** (ones the importer can't read safely) are shown in the
  preview and never imported. Add them in Actual by hand.
- **Balance warnings** mean the export is probably missing rows.
- **Deleted transactions stay deleted**: re-importing doesn't bring back a row
  you deleted in Actual.
- **There is no login.** Anyone who can reach the page can import into the
  budget, so keep it on the LAN and never expose it to the internet.
- **Payee names** are kept exactly as the bank writes them, so Actual rules can
  match on the bank's text.
