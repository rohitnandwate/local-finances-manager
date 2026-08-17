# Plaid (Sandbox testing — optional)

**New to Plaid?** Start here before Production.

The [README](../../README.md) defaults to **Production** (`PLAID_ENV=production`, `PROD_PLAID_SECRET`) for live institutions. Use **Sandbox** when you want test institutions only:

- Set `PLAID_ENV=sandbox` and `SANDBOX_PLAID_SECRET` in `.env.local` (see `src/config.ts`).
- Plaid: [Sandbox environment](https://plaid.com/docs/sandbox/).

**Quick Sandbox keys:** Dashboard → **Keys** → use the **Sandbox** secret (not Production).

**Products / country** should match your Dashboard app (this repo’s defaults are **US** + **transactions** in `.env.example`).

**Link issues:** wrong secret for the active `PLAID_ENV` is the usual fix; see `getPlaidSecret` in `src/config.ts`.
