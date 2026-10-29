# Suggestion: categorizing with a local LLM (next step)

Status: proposal, nothing built yet. Constraint: local models only, at most
16 GB VRAM (e.g. via Ollama).

## Idea in one line

Use the model to suggest a **rule per merchant**, have the owner review the
suggestions, and turn accepted ones into **Actual rules**. Actual then
categorizes at import time on its own; the model is only needed for new
merchants.

## Why rules, not the model categorizing each transaction

- **Consistent:** asking per transaction can put the same merchant in
  different categories. One decision per merchant avoids that.
- **Readable and free:** a rule like "Imported payee contains NETTO → payee
  Netto, category Groceries" can be read, edited in Actual's UI, and costs
  nothing to run.
- **Automatic:** rules run on every future import. The importer keeps the
  bank's exact text (`payeeNameNormalization: 'original'`), so "Imported payee
  contains" rules match reliably.
- Actual also learns rules when a payee is categorized the same way
  repeatedly, so the long tail can be done by hand.

## What to expect from a ~12–14B model (estimate, not measured)

- **Good:** obvious merchants (supermarkets, fuel, streaming, utilities,
  pharmacies), especially after cleaning the text.
- **Can't work out:** MobilePay to people, bank transfers, "Overførsel" and
  cryptic text. Only the owner knows what these are, so they need manual input
  once and then a rule.

## Workflow

1. **History in a test budget.** Import past exports into a separate test
   budget (`CREATE_MISSING_ACCOUNTS=true` creates the accounts).
2. **Group by cleaned-up text.** Strip prefixes like "Debetkort", card numbers
   and dates. A few thousand rows should shrink to a few hundred unique
   merchants. Sort by how often each appears.
3. **Ask the model per merchant.** Send the cleaned text, a sample amount
   and sign, the budget's real category list (from the Actual API), and a few
   examples the owner has already decided. Force JSON output (Ollama's
   `format` with a JSON schema) whose category must be one from the list or
   `"unknown"`, plus a confidence level. This rules out invented categories.
4. **Review.** Accept, change or skip each suggestion, in a review file
   (CSV/JSON) or later a simple page. Spend time on `unknown` and low
   confidence; accept high confidence quickly.
5. **Create rules.** A second script creates the approved rules via the
   Actual API: condition `imported_payee contains <text>`, actions set payee
   and category. Check against existing rules to avoid duplicates.
6. **Ongoing.** After each import, only new, uncategorized merchants go
   through steps 3–5.

## Model choice

- A current instruct model of ~12–14B at 4-bit fits easily in 16 GB; ~24B at
  4-bit just fits and may do better on Danish text.
- Each merchant is asked once, so speed hardly matters; pick for quality.
- Compare two candidates on ~50 merchants the owner has already decided, and
  keep the one with more correct answers.

## Where it lives

- Separate scripts, not the web app, e.g. `scripts/suggest-rules.ts` (writes
  the review file) and `scripts/create-rules.ts` (creates approved rules).
- `CLAUDE.md` currently says **no network calls other than to the Actual
  server**. Calling Ollama needs that rule changed, ideally only for these
  scripts and only to an LLM host on the LAN. Decide this before building.
- Never log transaction text or amounts (existing rule); the review file
  holds merchant text, so keep it in the git-ignored `data/` folder.
- Run against the test budget first. Creating rules in the real budget
  touches the real Actual server, so ask first (Workflow rule).

## Not chosen

- **actual-ai** (community tool): categorizes transactions directly with
  less review, which is exactly the inconsistency this plan avoids. Still
  worth a look for ideas.

## Open questions

- Which categories exist in the budget, and which merchants are already
  decided (for few-shot examples)?
- Review in a file, or a page in the importer later?
- Which model host and URL (Ollama on which machine)?
