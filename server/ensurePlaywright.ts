import { execSync } from "child_process";
import fs from "fs";
import path from "path";

let playwrightReady = false;
let playwrightChecked = false;
let installPromise: Promise<boolean> | null = null;

/**
 * Check if Playwright Chromium browser is installed and available.
 * If not, attempt to install it automatically.
 * Returns true if Chromium is ready, false otherwise.
 */
export async function ensurePlaywrightChromium(): Promise<boolean> {
  // Already verified as ready
  if (playwrightReady) return true;

  // If an install is already in progress, wait for it
  if (installPromise) return installPromise;

  installPromise = doEnsure();
  const result = await installPromise;
  installPromise = null;
  return result;
}

async function doEnsure(): Promise<boolean> {
  // Step 1: Check if chromium is already available
  if (isChromiumInstalled()) {
    console.log("[Playwright] Chromium browser is already installed and ready.");
    playwrightReady = true;
    playwrightChecked = true;
    return true;
  }

  console.log("[Playwright] Chromium browser not found. Attempting automatic installation...");

  // Step 2: Try to install chromium
  try {
    console.log("[Playwright] Running: npx playwright install chromium --with-deps");
    execSync("npx playwright install chromium --with-deps", {
      stdio: "pipe",
      timeout: 180000, // 3 minutes timeout
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: undefined }, // use default path
    });
    console.log("[Playwright] Chromium installation completed successfully.");

    // Verify installation
    if (isChromiumInstalled()) {
      playwrightReady = true;
      playwrightChecked = true;
      return true;
    }
  } catch (err: any) {
    console.error("[Playwright] Installation with --with-deps failed:", err.message);
  }

  // Step 3: Try without --with-deps (some environments don't support apt)
  try {
    console.log("[Playwright] Retrying: npx playwright install chromium");
    execSync("npx playwright install chromium", {
      stdio: "pipe",
      timeout: 180000,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: undefined },
    });
    console.log("[Playwright] Chromium installation (without deps) completed.");

    if (isChromiumInstalled()) {
      playwrightReady = true;
      playwrightChecked = true;
      return true;
    }
  } catch (err: any) {
    console.error("[Playwright] Installation without deps also failed:", err.message);
  }

  playwrightChecked = true;
  console.error("[Playwright] Could not install Chromium. Playwright scraping will not be available.");
  return false;
}

function isChromiumInstalled(): boolean {
  try {
    // Use playwright CLI to check browser status
    const output = execSync("npx playwright install --dry-run chromium 2>&1 || true", {
      stdio: "pipe",
      timeout: 15000,
    }).toString();

    // If dry-run says nothing to install, it's already there
    if (output.includes("already installed") || output.includes("is already")) {
      return true;
    }

    // Alternative: try to find the chromium executable directly
    const possiblePaths = [
      path.join(process.env.HOME || "/root", ".cache/ms-playwright"),
      "/root/.cache/ms-playwright",
      "/home/ubuntu/.cache/ms-playwright",
    ];

    for (const basePath of possiblePaths) {
      if (!fs.existsSync(basePath)) continue;
      const entries = fs.readdirSync(basePath);
      for (const entry of entries) {
        if (entry.startsWith("chromium")) {
          // Found a chromium directory, check if executable exists
          const chromiumDir = path.join(basePath, entry);
          if (fs.existsSync(chromiumDir) && fs.statSync(chromiumDir).isDirectory()) {
            // Look for chrome or chrome-headless-shell executable
            const files = getAllFiles(chromiumDir);
            const hasExecutable = files.some(
              (f) =>
                f.endsWith("/chrome") ||
                f.endsWith("/chrome-headless-shell") ||
                f.endsWith("/chromium")
            );
            if (hasExecutable) return true;
          }
        }
      }
    }

    return false;
  } catch {
    return false;
  }
}

function getAllFiles(dir: string, depth = 0): string[] {
  if (depth > 4) return []; // Don't recurse too deep
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...getAllFiles(fullPath, depth + 1));
      } else {
        results.push(fullPath);
      }
    }
  } catch {
    // Ignore permission errors
  }
  return results;
}

/** Returns whether Playwright has been checked (regardless of result) */
export function isPlaywrightChecked(): boolean {
  return playwrightChecked;
}

/** Returns whether Playwright Chromium is confirmed ready */
export function isPlaywrightReady(): boolean {
  return playwrightReady;
}
