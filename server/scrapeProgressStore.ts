import type { ScrapeProgress } from "./twitterScraper";

type StoredProgress = {
  progress: ScrapeProgress;
  updatedAt: number;
};

// In-memory progress store (dev/local usage).
// Keyed by username because UI采集同一时间通常只跑一个账号。
const progressByUsername = new Map<string, StoredProgress>();

export function setScrapeProgress(username: string, progress: ScrapeProgress) {
  const prev = progressByUsername.get(username)?.progress;
  // 同一任务下「已采集条数」只增不减，避免前端显示 36→15→22 乱跳
  if (prev && typeof prev.repliesFound === 'number' && typeof progress.repliesFound === 'number' && progress.repliesFound < prev.repliesFound) {
    progress = { ...progress, repliesFound: prev.repliesFound };
  }
  progressByUsername.set(username, { progress, updatedAt: Date.now() });
}

export function getScrapeProgress(username: string): ScrapeProgress | null {
  return progressByUsername.get(username)?.progress ?? null;
}

export function clearScrapeProgress(username: string) {
  progressByUsername.delete(username);
}

