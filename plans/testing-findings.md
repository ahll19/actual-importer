# Testing findings (running tally)

Bugs and observations from manual testing. All items are fixed on `fix/testing-findings`.

## 1. Drag and drop does not work (Firefox)

**Status:** fixed on `fix/testing-findings`. Confirmed working in Firefox
after the change (cancelling `dragenter` as well as `dragover`).

**Seen:** dropping a CSV on the upload area does nothing in Firefox. Clicking
to choose a file works. Drag and drop works in Chrome.

**Code:** `public/index.html`, the `dragover` / `dragleave` / `drop` handlers on
`#drop` (a `<label>` wrapping a hidden `<input type="file">`).

**Test results so far:** the border highlights while dragging over the box,
nothing happens on drop (no request reaches the server, nothing in the logs).
Dragged from GNOME Files (Nautilus). Works in Chrome.

**What that means:** `dragover` reaches the box, so the drop zone is
recognised. Either `drop` never fires, or it fires without a file and the
handler (`if (e.dataTransfer.files[0]) ...`) silently does nothing.

**Possible causes (unconfirmed), most likely first:**

- Firefox on Wayland passes the dragged item from GNOME Files as a link
  (`text/uri-list`) rather than as a file, so `dataTransfer.files` is empty
  and the page ignores the drop with no message.
- `dragenter` is not cancelled, only `dragover`. Less likely now, since the
  highlight shows Firefox sends drag events to the box.
- Minor: `dragleave` fires when the pointer moves over the text inside the
  box, so the highlight flickers. Cosmetic only.
- Either way, a drop with no usable file should show a message instead of
  doing nothing.

**Next check:** with the page open, paste this into the Firefox console
(F12 → Console), drop the file on the box, and see what it prints:

```js
document.addEventListener('drop', (e) => console.log('drop', e.target.tagName, [...e.dataTransfer.types], e.dataTransfer.files.length), true);
```

No output means `drop` never fires. `files.length` 0 means it fires without
a file.

## 2. Log timestamps are Unix epoch milliseconds

**Status:** fixed on `fix/testing-findings`: logs show
`"time":"2026-10-29 20:50:21"` in Copenhagen time, set via `Intl` in
`src/app.ts` (no `TZ` needed).

**Seen:** log lines show `"time": 1761...` instead of a readable time.

**Cause:** Fastify's built-in logger (pino) writes epoch milliseconds by
default (`src/app.ts`, `Fastify({ logger: ... })`). The container also has no
time zone set, so it runs in UTC.

**Wanted:** Copenhagen time (`Europe/Copenhagen`), readable. pino's built-in
ISO option is always UTC, so this needs `TZ=Europe/Copenhagen` in
`compose.yaml` plus a small custom `timestamp` function, or formatting with
`Intl` in Copenhagen time directly. No new dependency needed.

## 3. Missing-account error doesn't mention account creation

**Seen:** with `CREATE_MISSING_ACCOUNTS` not set, the preview says only
`Actual har ingen konto med navnet "..."`. Easy to think the new setting is
broken when it is just not turned on.

**Status:** fixed: the message now says the account can be created
in Actual, or automatically with `CREATE_MISSING_ACCOUNTS=true`.

**Idea was:** add a hint to that message, e.g. that the account can be created
in Actual, or created automatically with `CREATE_MISSING_ACCOUNTS=true`.

## 4. Missing space in the account line

**Seen:** `3144 rækker ·2023-10-02 til ...`: no space after `·`.

**Cause:** `public/index.html`, `accountSection`: `` ` ·${a.dateFrom}` `` lacks
a space before `${a.dateFrom}`.

**Status:** fixed.

## 5. Result page repeats every imported row

**Seen:** after a successful import the page lists all added rows again
(thousands for a full export).

**Status:** fixed on `fix/testing-findings`: after an import, the row list is
only shown for an account Actual reported errors on. A clean import shows
just the counts.

## Notes (answered questions, not bugs)

- `accounts.json` is **not** read at container start. It is read fresh on
  every preview and every import (`src/accounts.ts`, called from `src/app.ts`),
  so edits take effect without a restart. A missing or broken file only shows
  up as an error on the page at preview time, not at startup.
