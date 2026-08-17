import { readFile } from "node:fs/promises";
import path from "node:path";

const CONTEXT_DIR = path.resolve("context");
const CONTEXT_FILE = "personal-context.yml";

let cachedContext: string | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

/**
 * Load personal-context.yml and return its raw contents as a string.
 * Returns null if the file doesn't exist (graceful degradation).
 * Caches for 30s to avoid re-reading on every LLM call.
 */
export async function loadPersonalContext(): Promise<string | null> {
  if (cachedContext !== null && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedContext;
  }

  const filePath = path.join(CONTEXT_DIR, CONTEXT_FILE);
  try {
    const raw = await readFile(filePath, "utf-8");
    cachedContext = raw.trim();
    cachedAt = Date.now();
    console.log(
      `[context] Loaded personal context (${cachedContext.length} chars)`,
    );
    return cachedContext;
  } catch {
    cachedContext = null;
    cachedAt = Date.now();
    return null;
  }
}

/**
 * Format personal context for inclusion in an LLM system prompt.
 * Returns empty string if no context file exists.
 */
export async function getPersonalContextBlock(): Promise<string> {
  const context = await loadPersonalContext();
  if (!context) return "";

  return `
## Personal & Family Financial Context

The following is background information about the user's household, goals, and financial situation. Use this to make your analysis more relevant and personalized. Reference specific goals or budget rules when applicable.

\`\`\`yaml
${context}
\`\`\`
`;
}
