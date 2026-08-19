# Verify your install

Use this checklist to confirm a **fresh clone** works end-to-end. Prefer a **second directory** with empty `.data/` and a new `.env.local` — not a folder you already use daily.

**Prerequisites:** README [Before you run the app](../../README.md#before-you-run-the-app), then `npm run init` (or manual steps in README).

## Automated preflight (`npm run onboard`)

From the repo root (after `.env.local` has real Plaid credentials and `node_modules` exists):

```bash
npm run onboard
```

`npm run onboard` checks Node against `engines`, optionally creates `.env.local` from `.env.example` with `--yes`, runs `npm run typecheck` and `npm run build`, runs `npm run scan:secrets` when **gitleaks** is on PATH (otherwise warns — see [pre-publish-secret-scan.md](./pre-publish-secret-scan.md)), lists remaining steps, and prints a **summary block** you can save for your records.

| Flag | Meaning |
|------|---------|
| `--yes` | Non-interactive: create `.env.local` from `.env.example` if missing. |
| `--install` | Run `npm ci` when `node_modules` is missing. |
| `--skip-build` | Skip `npm run build`. |
| `--skip-secrets` | Skip `npm run scan:secrets`. |
| `--skip-env` | Do not touch `.env.local`. |
| `--full` | Also run `npm test` (typecheck + `smoke:keychain`). |

Full flag list: header comment in `scripts/onboard.mjs`.

## Manual checklist (target: under 30 minutes)

Record start and end time; `npm run onboard` prints UTC timestamps in its summary.

1. [ ] `git clone` the repo into a **new** directory.
2. [ ] `cp context/budgets.template.yml context/budgets.yml` (optional).
3. [ ] Plaid Dashboard **Client ID** + secret for your `PLAID_ENV` ([Sandbox first](./plaid-sandbox-setup.md); Production after approval).
4. [ ] `npm run init` (or manual `npm ci` + `.env.local` per README).
5. [ ] `npm run onboard` — add `--install` if needed; `--full` for `npm test`.
6. [ ] Confirm `.env.local` matches this clone; omit LLM keys unless testing AI features.
7. [ ] If gitleaks was skipped, install it and re-run `npm run scan:secrets`, or `npm run onboard` without `--skip-secrets`.
8. [ ] `npm run dev` (if not already running); open the UI URL from the terminal.
9. [ ] Plaid Link completes; accounts appear.
10. [ ] Sync or refresh works.
11. [ ] (Optional) Add an LLM key; try category review and/or briefings / chat.

## Troubleshooting

Note URLs, error messages, and screenshots when filing [GitHub issues](https://github.com/rohitnandwate/local-finances-manager/issues).
