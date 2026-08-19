# Plaid setup (Sandbox first, then Production)

**New to Plaid?** Use Sandbox until Link works. New Plaid accounts typically have Sandbox keys immediately. Production access is a separate Dashboard approval.

The app never stores your Dashboard password. You copy a client ID and a secret into gitignored `.env.local`. Tokens for linked institutions live in macOS Keychain, not in git.

## 1. Create a Plaid Dashboard account

1. Sign up at [dashboard.plaid.com](https://dashboard.plaid.com/).
2. Create an application if the Dashboard asks you to.

## 2. Enable products

This repo defaults to **US** and **`transactions`**.

In the Dashboard, enable at least **Transactions** for the same environment you will use (`sandbox` or `production`).

**Investments** is optional. Leave it off until Link works. Then add `investments` to `PLAID_PRODUCTS` in `.env.local` and use **Update Plaid consent** in the app.

## 3. Copy keys

Dashboard → **Team Settings** → **Keys**:

| You want | `PLAID_ENV` | Secret variable |
| -------- | ----------- | --------------- |
| Test institutions only | `sandbox` | `SANDBOX_PLAID_SECRET` |
| Live banks (after Production approval) | `production` | `PROD_PLAID_SECRET` |

Also copy **Client ID** into `PLAID_CLIENT_ID`.

The usual Link failure is using the Production secret while `PLAID_ENV=sandbox` (or the reverse). The secret must match `PLAID_ENV`. See `getPlaidSecret` in `src/config.ts`.

## 4. Redirect URIs (OAuth banks)

Some institutions use OAuth and need an allowed redirect URI in the Dashboard (API → allowed redirect URIs).

For local use, add the origin you actually open, for example:

- `http://127.0.0.1:3000/`
- `http://localhost:3000/` (only if you browse via `localhost`)

If you set `PLAID_REDIRECT_URI` in `.env.local` to that same URL, the app sends it on link-token create. Leave it unset if you are only using Sandbox test institutions that do not need OAuth.

Restart the server after changing `.env.local`.

## 5. First Link

1. `npm run init` (Sandbox is the default path) or copy `.env.example` and fill Sandbox values.
2. `npm run dev` and open the printed URL.
3. Open the **Setup** tab. Plaid should show as configured.
4. **Connect with Plaid** and pick a Sandbox test institution.
5. After accounts appear, use **Refresh saved sessions**.

LLM keys are not required for this path.

## Production (live institutions)

When Plaid has approved Production for your account:

1. Set `PLAID_ENV=production` and `PROD_PLAID_SECRET`.
2. Keep `PLAID_CLIENT_ID` the same unless you created a new app.
3. Restart, then Link again (or update consent) for live institutions.

Production is **not** the first-run path for a brand-new Plaid account.
