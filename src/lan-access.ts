import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config, isLanAccessEnabled } from "./config.js";

const COOKIE_NAME = "budget_lan_auth";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30;
const DERIVE_PEPPER = "budget-expense-tracker:lan-auth-v1";
const SESSION_LABEL = "lan-http-cookie-v1";

function getSigningKey(): Buffer {
  if (!config.lanAccessCode) {
    throw new Error("LAN access is not configured");
  }
  if (config.lanAuthSecret) {
    return Buffer.from(config.lanAuthSecret, "utf8");
  }
  return createHmac("sha256", DERIVE_PEPPER)
    .update(config.lanAccessCode, "utf8")
    .digest();
}

function getExpectedSessionCookieValue(): string {
  const key = getSigningKey();
  return createHmac("sha256", key).update(SESSION_LABEL).digest("base64url");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep raw */
    }
    out[k] = v;
  }
  return out;
}

function timingSafeEqualString(a: string, b: string): boolean {
  try {
    const aa = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (aa.length !== bb.length) {
      return false;
    }
    return timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function hasValidBearer(request: Request): boolean {
  const raw = request.headers.authorization;
  if (!raw || typeof raw !== "string") {
    return false;
  }
  const m = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  if (!m) {
    return false;
  }
  return timingSafeEqualString(m[1], config.lanAccessCode);
}

function hasValidCookie(request: Request): boolean {
  const cookies = parseCookies(request.headers.cookie);
  const got = cookies[COOKIE_NAME];
  if (!got) {
    return false;
  }
  const expected = getExpectedSessionCookieValue();
  try {
    const a = Buffer.from(got, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function isAuthenticated(request: Request): boolean {
  return hasValidCookie(request) || hasValidBearer(request);
}

function isExemptPath(path: string, method: string): boolean {
  if (path === "/login.html" && method === "GET") {
    return true;
  }
  if (path === "/api/auth/lan" && method === "POST") {
    return true;
  }
  return false;
}

/**
 * When `LAN_ACCESS_CODE` is set, require session cookie or Bearer token before
 * static files and API routes (except login and POST /api/auth/lan).
 */
export function lanAccessMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!isLanAccessEnabled()) {
    next();
    return;
  }

  const path = request.path;
  const method = request.method.toUpperCase();

  if (isExemptPath(path, method)) {
    next();
    return;
  }

  if (isAuthenticated(request)) {
    next();
    return;
  }

  if (path.startsWith("/api/")) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (method === "GET" || method === "HEAD") {
    response.redirect(302, "/login.html");
    return;
  }

  response.status(401).json({ error: "Unauthorized" });
}

export function handleLanLogin(request: Request, response: Response): void {
  if (!isLanAccessEnabled()) {
    response.status(400).json({
      error: "LAN access gate is not enabled (LAN_ACCESS_CODE is unset).",
    });
    return;
  }

  const body = request.body as { code?: unknown };
  const code = typeof body?.code === "string" ? body.code : "";
  if (!timingSafeEqualString(code, config.lanAccessCode)) {
    response.status(401).json({ error: "Invalid access code." });
    return;
  }

  const token = getExpectedSessionCookieValue();
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SEC}`,
  ].join("; ");

  response.setHeader("Set-Cookie", attrs);
  response.json({ ok: true });
}
