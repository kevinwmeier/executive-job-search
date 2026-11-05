# executive-job-search: notes

## Where roles are stored: Google Sheets, NOT Airtable (confirmed Nov 5, 2026)

- Roles (and generated documents) live in a **Google Sheet**: tabs `Roles` and `Documents`. It is fronted by a **Google Apps Script web app**; the source is in `apps-script/Code.gs` (the live copy is in the Apps Script project bound to the sheet; redeploy a new version after changes).
- Data flow: scrapers (n8n on Railway) -> Apps Script web app -> Sheet. The Vercel app never touches the sheet; it calls the n8n webhooks (`get-roles`, `update-role`, `create-document`), which call the web app.
  - Reads: `GET ?action=getRoles | getUrls | getDocuments`. Writes: `POST ?action=appendRoles | appendRole | updateRole | appendDocument`.
- The web app `/exec` URL is the only credential (anyone with it can read and write the sheet). It is hard-coded in the n8n workflows and recorded in `job search - google sheets.txt`. There is no Airtable credential in use.
- Verified Nov 5, 2026 by reading the live n8n workflows: every active workflow that saves or reads roles (all 8 scrapers, API - Get Roles, API - Update Role, API - Create Document) calls the Apps Script URL. Airtable only remains in inactive/archived workflows (Google Alert RSS, LinkedIn Alerts, and archived old scrapers).
- Airtable was the original store. Stale leftovers: several active scraper workflows still have a node *named* "Save to Airtable" (it writes to Google Sheets); `api/fix-dedup.js` is Airtable-specific and marked obsolete (do not run it, safe to delete).
- Dedup: each scraper's DeDupe node fetches `getUrls` (all URLs in the Roles tab) and drops anything already present. **`getUrls` includes rows with `Status = Deleted`** (deleting a role is a soft delete), so deleted roles are never re-added; `getRoles` hides them. That is why `getUrls` returns more URLs than `getRoles` has roles.
- Known issue: "Always Output Data" is on for the DeDupe node in PFM Scraper and MacDonald Scraper, so a run with nothing new saves one blank row (about 140 blank rows by Oct 2026; hidden in the app by the blank-title filter). The Apps Script `appendRoles` has no empty-row guard.
- Fuller reference: `n8n_exec_scraper_reference.docx` (updated for Google Sheets Nov 5, 2026).

## Anthropic API keys (added Oct 23, 2026)

- This project calls Claude from `api/claude.js` (and `api/test.js`) using `ANTHROPIC_API_KEY`. In production that value comes from Vercel (Settings > Environment Variables); a copy also sits in `.env.local` in this folder.
- Per `PAUL/docs/Security_Secrets_Plan.md`, `.env.local` holds a **second** Anthropic key, separate from PAUL's. This project's key lives in the **Default** workspace of the Anthropic console.
- **Oct 23, 2026:** Kevin **disabled** the old PAUL Anthropic key (last used Oct 13; PAUL moved to a key in its own `PAUL_laptop` workspace on Oct 13). Plan: delete it after about a week if nothing breaks.
- **Not confirmed:** whether this project's key is the same key as the old PAUL key. It was not compared (keys are never printed or compared through tool calls). **If this project stops working with an authentication error, re-enable the disabled key in the Anthropic console first**, then work out which key this project should use.
- Still open (PAUL security plan, S2): confirm Vercel holds the keys in `.env.local`, then delete `.env.local` (it also holds a Gmail app password and an n8n key).
