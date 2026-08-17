import { execFileSync } from "node:child_process";
import { config } from "./config.js";

export type WifiBindSnapshot = {
  gating: "off" | "bypass" | "active" | "unavailable";
  currentSsid: string | null;
  effectiveHost: string;
  requestedHost: string;
  detail: string;
  allowlistEnabled: boolean;
};

let lastSnapshot: WifiBindSnapshot = {
  gating: "unavailable",
  currentSsid: null,
  effectiveHost: "127.0.0.1",
  requestedHost: "127.0.0.1",
  detail: "not initialized",
  allowlistEnabled: false,
};

export function getWifiBindSnapshot(): WifiBindSnapshot {
  return { ...lastSnapshot };
}

function normalizeRequestHost(h: string): string {
  const t = h.trim();
  if (t === "localhost" || t === "::1") {
    return "127.0.0.1";
  }
  return t;
}

/**
 * Resolves the Wi-Fi interface (e.g. en0) on macOS. Returns null if not found.
 */
function findMacWifiDevice(): string | null {
  try {
    const out = execFileSync("/usr/sbin/networksetup", ["-listallhardwareports"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
    });
    const lines = out.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.trim() === "Hardware Port: Wi-Fi" || /Hardware Port: AirPort$/.test(line.trim())) {
        const next = lines[i + 1] ?? "";
        const m = next.match(/^Device: (en\d+)/);
        if (m) {
          return m[1];
        }
      }
    }
  } catch {
    /* networksetup failed */
  }
  return null;
}

/**
 * Returns the current Wi‑Fi SSID on macOS, or null if off / disassociated / unknown.
 * On non-Apple OS, always returns null (caller should use disableWifiGating in CI).
 */
export function getCurrentWifiSsid(): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  try {
    const dev = findMacWifiDevice() ?? "en0";
    const out = execFileSync("/usr/sbin/networksetup", ["-getairportnetwork", dev], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    }).trim();
    if (
      /not associated|AirPort is off|not connected to Wi|Could not find|Error:/i.test(out)
    ) {
      return null;
    }
    const m = /Current (?:Wi[- ]Fi )?Network:\s*(.+)/i.exec(out);
    if (m) {
      return m[1].trim() || null;
    }
  } catch {
    /* getairportnetwork failed */
  }
  return null;
}

/**
 * Chooses 127.0.0.1 vs 0.0.0.0 (or other requested bind) from env + current SSID.
 */
export function resolveListenHost(currentSsid: string | null): {
  host: string;
  snapshot: WifiBindSnapshot;
  logLines: string[];
} {
  const requested = normalizeRequestHost(config.host);
  const logLines: string[] = [];
  const allowlist = config.lanAllowedWifiSsids;
  const allowlistEnabled = allowlist.length > 0;
  const ssidLower = currentSsid ? currentSsid.toLowerCase() : null;
  const onAllowlist = Boolean(
    ssidLower && allowlist.includes(ssidLower),
  );

  if (config.disableWifiGating) {
    lastSnapshot = {
      gating: "bypass",
      currentSsid: currentSsid,
      effectiveHost: requested,
      requestedHost: requested,
      detail: "BUDGET_TRACKER_DISABLE_WIFI_GATING is set; SSID gating skipped.",
      allowlistEnabled,
    };
    if (allowlistEnabled) {
      logLines.push("[server] Wi‑Fi: gating bypassed via BUDGET_TRACKER_DISABLE_WIFI_GATING.");
    }
    return { host: requested, snapshot: lastSnapshot, logLines };
  }

  if (!allowlistEnabled) {
    lastSnapshot = {
      gating: "off",
      currentSsid: currentSsid,
      effectiveHost: requested,
      requestedHost: requested,
      detail: "No LAN_ALLOWED_WIFI_SSIDS; HOST applied as requested.",
      allowlistEnabled: false,
    };
    return { host: requested, snapshot: lastSnapshot, logLines };
  }

  if (currentSsid === null || !onAllowlist) {
    const when =
      currentSsid === null
        ? "not on a resolved Wi‑Fi network (or SSID unknown)"
        : `on SSID "${currentSsid}" (not in allowlist)`;
    const detail = `Allowlist is active: ${when}; LAN bind disabled (using 127.0.0.1).`;
    lastSnapshot = {
      gating: "active",
      currentSsid,
      effectiveHost: "127.0.0.1",
      requestedHost: requested,
      detail,
      allowlistEnabled: true,
    };
    if (requested === "0.0.0.0") {
      logLines.push(`[server] Wi‑Fi: ${detail}`);
    }
    return { host: "127.0.0.1", snapshot: lastSnapshot, logLines };
  }

  if (requested !== "0.0.0.0") {
    lastSnapshot = {
      gating: "active",
      currentSsid,
      effectiveHost: requested,
      requestedHost: requested,
      detail: "On allowlisted Wi‑Fi; using HOST as requested.",
      allowlistEnabled: true,
    };
    return { host: requested, snapshot: lastSnapshot, logLines };
  }

  const detail = `On allowlisted SSID "${currentSsid}"; binding 0.0.0.0.`;
  lastSnapshot = {
    gating: "active",
    currentSsid,
    effectiveHost: "0.0.0.0",
    requestedHost: requested,
    detail,
    allowlistEnabled: true,
  };
  logLines.push(`[server] Wi‑Fi: ${detail}`);
  return { host: "0.0.0.0", snapshot: lastSnapshot, logLines };
}
