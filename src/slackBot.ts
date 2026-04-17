/**
 * Slack Bot — bridges Slack messages to Kiro via ACP.
 * Uses Socket Mode (like OpenAB's slack.rs). Thread-based multi-turn.
 */
import { App } from '@slack/bolt';
import { logger } from './logger.js';
import type { SessionPool } from './sessionPool.js';
import type { AcpEvent, ContentBlock } from './acpProtocol.js';
import type { SttConfig } from './config.js';
import { processImage, transcribeAudio, downloadBuffer } from './media.js';

export interface SlackBotOptions {
  botToken: string;   // xoxb-...
  appToken: string;   // xapp-...
  allowedChannels: string[];
  allowedUsers: string[];
  sttConfig: SttConfig;
}

interface ToolEntry { id: string; title: string; state: 'running' | 'completed' | 'failed' }

function toolIcon(s: ToolEntry['state']): string {
  return s === 'running' ? '🔧' : s === 'completed' ? '✅' : '❌';
}
function sanitize(t: string): string {
  return t.replace(/\r/g, '').replace(/\n/g, ' ; ').replace(/`/g, "'");
}

function compose(tools: ToolEntry[], text: string, limit?: number): string {
  let out = '';
  const running = tools.filter(t => t.state === 'running');
  const done = tools.filter(t => t.state !== 'running');
  if (done.length > 3) out += `✅ ${done.length} tools completed\n`;
  else for (const t of done) out += `${toolIcon(t.state)} \`${sanitize(t.title)}\`\n`;
  for (const t of running) out += `🔧 \`${sanitize(t.title)}\`...\n`;
  if (tools.length) out += '\n';
  let body = text.trimEnd();
  if (limit && out.length + body.length > limit) {
    const avail = limit - out.length - 4;
    if (avail > 0) body = '…' + body.substring(body.length - avail);
    else body = body.substring(body.length - limit + 4);
  }
  out += body;
  return out || '...';
}

function splitMsg(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= limit) { chunks.push(rest); break; }
    let at = rest.lastIndexOf('\n', limit);
    if (at < limit * 0.5) at = limit;
    chunks.push(rest.substring(0, at));
    rest = rest.substring(at);
  }
  return chunks;
}

function shortenThreadName(prompt: string): string {
  let name = prompt
    .replace(/https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)(?:\/[^\s]*)?/g, '$1')
    .replace(/<@[A-Z0-9]+>/g, '').trim();
  if (name.length > 40) name = name.substring(0, 40) + '...';
  return name || 'conversation';
}

export interface SlackBotHandle { stop(): Promise<void> }

export function createSlackBot(
  opts: SlackBotOptions, pool: SessionPool, workspacePath: string,
): SlackBotHandle {
  const app = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
  });

  const allowedChannels = new Set(opts.allowedChannels);
  const allowedUsers = new Set(opts.allowedUsers);
  const processingThreads = new Set<string>();
  let botUserId = '';

  function isAllowed(channelId: string, userId: string): boolean {
    if (allowedChannels.size > 0 && !allowedChannels.has(channelId)) return false;
    if (allowedUsers.size > 0 && !allowedUsers.has(userId)) return false;
    return true;
  }

  /** Strip bot mention from text */
  function stripMention(text: string): string {
    if (!botUserId) return text;
    return text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
  }

  /** Download Slack file using bot token for auth */
  async function downloadSlackFile(url: string): Promise<Buffer> {
    return downloadBuffer(url, { Authorization: `Bearer ${opts.botToken}` });
  }

  app.event('message', async ({ event, client }) => {
    const msg = event as unknown as Record<string, unknown>;
    if (msg.subtype || msg.bot_id) return;
    const text = msg.text as string | undefined;
    const files = msg.files as Array<Record<string, unknown>> | undefined;
    const user = msg.user as string;
    const channel = msg.channel as string;
    const ts = msg.ts as string;
    const thread_ts = msg.thread_ts as string | undefined;

    if (!text && !files?.length) return;
    if (!isAllowed(channel, user)) return;

    // Get bot user ID on first message
    if (!botUserId) {
      try {
        const auth = await client.auth.test();
        botUserId = auth.user_id as string;
      } catch { /* ignore */ }
    }

    const inThread = !!thread_ts;
    const isMentioned = !!text?.includes(`<@${botUserId}>`);

    // In channel: require @mention. In thread: always respond.
    if (!inThread && !isMentioned) return;

    let prompt = stripMention(text || '');
    const threadKey = `slack-${channel}-${thread_ts || ts}`;

    if (processingThreads.has(threadKey)) {
      await client.chat.postMessage({
        channel, thread_ts: thread_ts || ts, text: '⏳ 處理中，請稍候',
      });
      return;
    }
    processingThreads.add(threadKey);

    try {
      const backend = await pool.getOrCreate(threadKey, workspacePath);

      // Post thinking placeholder
      const ph = await client.chat.postMessage({
        channel, thread_ts: thread_ts || ts, text: '🧠 思考中...',
      });
      const phTs = ph.ts!;

      // Build content blocks
      const content: ContentBlock[] = [];

      // Process file attachments
      if (files?.length) {
        for (const file of files) {
          const url = file.url_private as string;
          const mimetype = file.mimetype as string | undefined;
          if (!url) continue;

          if (mimetype?.startsWith('image/')) {
            try {
              const img = await processImage(url, { Authorization: `Bearer ${opts.botToken}` });
              if (img) content.push({ type: 'image', media_type: img.mediaType, data: img.data });
            } catch (e) {
              logger.warn('Slack image failed', { error: (e as Error).message });
            }
          } else if (mimetype?.startsWith('audio/') || file.subtype === 'voice_message') {
            const sttText = await transcribeAudio(url, opts.sttConfig, { Authorization: `Bearer ${opts.botToken}` });
            if (sttText) prompt = (prompt ? prompt + '\n\n' : '') + `[🎤 Voice]: ${sttText}`;
          }
        }
      }

      const senderCtx = `<sender_context>\n  userId: ${user}\n  platform: slack\n</sender_context>\n\n`;
      content.unshift({ type: 'text', text: senderCtx + prompt });

      if (!prompt && content.length <= 1) {
        processingThreads.delete(threadKey);
        return;
      }

      let textBuf = '';
      const tools: ToolEntry[] = [];
      let lastEdit = 0;
      let editQueued = false;
      let editTimer: ReturnType<typeof setTimeout> | null = null;

      const doEdit = async () => {
        const d = compose(tools, textBuf, 3900);
        await client.chat.update({ channel, ts: phTs, text: d }).catch(() => {});
        lastEdit = Date.now(); editQueued = false;
      };
      const schedEdit = () => {
        if (editQueued) return;
        const wait = Math.max(0, 1500 - (Date.now() - lastEdit));
        editQueued = true;
        if (wait === 0) doEdit(); else editTimer = setTimeout(doEdit, wait);
      };

      const onEvent = (ev: AcpEvent) => {
        if (ev.type === 'text') { textBuf += ev.content; schedEdit(); }
        else if (ev.type === 'tool_start' && ev.title) {
          const s = tools.find(t => t.id === ev.id);
          if (s) { s.title = ev.title; s.state = 'running'; }
          else tools.push({ id: ev.id, title: ev.title, state: 'running' });
          schedEdit();
        } else if (ev.type === 'tool_done') {
          const s = tools.find(t => t.id === ev.id);
          if (s) { if (ev.title) s.title = ev.title; s.state = ev.status; }
          else if (ev.title) tools.push({ id: ev.id, title: ev.title, state: ev.status });
          schedEdit();
        }
      };

      const full = await backend.sendPrompt(content, onEvent);
      if (editTimer) clearTimeout(editTimer);

      const replyTs = thread_ts || ts;
      const chunks = splitMsg(compose(tools, full));
      await client.chat.update({ channel, ts: phTs, text: chunks[0] }).catch(() => {});
      for (let i = 1; i < chunks.length; i++) {
        await client.chat.postMessage({ channel, thread_ts: replyTs, text: chunks[i] }).catch(() => {});
      }

      await client.reactions.add({ channel, timestamp: ts, name: 'white_check_mark' }).catch(() => {});
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error('Slack prompt error', { error: errMsg });
      await client.chat.postMessage({
        channel, thread_ts: thread_ts || ts, text: `⚠️ ${errMsg}`,
      }).catch(() => {});
    } finally {
      processingThreads.delete(threadKey);
    }
  });

  // Start
  (async () => {
    await app.start();
    logger.info('Slack bot started (Socket Mode)');
  })();

  return {
    async stop() { await app.stop(); logger.info('Slack bot stopped'); },
  };
}
