import { config as loadEnv } from "dotenv";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

loadEnv({ path: ".env.local" });
loadEnv();

type PlaidEnvironment = "sandbox" | "development" | "production";
export type LlmProvider = "openai" | "anthropic" | "google";

const ALLOWED_ENVIRONMENTS = new Set<PlaidEnvironment>([
  "sandbox",
  "development",
  "production",
]);

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) {
    return fallback;
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseEnvironment(raw: string | undefined): PlaidEnvironment {
  if (raw && ALLOWED_ENVIRONMENTS.has(raw as PlaidEnvironment)) {
    return raw as PlaidEnvironment;
  }

  return "production";
}

function parseDaysRequested(raw: string | undefined): number {
  if (!raw) {
    return 730;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 730;
  }

  return Math.min(730, Math.max(1, Math.floor(parsed)));
}

function getPlaidSecret(environment: PlaidEnvironment): string {
  if (environment === "production") {
    return process.env.PROD_PLAID_SECRET ?? process.env.PLAID_SECRET ?? "";
  }

  if (environment === "sandbox") {
    return process.env.SANDBOX_PLAID_SECRET ?? process.env.PLAID_SECRET ?? "";
  }

  return process.env.DEV_PLAID_SECRET ?? process.env.PLAID_SECRET ?? "";
}

const plaidEnvironment = parseEnvironment(process.env.PLAID_ENV);

const VALID_LLM_PROVIDERS = new Set<LlmProvider>(["openai", "anthropic", "google"]);

function parseLlmProvider(raw: string | undefined): LlmProvider {
  const value = raw?.trim().toLowerCase();
  if (value && VALID_LLM_PROVIDERS.has(value as LlmProvider)) {
    return value as LlmProvider;
  }
  if (value) {
    console.warn(
      `[config] Unknown LLM_PROVIDER "${raw}" — falling back to "openai". Valid values: ${[...VALID_LLM_PROVIDERS].join(", ")}`,
    );
  }
  return "openai";
}

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-2.0-flash",
};

const llmProvider = parseLlmProvider(process.env.LLM_PROVIDER);

/**
 * LAN access gate. When `lanAccessCode` is non-empty, browsers must present a
 * session cookie (via POST /api/auth/lan) or scripts may send
 * `Authorization: Bearer <LAN_ACCESS_CODE>`.
 *
 * For Wi‑Fi access from other devices, set `HOST=0.0.0.0` in `.env.local` **and**
 * (unless `BUDGET_TRACKER_DISABLE_WIFI_GATING=1`) set both `LAN_ACCESS_CODE` and
 * `LAN_ALLOWED_WIFI_SSIDS` — see `assertLanWifiRequirementsMet()`.
 *
 * `lanAuthSecret` is optional; if unset, a key is derived from the access code
 * (rotating the code invalidates existing sessions).
 */
const lanAccessCode = (process.env.LAN_ACCESS_CODE ?? "").trim();
const lanAuthSecret = (process.env.LAN_AUTH_SECRET ?? "").trim();

/**
 * Comma-separated Wi‑Fi network names; case-insensitive match on macOS.
 * When non-empty with Wi‑Fi gating on, the server only binds 0.0.0.0 on those SSIDs;
 * otherwise it uses 127.0.0.1. Required together with `LAN_ACCESS_CODE` when `HOST=0.0.0.0`
 * and gating is not disabled. Set `BUDGET_TRACKER_DISABLE_WIFI_GATING=1` in CI (Linux)
 * or for debugging.
 */
const lanAllowedWifiSsids = parseList(
  (process.env.LAN_ALLOWED_WIFI_SSIDS ?? "").toLowerCase(),
  [],
);
const rawWifiCheck = Number(process.env.LAN_WIFI_CHECK_INTERVAL_SEC ?? "45");
const lanWifiCheckIntervalSec =
  Number.isFinite(rawWifiCheck) && rawWifiCheck > 0
    ? Math.min(300, Math.max(15, Math.floor(rawWifiCheck)))
    : 45;
const disableWifiGating = ["1", "true", "yes"].includes(
  (process.env.BUDGET_TRACKER_DISABLE_WIFI_GATING ?? "").toLowerCase(),
);

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? "3000"),
  debugFiles: process.env.DEBUG_FILES === "true",
  lanAccessCode,
  lanAuthSecret,
  lanAllowedWifiSsids,
  lanWifiCheckIntervalSec,
  disableWifiGating,
  plaid: {
    clientId: process.env.PLAID_CLIENT_ID ?? "",
    secret: getPlaidSecret(plaidEnvironment),
    environment: plaidEnvironment,
    countryCodes: parseList(process.env.PLAID_COUNTRY_CODES, ["US"]),
    products: parseList(process.env.PLAID_PRODUCTS, ["transactions"]),
    daysRequested: parseDaysRequested(process.env.PLAID_DAYS_REQUESTED),
    redirectUri: (process.env.PLAID_REDIRECT_URI ?? "").trim(),
  },
  llm: {
    provider: llmProvider,
    model: process.env.LLM_MODEL ?? DEFAULT_MODELS[llmProvider],
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
  },
};

export function isLanAccessEnabled(): boolean {
  return config.lanAccessCode.length > 0;
}

function normalizeBindHost(h: string): string {
  const t = h.trim();
  if (t === "localhost" || t === "::1") {
    return "127.0.0.1";
  }
  return t;
}

/**
 * When binding on all interfaces (`HOST=0.0.0.0`) with Wi‑Fi gating enabled,
 * require both `LAN_ACCESS_CODE` and a non-empty `LAN_ALLOWED_WIFI_SSIDS`.
 * Call once at process startup before listening.
 */
export function assertLanWifiRequirementsMet(): void {
  if (config.disableWifiGating) {
    return;
  }
  if (normalizeBindHost(config.host) !== "0.0.0.0") {
    return;
  }
  const missing: string[] = [];
  if (!config.lanAccessCode) {
    missing.push("LAN_ACCESS_CODE");
  }
  if (config.lanAllowedWifiSsids.length === 0) {
    missing.push("LAN_ALLOWED_WIFI_SSIDS");
  }
  if (missing.length === 0) {
    return;
  }
  console.error(
    `[config] HOST=0.0.0.0 requires ${missing.join(" and ")}. ` +
      `Set both in .env.local for LAN access, use HOST=127.0.0.1 only, or set ` +
      `BUDGET_TRACKER_DISABLE_WIFI_GATING=1 (e.g. CI/Linux).`,
  );
  process.exit(1);
}

export function isPlaidConfigured(): boolean {
  return Boolean(config.plaid.clientId && config.plaid.secret);
}

export function assertPlaidConfigured(): void {
  if (!isPlaidConfigured()) {
    throw new Error(
      "Missing Plaid credentials. Set PLAID_CLIENT_ID and the environment-specific Plaid secret in .env.local or .env.",
    );
  }
}

function getActiveApiKey(): string {
  switch (config.llm.provider) {
    case "openai":
      return config.llm.openaiApiKey;
    case "anthropic":
      return config.llm.anthropicApiKey;
    case "google":
      return config.llm.googleApiKey;
  }
}

export function isLlmConfigured(): boolean {
  return Boolean(getActiveApiKey());
}

export function validateLlmConfig(): void {
  const provider = config.llm.provider;
  const model = config.llm.model;
  const hasKey = Boolean(getActiveApiKey());

  if (!hasKey) {
    console.warn(
      `[config] LLM provider "${provider}" selected but no API key set. ` +
        `LLM-assisted category review and Financial Intelligence (briefings / chat) will be unavailable until you set the key.`,
    );
  }

  if (!model) {
    console.warn(
      `[config] LLM_MODEL is empty. Defaulting to "${DEFAULT_MODELS[provider]}".`,
    );
  }

  console.log(`[config] LLM: provider=${provider} model=${model} key=${hasKey ? "set" : "MISSING"}`);
}

export function getLlmModel() {
  const modelId = config.llm.model;
  switch (config.llm.provider) {
    case "openai":
      return createOpenAI({ apiKey: config.llm.openaiApiKey })(modelId);
    case "anthropic":
      return createAnthropic({ apiKey: config.llm.anthropicApiKey })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: config.llm.googleApiKey })(modelId);
    default:
      throw new Error(`Unsupported LLM provider: ${config.llm.provider}`);
  }
}
