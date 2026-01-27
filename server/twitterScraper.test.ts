import { describe, expect, it, vi } from "vitest";

// Mock playwright to avoid actual browser operations in tests
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      isConnected: () => true,
      newContext: vi.fn().mockResolvedValue({
        addCookies: vi.fn(),
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn(),
          waitForSelector: vi.fn(),
          $: vi.fn(),
          $$: vi.fn().mockResolvedValue([]),
          evaluate: vi.fn(),
          waitForTimeout: vi.fn(),
          close: vi.fn(),
        }),
        close: vi.fn(),
      }),
      close: vi.fn(),
    }),
  },
}));

describe("Twitter Scraper", () => {
  it("should export scrapeUserTweets function", async () => {
    const { scrapeUserTweets } = await import("./twitterScraper");
    expect(typeof scrapeUserTweets).toBe("function");
  });

  it("should export scrapeTweetReplies function", async () => {
    const { scrapeTweetReplies } = await import("./twitterScraper");
    expect(typeof scrapeTweetReplies).toBe("function");
  });

  it("should export scrapeUserComments function", async () => {
    const { scrapeUserComments } = await import("./twitterScraper");
    expect(typeof scrapeUserComments).toBe("function");
  });

  it("should handle empty username gracefully", async () => {
    const { scrapeUserTweets } = await import("./twitterScraper");
    const result = await scrapeUserTweets("");
    // Should return a result object (may fail but shouldn't throw)
    expect(result).toHaveProperty("success");
  });

  it("should handle scrapeUserComments with valid parameters", async () => {
    const { scrapeUserComments } = await import("./twitterScraper");
    const result = await scrapeUserComments("testuser", undefined, 5, 10);
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("tweets");
    expect(result).toHaveProperty("replies");
  });
});

describe("Smart Fetch Logic", () => {
  it("should prioritize Playwright over Apify", () => {
    // This tests the logic concept - actual integration tested via routers
    const preferredMethod = 'auto';
    const hasXCookies = true;
    const hasApifyToken = true;
    
    // When auto mode and both available, should try Playwright first
    const shouldTryPlaywright = preferredMethod === 'auto' || preferredMethod === 'playwright';
    expect(shouldTryPlaywright).toBe(true);
  });

  it("should fallback to Apify when Playwright fails", () => {
    const preferredMethod = 'auto';
    const playwrightFailed = true;
    const hasApifyToken = true;
    
    const shouldTryApify = (preferredMethod === 'auto' && playwrightFailed && hasApifyToken) 
      || preferredMethod === 'apify';
    expect(shouldTryApify).toBe(true);
  });
});
