/**
 * ACP Backend — long-lived kiro-cli acp process, JSON-RPC over stdin/stdout.
 * Synced with OpenAB v0.8.1: ConfigOption, set_config_option, connection-close notify,
 * session recovery, process tree kill (Windows taskkill).
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { logger } from './logger.js';
import {
  type JsonRpcMessage, type AcpEvent, type ContentBlock, type ConfigOption,
  classifyNotification, buildPermissionResponse, makeRequest, makeResponse,
  parseConfigOptions,
} from './acpProtocol.js';

export interface AcpBackend {
  start(): Promise<void>;
  stop(): void;
  isAlive(): boolean;
  getSessionId(): string | null;
  getConfigOptions(): ConfigOption[];
  sessionNew(cwd: string): Promise<string>;
  sessionLoad(sessionId: string, cwd: string): Promise<void>;
  setConfigOption(configId: string, value: string): Promise<ConfigOption[]>;
  sendPrompt(content: ContentBlock[], onEvent: (event: AcpEvent) => void): Promise<string>;
  cancel(): void;
}

export function createAcpBackend(
  command: string, args: string[], workingDir?: string, extraEnv?: Record<string, string>,
): AcpBackend {
  let proc: ChildProcess | null = null;
  let nextId = 1;
  let sessionId: string | null = null;
  let configOptions: ConfigOption[] = [];
  const pending = new Map<number, { resolve: (msg: JsonRpcMessage) => void; reject: (e: Error) => void }>();
  let promptSubscriber: ((msg: JsonRpcMessage) => void) | null = null;
  let rl: ReturnType<typeof createInterface> | null = null;

  function writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!proc?.stdin?.writable) return reject(new Error('stdin not writable'));
      proc.stdin.write(line + '\n', (err) => (err ? reject(err) : resolve()));
    });
  }

  async function sendRequest(method: string, params?: unknown, timeoutMs = 30000): Promise<JsonRpcMessage> {
    const id = nextId++;
    const line = makeRequest(id, method, params);
    logger.debug('acp_send', { method, id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, timeoutMs);
      pending.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      writeLine(line).catch((err) => { clearTimeout(timer); pending.delete(id); reject(err); });
    });
  }

  /** Notify all waiters that the connection is dead (like OpenAB's *sub = None on EOF) */
  function notifyConnectionClosed(reason: string): void {
    for (const [, p] of pending) p.reject(new Error(reason));
    pending.clear();
    if (promptSubscriber) {
      promptSubscriber({ id: undefined, error: { code: -1, message: reason } });
      promptSubscriber = null;
    }
  }

  function handleMessage(msg: JsonRpcMessage): void {
    if (msg.method === 'session/request_permission' && msg.id != null) {
      const title = (msg.params?.toolCall as Record<string, unknown>)?.title ?? '?';
      const outcome = buildPermissionResponse(msg.params);
      logger.info('Auto-approve permission', { title });
      writeLine(makeResponse(msg.id, outcome)).catch(() => {});
      return;
    }
    if (msg.id != null) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (promptSubscriber) promptSubscriber(msg);
        msg.error ? p.reject(new Error(`${msg.error.message} (${msg.error.code})`)) : p.resolve(msg);
        return;
      }
    }
    if (promptSubscriber) promptSubscriber(msg);
  }

  return {
    async start() {
      if (proc) return;
      if (rl) { rl.close(); rl = null; }
      sessionId = null; promptSubscriber = null; pending.clear(); configOptions = [];

      const env = { ...process.env, ...extraEnv };
      logger.info('Spawning ACP process', { command, args });
      proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: workingDir, env });

      rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const t = line.trim();
        if (!t) return;
        try { handleMessage(JSON.parse(t)); } catch { /* non-JSON */ }
      });
      proc.stderr?.on('data', (d: Buffer) => logger.debug('acp_stderr', { line: d.toString().trim() }));
      proc.on('error', (err) => {
        logger.error('ACP process error', { error: err.message });
        notifyConnectionClosed('ACP process error: ' + err.message);
        proc = null;
      });
      proc.on('close', (code) => {
        logger.info('ACP process exited', { code });
        notifyConnectionClosed(`ACP process exited with code ${code}`);
        proc = null; sessionId = null;
      });

      const resp = await sendRequest('initialize', {
        protocolVersion: 1, clientCapabilities: {},
        clientInfo: { name: 'openab-windows', version: '1.2.0' },
      }, 120000);
      const agent = ((resp.result as Record<string, unknown>)?.agentInfo as Record<string, unknown>)?.name ?? 'unknown';
      logger.info('ACP initialized', { agent });
    },

    stop() {
      if (!proc) return;
      promptSubscriber = null; sessionId = null;
      for (const [, p] of pending) p.reject(new Error('stopped'));
      pending.clear();
      try {
        if (proc.pid) {
          const pid = proc.pid;
          if (process.platform === 'win32') {
            execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
          } else {
            process.kill(-pid, 'SIGTERM');
            setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* dead */ } }, 3000);
          }
        }
      } catch { try { proc?.kill(); } catch { /* ignore */ } }
      proc = null;
      logger.info('ACP stopped');
    },

    isAlive: () => proc != null && !proc.killed,
    getSessionId: () => sessionId,
    getConfigOptions: () => configOptions,

    async sessionNew(cwd: string) {
      const resp = await sendRequest('session/new', { cwd, mcpServers: [] }, 120000);
      const result = resp.result as Record<string, unknown>;
      const sid = result?.sessionId as string;
      if (!sid) throw new Error('No sessionId');
      sessionId = sid;
      configOptions = parseConfigOptions(result);
      if (configOptions.length) logger.info('Parsed configOptions', { count: configOptions.length });
      logger.info('Session created', { sessionId: sid });
      return sid;
    },

    async sessionLoad(sid: string, cwd: string) {
      const resp = await sendRequest('session/load', { sessionId: sid, cwd }, 120000);
      sessionId = sid;
      const result = resp.result as Record<string, unknown>;
      if (result) configOptions = parseConfigOptions(result);
      logger.info('Session loaded', { sessionId: sid });
    },

    async setConfigOption(configId: string, value: string): Promise<ConfigOption[]> {
      if (!sessionId) throw new Error('No session');
      try {
        const resp = await sendRequest('session/set_config_option', {
          sessionId, configId, value,
        });
        const result = resp.result as Record<string, unknown>;
        if (result) configOptions = parseConfigOptions(result);
        logger.info('Config option set', { configId, value });
      } catch {
        // Fallback: send as slash command (e.g. "/model claude-sonnet-4")
        const cmd = `/${configId} ${value}`;
        logger.info('set_config_option not supported, falling back to prompt', { cmd });
        await sendRequest('session/prompt', {
          sessionId, prompt: [{ type: 'text', text: cmd }],
        });
        for (const opt of configOptions) {
          if (opt.id === configId) opt.currentValue = value;
        }
      }
      return configOptions;
    },

    async sendPrompt(content: ContentBlock[], onEvent: (event: AcpEvent) => void): Promise<string> {
      if (!sessionId) throw new Error('No session');
      const id = nextId++;
      const line = makeRequest(id, 'session/prompt', { sessionId, prompt: content });
      let fullText = '';

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { promptSubscriber = null; pending.delete(id); reject(new Error('Prompt timeout (5 min)')); }, 300000);

        promptSubscriber = (msg) => {
          // Connection closed → reject immediately (no more waiting)
          if (msg.error && msg.id === undefined) {
            clearTimeout(timer); promptSubscriber = null;
            reject(new Error(`${msg.error.message} (${msg.error.code})`));
            return;
          }
          if (msg.id === id) {
            clearTimeout(timer); promptSubscriber = null;
            if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
            else { onEvent({ type: 'turn_end' }); resolve(fullText); }
            return;
          }
          const event = classifyNotification(msg);
          if (event) {
            if (event.type === 'text') fullText += event.content;
            if (event.type === 'config_update') configOptions = event.options;
            onEvent(event);
          }
        };

        pending.set(id, {
          resolve: () => {},
          reject: (err) => { clearTimeout(timer); promptSubscriber = null; reject(err); },
        });
        writeLine(line).catch((err) => { clearTimeout(timer); promptSubscriber = null; pending.delete(id); reject(err); });
      });
    },

    cancel() {
      if (!sessionId) return;
      writeLine(makeRequest(nextId++, 'session/cancel', { sessionId })).catch(() => {});
      logger.info('Prompt cancelled');
    },
  };
}
