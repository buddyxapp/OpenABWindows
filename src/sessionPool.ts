/**
 * Session Pool — per-thread ACP sessions with LRU eviction.
 * Ported from OpenAB's pool.rs.
 */
import { createAcpBackend, type AcpBackend } from './acpBackend.js';
import type { PoolConfig } from './config.js';
import { logger } from './logger.js';

interface PoolEntry {
  backend: AcpBackend;
  lastUsed: number;
}

export interface SessionPool {
  getOrCreate(threadKey: string, cwd: string): Promise<AcpBackend>;
  release(threadKey: string): void;
  stopAll(): void;
}

export function createSessionPool(
  command: string, args: string[], workingDir: string,
  extraEnv: Record<string, string>, poolConfig: PoolConfig,
): SessionPool {
  const sessions = new Map<string, PoolEntry>();
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function startCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      const ttlMs = poolConfig.sessionTtlHours * 3600000;
      for (const [key, entry] of sessions) {
        if (now - entry.lastUsed > ttlMs) {
          logger.info('Evicting idle session', { key });
          entry.backend.stop();
          sessions.delete(key);
        }
      }
    }, 60000);
  }

  function evictLRU() {
    if (sessions.size < poolConfig.maxSessions) return;
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of sessions) {
      if (entry.lastUsed < oldestTime) { oldest = key; oldestTime = entry.lastUsed; }
    }
    if (oldest) {
      logger.info('Evicting LRU session', { key: oldest });
      sessions.get(oldest)!.backend.stop();
      sessions.delete(oldest);
    }
  }

  startCleanup();

  return {
    async getOrCreate(threadKey: string, cwd: string): Promise<AcpBackend> {
      const existing = sessions.get(threadKey);
      if (existing && existing.backend.isAlive()) {
        existing.lastUsed = Date.now();
        return existing.backend;
      }

      // Clean up dead entry
      if (existing) sessions.delete(threadKey);

      evictLRU();

      const backend = createAcpBackend(command, args, workingDir, extraEnv);
      await backend.start();
      await backend.sessionNew(cwd);

      sessions.set(threadKey, { backend, lastUsed: Date.now() });
      logger.info('Pool: new session', { key: threadKey, total: sessions.size });
      return backend;
    },

    release(threadKey: string) {
      const entry = sessions.get(threadKey);
      if (entry) {
        entry.backend.stop();
        sessions.delete(threadKey);
      }
    },

    stopAll() {
      if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
      for (const [, entry] of sessions) entry.backend.stop();
      sessions.clear();
      logger.info('Pool: all sessions stopped');
    },
  };
}
