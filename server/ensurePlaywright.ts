/**
 * Browser status for deployment (Puppeteer + @sparticuz/chromium).
 * No install step needed — @sparticuz/chromium bundles everything.
 */

export type PlaywrightStatus = "unknown" | "checking" | "installing" | "ready" | "failed";

export function startPlaywrightSetup(): void {
  // No-op: @sparticuz/chromium needs no background install
}

export async function ensurePlaywrightChromium(): Promise<boolean> {
  return true;
}

export function getPlaywrightStatus(): { status: PlaywrightStatus; message: string } {
  return {
    status: "ready",
    message: "浏览器由 @sparticuz/chromium 提供，无需安装",
  };
}
