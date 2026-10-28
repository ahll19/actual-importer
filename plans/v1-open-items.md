# v1: open items

The v1 spec is implemented. Nothing is known to be broken. Still to do:

1. Try it with a **real** bank export. So far only fake data has been used
   (33 Vitest tests, plus an end-to-end run against a throwaway local Actual
   server). Start with the dry run (see CLAUDE.md → Commands).
2. Install Dockge on TrueNAS, deploy the stack, and set up the reverse proxy
   host (README).
3. Translate the page and the error messages it shows to Danish (they are
   English today).
