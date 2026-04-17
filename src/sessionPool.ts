/**
 * Session Pool — per-thread ACP sessions with LRU eviction + suspend/resume.
 * Ported from OpenAB's pool.rs. Uses session/load for resumption.
 */
import { createAcpBackend, type AcpBackend } from './acpBackend.js';
import type { PoolConfig } from './config.js';
import { logger } from './logger.js';

interface PoolEntry {
  backend: AcpBackend;
  sessionId: string;
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
  const active = new Map<string, PoolEntry>();
  const suspended = new Map<string, string>(); // threadKey → sessionId
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function startCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      const ttlMs = poolConfig.sessionTtlHours * 3600000;
      for (const [key, entry] of active) {
        if (now - entry.lastUsed > ttlMs) {
          logger.info('Evicting idle session', { key });
          // Suspend instead of kill — save sessionId for later resume
          suspended.set(key, entry.sessionId);
          entry.backend.stop();
          active.delete(key);
        }
      }
      // Also expire very old suspended sessions
      if (suspended.size > poolConfig.maxSessions * 2) {
        const keys = [...suspended.keys()];
        for (let i = 0; i < keys.length - poolConfig.maxSessions; i++) {
          suspended.delete(keys[i]);
        }
      }
    }, 60000);
  }

  function evictLRU() {
    if (active.size < poolConfig.maxSessions) return;
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of active) {
      if (entry.lastUsed < oldestTime) { oldest = key; oldestTime = entry.lastUsed; }
    }
    if (oldest) {
      const entry = active.get(oldest)!;
      logger.info('Suspending LRU session', { key: oldest, sessionId: entry.sessionId });
      suspended.set(oldest, entry.sessionId);
      entry.backend.stop();
      active.delete(oldest);
    }
  }

  startCleanup();

  return {
    async getOrCreate(threadKey: string, cwd: string): Promise<AcpBackend> {
      // Return existing active session
      const existing = active.get(threadKey);
      if (existing && existing.backend.isAlive()) {
        existing.lastUsed = Date.now();
        return existing.backend;
      }
      if (existing) active.delete(threadKey);

      evictLRU();

      const backend = createAcpBackend(command, args, workingDir, extraEnv);
      await backend.start();

      // Try to resume suspended session
      const suspendedId = suspended.get(threadKey);
      let sessionId: string;
      if (suspendedId) {
        try {
          await backend.sessionLoad(suspendedId, cwd);
          sessionId = suspendedId;
          suspended.delete(threadKey);
          logger.info('Pool: resumed session', { key: threadKey, sessionId });
        } catch {
          // Resume failed, create new
          sessionId = await backend.sessionNew(cwd);
          suspended.delete(threadKey);
          logger.info('Pool: resume failed, new session', { key: threadKey, sessionId });
        }
      } else {
        sessionId = await backend.sessionNew(cwd);
        logger.info('Pool: new session', { key: threadKey, sessionId });
      }

      active.set(threadKey, { backend, sessionId, lastUsed: Date.now() });
      logger.info('Pool: active sessions', { total: active.size, suspended: suspended.size });
      return backend;
    },

    release(threadKey: string) {
      const entry = active.get(threadKey);
      if (entry) {
        entry.backend.stop();
        active.delete(threadKey);
      }
      suspended.delete(threadKey);
    },

    stopAll() {
      if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
      for (const [, entry] of active) entry.backend.stop();
      active.clear();
      suspended.clear();
      logger.info('Pool: all sessions stopped');
    },
  };
}
