/**
 * Discord Bot — bridges Discord messages to Kiro via ACP.
 * Updated to match OpenAB v0.7.7: session pool, sender context,
 * mention resolution, image attachments, reaction state machine,
 * tail-priority truncation, GitHub URL collapsing in thread names.
 */
import {
  Client, GatewayIntentBits, Events, Message, TextChannel,
  ThreadAutoArchiveDuration, type GuildMember,
} from 'discord.js';
import https from 'node:https';
import http from 'node:http';
import { logger } from './logger.js';
import type { SessionPool } from './sessionPool.js';
import type { AcpEvent, ContentBlock } from './acpProtocol.js';
import type { ReactionsConfig } from './config.js';
import { createReactionController } from './reactions.js';

export interface DiscordBotOptions {
  botToken: string;
  allowedChannels: string[];
  allowedUsers: string[];
  allowBotMessages: 'off' | 'mentions' | 'all';
  trustedBotIds: string[];
  reactionsConfig: ReactionsConfig;
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
  // Collapse finished tools if >3 (like OpenAB)
  const running = tools.filter(t => t.state === 'running');
  const done = tools.filter(t => t.state !== 'running');
  if (done.length > 3) {
    out += `✅ ${done.length} tools completed\n`;
  } else {
    for (const t of done) out += `${toolIcon(t.state)} \`${sanitize(t.title)}\`\n`;
  }
  for (const t of running) out += `🔧 \`${sanitize(t.title)}\`...\n`;
  if (tools.length) out += '\n';

  // Tail-priority truncation (like OpenAB): show newest output
  let body = text.trimEnd();
  if (limit && out.length + body.length > limit) {
    const avail = limit - out.length - 4;
    if (avail > 0) body = '…' + body.substring(body.length - avail);
    else body = body.substring(body.length - limit + 4);
  }
  out += body;
  return out || '...';
}

function splitMsg(text: string, limit = 1900): string[] {
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

/** Resolve <@id> → @DisplayName (like OpenAB's discord.rs) */
function resolveMentions(content: string, msg: Message): string {
  return content
    .replace(/<@!?(\d+)>/g, (_, id) => {
      const member = msg.guild?.members.cache.get(id);
      if (member) return `@${member.displayName}`;
      const user = msg.client.users.cache.get(id);
      return user ? `@${user.username}` : '@(user)';
    })
    .replace(/<@&(\d+)>/g, (_, id) => {
      const role = msg.guild?.roles.cache.get(id);
      return role ? `@${role.name}` : '@(role)';
    });
}

/** Thread name: collapse GitHub URLs, strip mentions, 40 chars (like OpenAB) */
function shortenThreadName(prompt: string): string {
  let name = prompt
    .replace(/https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)(?:\/[^\s]*)?/g, '$1')
    .replace(/<@!?\d+>/g, '')
    .replace(/<@&\d+>/g, '')
    .trim();
  if (name.length > 40) name = name.substring(0, 40) + '...';
  return name || 'conversation';
}

/** Build sender context XML (like OpenAB's discord.rs) */
function senderContext(msg: Message): string {
  const name = (msg.member as GuildMember | null)?.displayName ?? msg.author.username;
  return `<sender_context>\n  userId: ${msg.author.id}\n  displayName: ${name}\n  platform: discord\n</sender_context>\n\n`;
}

/** Download URL to Buffer */
function downloadBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

export interface DiscordBotHandle { stop(): Promise<void> }

export function createDiscordBot(
  opts: DiscordBotOptions,
  pool: SessionPool,
  workspacePath: string,
): DiscordBotHandle {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  const allowedChannels = new Set(opts.allowedChannels);
  const allowedUsers = new Set(opts.allowedUsers);
  const trustedBots = new Set(opts.trustedBotIds);
  // Track which threads are processing to prevent double-prompts per thread
  const processingThreads = new Set<string>();

  function isAllowedChannel(channelId: string, parentId?: string | null): boolean {
    if (allowedChannels.size === 0) return true;
    return allowedChannels.has(channelId) || (parentId ? allowedChannels.has(parentId) : false);
  }

  function isAllowedUser(userId: string): boolean {
    return allowedUsers.size === 0 || allowedUsers.has(userId);
  }

  client.on(Events.ClientReady, (c) => logger.info('Discord bot connected', { user: c.user.tag }));

  client.on(Events.MessageCreate, async (msg: Message) => {
    const botId = client.user?.id;
    if (!botId) return;

    // Bot message handling (like OpenAB's allow_bot_messages)
    if (msg.author.bot) {
      if (opts.allowBotMessages === 'off') return;
      if (opts.allowBotMessages === 'mentions' && !msg.mentions.has(botId)) return;
      if (!trustedBots.has(msg.author.id)) return;
    }

    if (!isAllowedUser(msg.author.id) && !msg.author.bot) return;

    const parentId = msg.channel.isThread() ? msg.channel.parentId : null;
    const inThread = msg.channel.isThread() && isAllowedChannel(msg.channel.id, parentId);
    const inChannel = isAllowedChannel(msg.channelId);
    if (!inChannel && !inThread) return;

    const isMentioned = msg.mentions.has(botId);
    if (!inThread && !isMentioned) return;

    // Resolve mentions and strip bot mention
    let prompt = isMentioned
      ? resolveMentions(msg.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim(), msg)
      : resolveMentions(msg.content.trim(), msg);
    if (!prompt && msg.attachments.size === 0) return;

    // Thread key for session pool
    const threadKey = msg.channel.isThread() ? msg.channelId : `new-${msg.id}`;

    if (processingThreads.has(threadKey)) {
      await msg.reply('⏳ 處理中，請稍候').catch(() => {});
      return;
    }
    processingThreads.add(threadKey);

    try {
      const backend = await pool.getOrCreate(threadKey, workspacePath);

      // Create thread if not already in one
      let thread = msg.channel.isThread() ? msg.channel : null;
      if (!thread) {
        thread = await (msg.channel as TextChannel).threads.create({
          name: shortenThreadName(prompt),
          startMessage: msg,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });
      }

      const placeholder = await thread.send('🧠 思考中...');

      // Reaction controller (like OpenAB's reactions.rs)
      const rxn = createReactionController(
        opts.reactionsConfig,
        (emoji) => msg.react(emoji).then(() => {}).catch(() => {}),
        () => msg.reactions.removeAll().then(() => {}).catch(() => {}),
      );
      rxn.onQueued();

      // Build content blocks (text + images)
      const content: ContentBlock[] = [];
      content.push({ type: 'text', text: senderContext(msg) + prompt });

      // Process image attachments (like OpenAB's media.rs)
      for (const [, att] of msg.attachments) {
        if (!att.contentType?.startsWith('image/')) continue;
        if (att.size > 10 * 1024 * 1024) continue; // skip >10MB
        try {
          const buf = await downloadBuffer(att.url);
          content.push({ type: 'image', media_type: att.contentType, data: buf.toString('base64') });
        } catch (e) {
          logger.warn('Failed to download image', { url: att.url, error: (e as Error).message });
        }
      }

      let textBuf = '';
      const tools: ToolEntry[] = [];
      let lastEdit = 0;
      let editQueued = false;
      let editTimer: ReturnType<typeof setTimeout> | null = null;

      const doEdit = async () => {
        const d = compose(tools, textBuf, 1900);
        await placeholder.edit(d).catch(() => {});
        lastEdit = Date.now();
        editQueued = false;
      };

      const schedEdit = () => {
        if (editQueued) return;
        const wait = Math.max(0, 1500 - (Date.now() - lastEdit));
        editQueued = true;
        if (wait === 0) doEdit();
        else editTimer = setTimeout(doEdit, wait);
      };

      const onEvent = (ev: AcpEvent) => {
        if (ev.type === 'text') { textBuf += ev.content; schedEdit(); }
        else if (ev.type === 'thinking') { rxn.onThinking(); }
        else if (ev.type === 'tool_start' && ev.title) {
          rxn.onTool();
          const s = tools.find(t => t.id === ev.id);
          if (s) { s.title = ev.title; s.state = 'running'; }
          else tools.push({ id: ev.id, title: ev.title, state: 'running' });
          schedEdit();
        } else if (ev.type === 'tool_done') {
          rxn.onThinking();
          const s = tools.find(t => t.id === ev.id);
          if (s) { if (ev.title) s.title = ev.title; s.state = ev.status; }
          else if (ev.title) tools.push({ id: ev.id, title: ev.title, state: ev.status });
          schedEdit();
        }
      };

      const full = await backend.sendPrompt(content, onEvent);
      if (editTimer) clearTimeout(editTimer);

      const chunks = splitMsg(compose(tools, full));
      await placeholder.edit(chunks[0]).catch(() => {});
      for (let i = 1; i < chunks.length; i++) {
        await thread.send(chunks[i]).catch(() => {});
      }

      rxn.onDone();
      rxn.dispose();
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error('Discord prompt error', { error: errMsg });
      await msg.reply(`⚠️ ${errMsg}`).catch(() => {});
      await msg.reactions.removeAll().catch(() => {});
      await msg.react('😱').catch(() => {});
    } finally {
      processingThreads.delete(threadKey);
    }
  });

  client.login(opts.botToken);
  logger.info('Discord bot starting...');

  return {
    async stop() { await client.destroy(); logger.info('Discord bot stopped'); },
  };
}
