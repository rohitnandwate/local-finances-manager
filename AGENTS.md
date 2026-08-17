# Agent instructions

Guidance for AI coding agents (Cursor, Claude Code, Codex, Gemini, Copilot, etc.) working in this repository.

**local-finances-manager** is a public OSS, **local-first** personal finance app: Plaid linking, exports, budgets, and optional LLM features (category review, briefings, chat). Keep changes contributor-friendly.

## Source of truth

| Area | Location |
|------|----------|
| App behavior | `src/`, `public/`, root `README.md`, `.env.example` |
| Operator runbooks | `docs/operations/` (index: `docs/README.md`) |
| Work tracking | GitHub Issues on [rohitnandwate/local-finances-manager](https://github.com/rohitnandwate/local-finances-manager) |

## Project context

- **Phase:** Personal tool — single-user, local-first. Prefer small, reviewable changes.
- **Stack:** Node 22+, TypeScript, Express, Plaid, DuckDB, optional Vercel AI SDK providers.
- **Primary platform:** macOS (Keychain for Plaid tokens). Linux is supported for dev with documented caveats in README.

## Safety (never commit)

- `.data/`, `.env`, `.env.local`
- `exports/`, `briefings/`, `data/imports/`, user portfolio files
- Secrets, tokens, real account identifiers, or personal financial exports

When editing secrets-adjacent paths, run `npm run scan:secrets`. Enable the pre-commit hook once per clone: `npm run setup:hooks` (see `docs/operations/pre-publish-secret-scan.md`).

## Workflow

1. **Plan** — Read README and any relevant `docs/operations/` runbook.
2. **Execute** — Minimal focused diff; match existing style in surrounding code.
3. **Verify** — `npm run typecheck`; run related smoke scripts or `npm test` when touching those areas; secret scan when appropriate.

## Common commands

```bash
npm run init          # first-time setup
npm run dev           # dev server
npm run build && npm start
npm run scan:secrets  # full-repo gitleaks scan
npm run setup:hooks   # pre-commit secret scan
```

## What not to add

- Studio-internal cutover manifests, private migration playbooks, or maintainer-only paths
- Empty documentation taxonomies — keep `docs/` limited to `operations/` runbooks
