import { execSync } from "child_process";
import fs from "fs";
import path from "path";

type PlaywrightStatus = "unknown" | "checking" | "installing" | "ready" | "failed";

let status: PlaywrightStatus = "unknown";
let statusMessage = "";

/**
 * Start background installation of Playwright Chromium.
 * Call this once at server startup — it returns immediately and installs in the background.
 */
export function startPlaywrightSetup(): void {
  if (status === "ready" || status === "installing" || status === "checking") return;

  status = "checking";
  statusMessage = "正在检查 Chromium 浏览器...";

  // Run the check + install asynchronously
  doSetup().catch((err) => {
    console.error("[Playwright Setup] Unexpected error:", err);
    status = "failed";
    statusMessage = `安装异常: ${String(err)}`;
  });
}

async function doSetup(): Promise<void> {
  // Step 1: Check system Chromium first
  const systemChromium = findSystemChromium();
  if (systemChromium) {
    console.log(`[Playwright Setup] System Chromium found at: ${systemChromium}`);
    status = "ready";
    statusMessage = `系统 Chromium 已就绪 (${systemChromium})`;
    return;
  }

  // Step 2: Check Playwright's own Chromium
  if (findPlaywrightChromium()) {
    console.log("[Playwright Setup] Playwright Chromium is already installed.");
    status = "ready";
    statusMessage = "Playwright Chromium 已就绪";
    return;
  }

  // Step 3: No Chromium found anywhere
  console.log("[Playwright Setup] No Chromium found. Playwright will attempt to use its default.");
  status = "ready";
  statusMessage = "将使用 Playwright 默认浏览器";
}

function findSystemChromium(): string | null {
  const candidates = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/lib/chromium-browser/chromium-browser',
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  // Try `which` command
  try {
    const result = execSync('which chromium-browser chromium google-chrome 2>/dev/null', { encoding: 'utf8' }).trim();
    const firstLine = result.split('\n')[0]?.trim();
    if (firstLine) return firstLine;
  } catch {
    // not found
  }

  return null;
}

function findPlaywrightChromium(): string | null {
  const possibleBases = [
    path.join(process.env.HOME || "/root", ".cache/ms-playwright"),
    "/root/.cache/ms-playwright",
    "/home/ubuntu/.cache/ms-playwright",
  ];

  for (const basePath of possibleBases) {
    if (!fs.existsSync(basePath)) continue;
    try {
      const entries = fs.readdirSync(basePath);
      for (const entry of entries) {
        if (!entry.startsWith("chromium")) continue;
        const chromiumDir = path.join(basePath, entry);
        if (!fs.statSync(chromiumDir).isDirectory()) continue;
        const executable = findExecutableIn(chromiumDir, 0);
        if (executable) return executable;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function findExecutableIn(dir: string, depth: number): string | null {
  if (depth > 5) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findExecutableIn(fullPath, depth + 1);
        if (found) return found;
      } else if (
        entry.name === "chrome" ||
        entry.name === "chrome-headless-shell" ||
        entry.name === "chromium"
      ) {
        return fullPath;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Ensure Chromium is ready before launching browser.
 * If still installing, waits up to 3 minutes.
 * Returns true if ready, false otherwise.
 */
export async function ensurePlaywrightChromium(): Promise<boolean> {
  // If we haven't started setup yet, start it now
  if (status === "unknown") {
    startPlaywrightSetup();
  }

  // If already ready
  if (status === "ready") return true;

  // If failed, try one more time
  if (status === "failed") {
    status = "unknown";
    startPlaywrightSetup();
  }

  // Wait for installation to complete (up to 4 minutes)
  const maxWait = 4 * 60 * 1000;
  const interval = 2000;
  let waited = 0;

  while (waited < maxWait) {
    if (getStatus() === "ready") return true;
    if (getStatus() === "failed") return false;
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
  }

  return getStatus() === "ready";
}

/** Helper to get current status (avoids TS narrowing issues with module-level vars) */
function getStatus(): PlaywrightStatus {
  return status;
}

/** Get current Playwright setup status for API responses */
export function getPlaywrightStatus(): { status: PlaywrightStatus; message: string } {
  return { status, message: statusMessage };
}
