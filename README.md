# local-finances-manager

**Local-first** personal finance on your machine: Plaid accounts, transfers, exports, budgets, and optional AI (category review, briefings, chat).

**New here?** Follow [Before you run the app](#before-you-run-the-app), then [Quick start](#quick-start-no-llm-required) (`npm run init`).

## Requirements

| Requirement | Notes |
| ----------- | ----- |
| **Node.js** | **22.x or newer** (`package.json` → `engines`). |
| **npm** | 10+ recommended (ships with Node). |
| **macOS** | **Recommended** for v1: Plaid access tokens are stored in **macOS Keychain** (see [Platform support](#platform-support)). |
| **Plaid** | [Plaid Dashboard](https://dashboard.plaid.com/) account — see [Before you run the app](#before-you-run-the-app). |

**First install:** `npm ci` (via `npm run init`) often takes **10–15 minutes** on a fresh machine while native dependencies (DuckDB) build. Later starts are much faster.

## Before you run the app

### Plaid keys

1. [Sign up / sign in](https://dashboard.plaid.com/) to the Plaid Dashboard.
2. Under **Team Settings** → **Keys**, copy **Client ID** and the secret for your environment.

**New to Plaid?** Start with **Sandbox** (test institutions, no live banks):

- Set `PLAID_ENV=sandbox` and `SANDBOX_PLAID_SECRET` in `.env.local`.
- Details: [docs/operations/plaid-sandbox-setup.md](docs/operations/plaid-sandbox-setup.md)

**Live institutions (default):** use `PLAID_ENV=production` and `PROD_PLAID_SECRET` (see [.env.example](.env.example)).

### Budget file (optional but recommended)

Budget targets read from `context/budgets.yml` (gitignored). Copy the template once per clone:

```bash
cp context/budgets.template.yml context/budgets.yml
```

Edit categories and monthly targets in `context/budgets.yml` when you are ready.

## Quick start (no LLM required)

LLM features are optional — see [Optional: LLM](#optional-llm-category-review--financial-intelligence) below.

### Guided

```bash
git clone https://github.com/rohitnandwate/local-finances-manager.git
cd local-finances-manager
cp context/budgets.template.yml context/budgets.yml   # optional
npm run init
```

Options: `npm run init -- --help`.

`init` installs dependencies, scaffolds `.env.local`, optionally enables the secret pre-commit hook (when [gitleaks](docs/operations/pre-publish-secret-scan.md) is installed), and can start the dev server.

### Manual

```bash
git clone https://github.com/rohitnandwate/local-finances-manager.git
cd local-finances-manager
cp context/budgets.template.yml context/budgets.yml   # optional
npm ci
cp .env.example .env.local
```

Edit `.env.local`: `PLAID_ENV`, `PLAID_CLIENT_ID`, and the Plaid secret for your environment (see `src/config.ts` for variable names).

```bash
npm run dev
```

Open the printed URL (default `http://127.0.0.1:3000`) and use **Plaid Link** to connect accounts.

Session metadata lives under `.data/`; on macOS access tokens are in **Keychain** (see `.env.example`).

### Verify your install

After setup, run `npm run onboard` for an automated preflight (typecheck, build, optional secret scan) and a summary you can keep for your records. See [docs/operations/clean-machine-first-run.md](docs/operations/clean-machine-first-run.md).

### Optional: LAN / other devices

- Default bind is `127.0.0.1`. Set `HOST=0.0.0.0` only if you need LAN access.
- With Wi‑Fi gating enabled (default on macOS), `HOST=0.0.0.0` requires both `LAN_ACCESS_CODE` and `LAN_ALLOWED_WIFI_SSIDS` in `.env.local`. Browsers authenticate via session cookie or Bearer token — see `/api/health` → `service.localNetwork`.
- On **Linux** or in CI, set `BUDGET_TRACKER_DISABLE_WIFI_GATING=1` when you need `HOST=0.0.0.0` without SSID detection.

## Optional: LLM (category review & Financial Intelligence)

LLM-assisted **transaction category review**, **briefings**, and **conversational queries** need a configured provider API key. Without keys, the rest of the app still runs.

Set in `.env.local` (provider-agnostic via [Vercel AI SDK](https://sdk.vercel.ai)):

```bash
LLM_PROVIDER=openai          # openai | anthropic | google
LLM_MODEL=gpt-4o             # optional; defaults per provider
OPENAI_API_KEY=sk-...        # only the active provider’s key is required
```

Other provider keys: see `.env.example`.

**Architecture:** For briefings and chat, the LLM narrates while **numbers** come from deterministic DuckDB over exports — the LLM does not invent totals. Category review uses the LLM to propose PFC-consistent labels from merchant and description text.

| Provider    | Default model       | Alternatives                             |
| ----------- | ------------------- | ---------------------------------------- |
| `openai`    | `gpt-4o`            | `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini` |
| `anthropic` | `claude-sonnet-4-5` | `claude-haiku-4-5`, `claude-sonnet-4`    |
| `google`    | `gemini-2.0-flash`  | `gemini-2.5-pro`, `gemini-2.5-flash`     |

## What it does (capabilities)

- Plaid Link for accounts; local session + **Keychain-backed** tokens (macOS)
- Balances and transaction history with PFCv2-style enrichment
- Inter-account transfer detection; TSV exports (several report types)
- Optional LLM-assisted category review; AI briefings and chat with DuckDB-backed answers
- Budget targets (`context/budgets.yml`) and category override / review flows

## Platform support

| OS        | Support |
| --------- | ------- |
| **macOS** | **Primary** for v1. Keychain storage and optional Wi‑Fi SSID binding are implemented for Darwin. |
| **Linux** | Supported for development. Plaid tokens are **not** stored in Keychain — use a dedicated clone and read `/api/health` for storage details. Set `BUDGET_TRACKER_DISABLE_WIFI_GATING=1` when using `HOST=0.0.0.0`. |

`/api/health` exposes `localState.keychainServiceName` (resolved Keychain service for this `.data` directory).

## Contributors

- AI agents: [AGENTS.md](AGENTS.md)
- Operator docs: [docs/README.md](docs/README.md)
- Secret scanning: `npm run setup:hooks` and `npm run scan:secrets` — [docs/operations/pre-publish-secret-scan.md](docs/operations/pre-publish-secret-scan.md). CI runs the same scan on every push and PR.
