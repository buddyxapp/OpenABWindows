/**
 * Session Pool — per-thread ACP sessions with LRU eviction + suspend/resume.
 * Synced with OpenAB v0.8.3: stale session recovery, pending prompt cleanup.
 */
import { createAcpBackend, type AcpBackend } from './acpBackend.js';
import type { PoolConfig } from './config.js';
import type { ConfigOption } from './acpProtocol.js';
import { logger } from './logger.js';

interface PoolEntry {
  backend: AcpBackend;
  sessionId: string;
  lastUsed: number;
  promptPending: boolean;
}

export interface SessionPool {
  getOrCreate(threadKey: string, cwd: string): Promise<AcpBackend>;
  release(threadKey: string): void;
  stopAll(): void;
  getConfigOptions(threadKey: string): ConfigOption[];
  setConfigOption(threadKey: string, configId: string, value: string): Promise<ConfigOption[]>;
}

export function createSessionPool(
  command: string, args: string[], workingDir: string,
  extraEnv: Record<string, string>, poolConfig: PoolConfig,
): SessionPool {
  const active = new Map<string, PoolEntry>();
  const suspended = new Map<string, string>();
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function startCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      const ttlMs = poolConfig.sessionTtlHours * 3600000;
      for (const [key, entry] of active) {
        if (now - entry.lastUsed > ttlMs || !entry.backend.isAlive()) {
          logger.info('Evicting idle/dead session', { key });
          // Cancel pending prompt before eviction
          if (entry.promptPending) {
            entry.backend.cancel();
          }
          suspended.set(key, entry.sessionId);
          entry.backend.stop();
          active.delete(key);
        }
      }
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
      // Cancel pending prompt before suspension
      if (entry.promptPending) {
        entry.backend.cancel();
      }
      suspended.set(oldest, entry.sessionId);
      entry.backend.stop();
      active.delete(oldest);
    }
  }

  startCleanup();

  return {
    async getOrCreate(threadKey: string, cwd: string): Promise<AcpBackend> {
      const existing = active.get(threadKey);
      if (existing && existing.backend.isAlive()) {
        existing.lastUsed = Date.now();
        return existing.backend;
      }
      if (existing) {
        if (!suspended.has(threadKey) && existing.sessionId) {
          suspended.set(threadKey, existing.sessionId);
        }
        existing.backend.stop();
        active.delete(threadKey);
      }

      evictLRU();

      const backend = createAcpBackend(command, args, workingDir, extraEnv);
      await backend.start();

      const suspendedId = suspended.get(threadKey);
      let sessionId: string;
      if (suspendedId) {
        try {
          await backend.sessionLoad(suspendedId, cwd);
          sessionId = suspendedId;
          suspended.delete(threadKey);
          logger.info('Pool: resumed session', { key: threadKey, sessionId });
        } catch {
          sessionId = await backend.sessionNew(cwd);
          suspended.delete(threadKey);
          logger.info('Pool: resume failed, new session', { key: threadKey, sessionId });
        }
      } else {
        sessionId = await backend.sessionNew(cwd);
        logger.info('Pool: new session', { key: threadKey, sessionId });
      }

      active.set(threadKey, { backend, sessionId, lastUsed: Date.now(), promptPending: false });
      logger.info('Pool: active sessions', { total: active.size, suspended: suspended.size });
      return backend;
    },

    release(threadKey: string) {
      const entry = active.get(threadKey);
      if (entry) {
        if (entry.promptPending) entry.backend.cancel();
        entry.backend.stop();
        active.delete(threadKey);
      }
      suspended.delete(threadKey);
    },

    stopAll() {
      if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
      for (const [, entry] of active) {
        if (entry.promptPending) entry.backend.cancel();
        entry.backend.stop();
      }
      active.clear();
      suspended.clear();
      logger.info('Pool: all sessions stopped');
    },

    getConfigOptions(threadKey: string): ConfigOption[] {
      const entry = active.get(threadKey);
      return entry?.backend.getConfigOptions() ?? [];
    },

    async setConfigOption(threadKey: string, configId: string, value: string): Promise<ConfigOption[]> {
      const entry = active.get(threadKey);
      if (!entry) throw new Error('No session for ' + threadKey);
      return entry.backend.setConfigOption(configId, value);
    },
  };
}
