/**
 * Discord Bot — bridges Discord messages to Kiro via ACP.
 * Synced with OpenAB v0.8.3-beta.10:
 *   - receiver_id in sender_context
 *   - [[reply_to:message_id]] directive
 *   - Echo STT transcripts before agent reply
 *   - /export-thread slash command
 *   - /remind slash command
 *   - allowed_role_ids trigger
 *   - Video attachment passthrough
 *   - Pending prompt cleanup on abandon
 *   - max_bot_turns (default 100, hard cap 1000)
 *   - Global slash command registration
 */
import {
  Client, GatewayIntentBits, Events, Message, TextChannel,
  ThreadAutoArchiveDuration, type GuildMember,
  REST, Routes, SlashCommandBuilder, ChatInputCommandInteraction,
  AttachmentBuilder,
} from 'discord.js';
import { logger } from './logger.js';
import type { SessionPool } from './sessionPool.js';
import type { AcpEvent, ContentBlock } from './acpProtocol.js';
import type { ReactionsConfig, SttConfig } from './config.js';
import { createReactionController } from './reactions.js';
import { processImage, transcribeAudio } from './media.js';

export interface DiscordBotOptions {
  botToken: string;
  allowedChannels: string[];
  allowedUsers: string[];
  allowedRoleIds: string[];
  allowBotMessages: 'off' | 'mentions' | 'all';
  trustedBotIds: string[];
  maxBotTurns: number;
  reactionsConfig: ReactionsConfig;
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

function shortenThreadName(prompt: string): string {
  let name = prompt
    .replace(/https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)(?:\/[^\s]*)?/g, '$1')
    .replace(/<@!?\d+>/g, '').replace(/<@&\d+>/g, '').trim();
  if (name.length > 40) name = name.substring(0, 40) + '...';
  return name || 'conversation';
}

function senderContext(msg: Message, receiverId: string): string {
  const name = (msg.member as GuildMember | null)?.displayName ?? msg.author.username;
  return `<sender_context>\n  userId: ${msg.author.id}\n  displayName: ${name}\n  platform: discord\n  receiver_id: ${receiverId}\n  threadId: ${msg.channelId}\n</sender_context>\n\n`;
}

/** Parse [[reply_to:message_id]] directives from agent output */
function extractReplyTo(text: string): { cleanText: string; replyToId: string | null } {
  const match = text.match(/\[\[reply_to:(\d+)\]\]/);
  if (!match) return { cleanText: text, replyToId: null };
  return { cleanText: text.replace(match[0], '').trim(), replyToId: match[1] };
}

function isAudio(contentType?: string | null, flags?: number): boolean {
  if (flags && (flags & 8192) !== 0) return true;
  if (!contentType) return false;
  return contentType.startsWith('audio/') || contentType === 'application/ogg'
    || contentType.startsWith('video/ogg');
}

function isVideo(contentType?: string | null): boolean {
  if (!contentType) return false;
  return contentType.startsWith('video/');
}

function isVoiceMessage(msg: Message): boolean {
  return (msg.flags.bitfield & 8192) !== 0;
}

/** Check if user has any of the allowed roles */
function hasAllowedRole(msg: Message, allowedRoleIds: string[]): boolean {
  if (allowedRoleIds.length === 0) return false;
  const member = msg.member;
  if (!member) return false;
  return member.roles.cache.some(r => allowedRoleIds.includes(r.id));
}

/** Check if message mentions any of the allowed roles */
function mentionsAllowedRole(msg: Message, allowedRoleIds: string[]): boolean {
  if (allowedRoleIds.length === 0) return false;
  return msg.mentions.roles.some(r => allowedRoleIds.includes(r.id));
}

export interface DiscordBotHandle { stop(): Promise<void> }

export function createDiscordBot(
  opts: DiscordBotOptions, pool: SessionPool, workspacePath: string,
): DiscordBotHandle {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  const allowedChannels = new Set(opts.allowedChannels);
  const allowedUsers = new Set(opts.allowedUsers);
  const trustedBots = new Set(opts.trustedBotIds);
  const processingThreads = new Set<string>();
  const botTurnCounts = new Map<string, number>();
  const maxBotTurns = Math.min(Math.max(opts.maxBotTurns || 100, 1), 1000);
  // Track pending prompts for cleanup
  const pendingPrompts = new Map<string, { backend: ReturnType<typeof pool.getOrCreate> extends Promise<infer T> ? T : never; timer: ReturnType<typeof setTimeout> }>();

  function isAllowedChannel(channelId: string, parentId?: string | null): boolean {
    if (allowedChannels.size === 0) return true;
    return allowedChannels.has(channelId) || (parentId ? allowedChannels.has(parentId) : false);
  }
  function isAllowedUser(userId: string): boolean {
    return allowedUsers.size === 0 || allowedUsers.has(userId);
  }

  // Register global slash commands
  async function registerSlashCommands() {
    const commands = [
      new SlashCommandBuilder().setName('export-thread').setDescription('Export thread messages as a text file')
        .addIntegerOption(o => o.setName('limit').setDescription('Max messages (default 100)').setRequired(false))
        .addStringOption(o => o.setName('since').setDescription('Message ID to start from').setRequired(false))
        .addIntegerOption(o => o.setName('days').setDescription('Export last N days').setRequired(false))
        .addBooleanOption(o => o.setName('all').setDescription('Export all (up to 5000)').setRequired(false)),
      new SlashCommandBuilder().setName('remind').setDescription('Set a reminder')
        .addStringOption(o => o.setName('message').setDescription('Reminder message').setRequired(true))
        .addIntegerOption(o => o.setName('minutes').setDescription('Minutes from now').setRequired(true))
        .addUserOption(o => o.setName('user').setDescription('User to remind (default: you)').setRequired(false)),
    ];

    const rest = new REST({ version: '10' }).setToken(opts.botToken);
    try {
      await rest.put(Routes.applicationCommands(client.user!.id), { body: commands.map(c => c.toJSON()) });
      logger.info('Registered global slash commands');
    } catch (e) {
      logger.error('Failed to register slash commands', { error: (e as Error).message });
    }
  }

  // Handle /export-thread
  async function handleExportThread(interaction: ChatInputCommandInteraction) {
    if (!interaction.channel?.isThread()) {
      await interaction.reply({ content: '❌ This command only works in threads.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });

    const all = interaction.options.getBoolean('all') ?? false;
    const limit = all ? 5000 : (interaction.options.getInteger('limit') ?? 100);
    const since = interaction.options.getString('since');
    const days = interaction.options.getInteger('days');

    let messages: Message[] = [];
    let before: string | undefined;
    let fetched = 0;

    while (fetched < limit) {
      const batch = await interaction.channel.messages.fetch({
        limit: Math.min(100, limit - fetched),
        ...(before ? { before } : {}),
        ...(since ? { after: since } : {}),
      });
      if (batch.size === 0) break;
      messages.push(...batch.values());
      before = batch.last()?.id;
      fetched += batch.size;
      if (batch.size < 100) break;
    }

    // Filter by days if specified
    if (days) {
      const cutoff = Date.now() - days * 86400000;
      messages = messages.filter(m => m.createdTimestamp >= cutoff);
    }

    // Sort chronologically
    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const lines = messages.map(m => {
      const ts = new Date(m.createdTimestamp).toISOString().replace('T', ' ').substring(0, 19);
      const author = m.author.username;
      const content = m.content || (m.attachments.size > 0 ? `[${m.attachments.size} attachment(s)]` : '[empty]');
      return `[${ts}] ${author}: ${content}`;
    });

    const text = lines.join('\n');
    const buf = Buffer.from(text, 'utf-8');
    const attachment = new AttachmentBuilder(buf, { name: `thread-export-${interaction.channelId}.txt` });

    await interaction.editReply({ content: `📄 Exported ${messages.length} messages`, files: [attachment] });
  }

  // Handle /remind
  const reminders: Array<{ timer: ReturnType<typeof setTimeout> }> = [];
  async function handleRemind(interaction: ChatInputCommandInteraction) {
    const message = interaction.options.getString('message', true);
    const minutes = interaction.options.getInteger('minutes', true);
    const targetUser = interaction.options.getUser('user') ?? interaction.user;

    if (minutes < 1 || minutes > 10080) {
      await interaction.reply({ content: '❌ Minutes must be between 1 and 10080 (7 days).', ephemeral: true });
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const ch = interaction.channel;
        if (ch && 'send' in ch) await (ch as TextChannel).send(`⏰ <@${targetUser.id}> Reminder: ${message}`);
      } catch { /* channel may be gone */ }
    }, minutes * 60000);
    reminders.push({ timer });

    await interaction.reply({ content: `✅ Reminder set for <@${targetUser.id}> in ${minutes} minute(s): "${message}"`, ephemeral: false });
  }

  client.on(Events.ClientReady, async (c) => {
    logger.info('Discord bot connected', { user: c.user.tag });
    await registerSlashCommands();
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'export-thread') await handleExportThread(interaction);
    else if (interaction.commandName === 'remind') await handleRemind(interaction);
  });

  client.on(Events.MessageCreate, async (msg: Message) => {
    const botId = client.user?.id;
    if (!botId) return;

    if (msg.author.bot) {
      if (opts.allowBotMessages === 'off') return;
      if (opts.allowBotMessages === 'mentions' && !msg.mentions.has(botId)) return;
      if (!trustedBots.has(msg.author.id)) return;
      // Bot turn counting
      const threadKey = msg.channel.isThread() ? msg.channelId : msg.id;
      const count = (botTurnCounts.get(threadKey) ?? 0) + 1;
      botTurnCounts.set(threadKey, count);
      if (count >= maxBotTurns) {
        logger.warn('Bot turn limit reached', { threadKey, count, max: maxBotTurns });
        await msg.reply(`⚠️ Bot turn limit reached (${maxBotTurns}). Human intervention needed.`).catch(() => {});
        return;
      }
    }

    if (!isAllowedUser(msg.author.id) && !msg.author.bot) return;

    const parentId = msg.channel.isThread() ? msg.channel.parentId : null;
    const inThread = msg.channel.isThread() && isAllowedChannel(msg.channel.id, parentId);
    const inChannel = isAllowedChannel(msg.channelId);
    if (!inChannel && !inThread) return;

    const isMentioned = msg.mentions.has(botId);
    const isRoleTrigger = mentionsAllowedRole(msg, opts.allowedRoleIds);
    if (!inThread && !isMentioned && !isRoleTrigger && !isVoiceMessage(msg)) return;

    let prompt = isMentioned
      ? resolveMentions(msg.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim(), msg)
      : resolveMentions(msg.content.trim(), msg);
    if (!prompt && msg.attachments.size === 0 && !isVoiceMessage(msg)) return;

    const threadKey = msg.channel.isThread() ? msg.channelId : `new-${msg.id}`;

    if (processingThreads.has(threadKey)) {
      await msg.reply('⏳ 處理中，請稍候').catch(() => {});
      return;
    }
    processingThreads.add(threadKey);

    try {
      const backend = await pool.getOrCreate(threadKey, workspacePath);

      let thread = msg.channel.isThread() ? msg.channel : null;
      if (!thread) {
        thread = await (msg.channel as TextChannel).threads.create({
          name: shortenThreadName(prompt),
          startMessage: msg,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });
      }

      const placeholder = await thread.send('🧠 思考中...');

      const rxn = createReactionController(
        opts.reactionsConfig,
        (emoji) => msg.react(emoji).then(() => {}).catch(() => {}),
        () => msg.reactions.removeAll().then(() => {}).catch(() => {}),
      );
      rxn.onQueued();

      // Build content blocks
      const content: ContentBlock[] = [];

      // Process attachments: images, audio → STT, video → passthrough info
      for (const [, att] of msg.attachments) {
        if (att.contentType?.startsWith('image/')) {
          const img = await processImage(att.url);
          if (img) content.push({ type: 'image', media_type: img.mediaType, data: img.data });
        } else if (isAudio(att.contentType, msg.flags.bitfield)) {
          const text = await transcribeAudio(att.url, opts.sttConfig);
          if (text) {
            // Echo STT transcript to thread before agent reply
            await thread.send(`🎤 *Transcript:* ${text}`).catch(() => {});
            prompt = (prompt ? prompt + '\n\n' : '') + `[🎤 Voice message]: ${text}`;
            await msg.react('🎤').catch(() => {});
          }
        } else if (isVideo(att.contentType)) {
          // Video attachment passthrough — include URL for agent
          prompt = (prompt ? prompt + '\n\n' : '') + `[🎬 Video attachment]: ${att.url} (${att.name ?? 'video'}, ${att.contentType})`;
        }
      }

      content.unshift({ type: 'text', text: senderContext(msg, botId) + prompt });

      let textBuf = '';
      const tools: ToolEntry[] = [];
      let lastEdit = 0;
      let editQueued = false;
      let editTimer: ReturnType<typeof setTimeout> | null = null;

      const doEdit = async () => {
        await placeholder.edit(compose(tools, textBuf, 1900)).catch(() => {});
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

      // Set up abandon timeout for pending prompt cleanup
      const abandonTimer = setTimeout(() => {
        logger.warn('Prompt abandoned (timeout), cancelling', { threadKey });
        backend.cancel();
      }, 300000);

      const full = await backend.sendPrompt(content, onEvent);
      clearTimeout(abandonTimer);
      if (editTimer) clearTimeout(editTimer);

      // Parse [[reply_to:message_id]] directive
      const { cleanText, replyToId } = extractReplyTo(compose(tools, full));
      const chunks = splitMsg(cleanText);

      if (replyToId) {
        // Try to reply to the specific message
        try {
          const targetMsg = await thread.messages.fetch(replyToId);
          await targetMsg.reply(chunks[0]).catch(() => placeholder.edit(chunks[0]));
        } catch {
          await placeholder.edit(chunks[0]).catch(() => {});
        }
      } else {
        await placeholder.edit(chunks[0]).catch(() => {});
      }
      for (let i = 1; i < chunks.length; i++) await thread.send(chunks[i]).catch(() => {});

      rxn.onDone();
      rxn.dispose();
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error('Discord prompt error', { error: errMsg });
      if (errMsg.includes('Internal error') || errMsg.includes('-32603') || errMsg.includes('ACP exited') || errMsg.includes('ACP process error')) {
        logger.info('Releasing stale session for recovery', { key: threadKey });
        pool.release(threadKey);
      }
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
    async stop() {
      for (const r of reminders) clearTimeout(r.timer);
      await client.destroy();
      logger.info('Discord bot stopped');
    },
  };
}
