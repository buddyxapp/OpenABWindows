/**
 * Config loader — reads ~/.kiro-bridge/config.json
 * Now supports ${ENV_VAR} expansion (like OpenAB's config.rs)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface PoolConfig {
  maxSessions: number;
  sessionTtlHours: number;
}

export interface ReactionsConfig {
  enabled: boolean;
  removeAfterReply: boolean;
  emojis: {
    queued: string;
    thinking: string;
    tool: string;
    coding: string;
    done: string;
    error: string;
  };
  timing: {
    debounceMs: number;
    stallSoftMs: number;
    stallHardMs: number;
    doneHoldMs: number;
  };
}

export interface Config {
  telegram: { botToken: string; allowedUsers: number[] };
  discord: {
    botToken: string;
    allowedChannels: string[];
    allowedUsers: string[];
    allowBotMessages: 'off' | 'mentions' | 'all';
    trustedBotIds: string[];
  };
  acp: { command: string; args: string[]; env: Record<string, string> };
  workspace: string;
  frontend: 'telegram' | 'discord' | 'both';
  pool: PoolConfig;
  reactions: ReactionsConfig;
}

const CONFIG_DIR = path.join(os.homedir(), '.kiro-bridge');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/** Expand ${VAR} references in strings (like OpenAB's config.rs) */
function expandEnvVars(val: unknown): unknown {
  if (typeof val === 'string') {
    // ${file:/path/to/secret} — read from file
    const fileMatch = val.match(/^\$\{file:(.+)\}$/);
    if (fileMatch) {
      try { return fs.readFileSync(fileMatch[1], 'utf-8').trim(); }
      catch { return ''; }
    }
    // ${VAR} — read from env
    return val.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
  }
  if (Array.isArray(val)) return val.map(expandEnvVars);
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) out[k] = expandEnvVars(v);
    return out;
  }
  return val;
}

const DEFAULT_REACTIONS: ReactionsConfig = {
  enabled: true,
  removeAfterReply: false,
  emojis: { queued: '👀', thinking: '🤔', tool: '🔥', coding: '👨‍💻', done: '🆗', error: '😱' },
  timing: { debounceMs: 700, stallSoftMs: 10000, stallHardMs: 30000, doneHoldMs: 1500 },
};

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaults: Config = {
      telegram: { botToken: '', allowedUsers: [] },
      discord: {
        botToken: '', allowedChannels: [], allowedUsers: [],
        allowBotMessages: 'off', trustedBotIds: [],
      },
      acp: { command: 'kiro-cli', args: ['acp', '--trust-all-tools'], env: {} },
      workspace: process.cwd(),
      frontend: 'telegram',
      pool: { maxSessions: 10, sessionTtlHours: 24 },
      reactions: DEFAULT_REACTIONS,
    };
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2), { mode: 0o600 });
    return defaults;
  }

  const raw = expandEnvVars(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))) as Record<string, unknown>;
  const disc = raw.discord as Record<string, unknown> | undefined;
  const pool = raw.pool as Record<string, unknown> | undefined;
  const rxn = raw.reactions as Record<string, unknown> | undefined;

  return {
    telegram: {
      botToken: (raw.telegram as Record<string, unknown>)?.botToken as string ?? '',
      allowedUsers: (raw.telegram as Record<string, unknown>)?.allowedUsers as number[] ?? [],
    },
    discord: {
      botToken: disc?.botToken as string ?? '',
      allowedChannels: disc?.allowedChannels as string[] ?? [],
      allowedUsers: disc?.allowedUsers as string[] ?? [],
      allowBotMessages: (disc?.allowBotMessages as Config['discord']['allowBotMessages']) ?? 'off',
      trustedBotIds: disc?.trustedBotIds as string[] ?? [],
    },
    acp: {
      command: (raw.acp as Record<string, unknown>)?.command as string ?? 'kiro-cli',
      args: (raw.acp as Record<string, unknown>)?.args as string[] ?? ['acp', '--trust-all-tools'],
      env: (raw.acp as Record<string, unknown>)?.env as Record<string, string> ?? {},
    },
    workspace: (raw.workspace as string) || process.cwd(),
    frontend: raw.frontend as Config['frontend'] ?? 'telegram',
    pool: {
      maxSessions: pool?.maxSessions as number ?? 10,
      sessionTtlHours: pool?.sessionTtlHours as number ?? 24,
    },
    reactions: {
      enabled: rxn?.enabled as boolean ?? true,
      removeAfterReply: rxn?.removeAfterReply as boolean ?? false,
      emojis: { ...DEFAULT_REACTIONS.emojis, ...(rxn?.emojis as Record<string, string>) },
      timing: { ...DEFAULT_REACTIONS.timing, ...(rxn?.timing as Record<string, number>) },
    },
  };
}
