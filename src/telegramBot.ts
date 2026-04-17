/**
 * Telegram Bot — bridges Telegram messages to Kiro via ACP.
 * Updated: uses session pool, ContentBlock[] prompts, sender context.
 */
import TelegramBot from 'node-telegram-bot-api';
import { logger } from './logger.js';
import type { SessionPool } from './sessionPool.js';
import type { AcpEvent, ContentBlock } from './acpProtocol.js';

interface ToolEntry { id: string; title: string; state: 'running' | 'completed' | 'failed' }

function toolIcon(s: ToolEntry['state']): string {
  return s === 'running' ? '🔧' : s === 'completed' ? '✅' : '❌';
}
function sanitize(t: string): string {
  return t.replace(/\r/g, '').replace(/\n/g, ' ; ').replace(/`/g, "'");
}
function compose(tools: ToolEntry[], text: string): string {
  let out = '';
  for (const t of tools) out += `${toolIcon(t.state)} \`${sanitize(t.title)}\`${t.state === 'running' ? '...' : ''}\n`;
  if (tools.length) out += '\n';
  out += text.trimEnd();
  return out || '...';
}
function splitMsg(text: string, limit = 4000): string[] {
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

export interface TelegramBotHandle { stop(): void }

export function createTelegramBot(
  botToken: string, allowedUsers: number[],
  pool: SessionPool, workspacePath: string,
): TelegramBotHandle {
  const bot = new TelegramBot(botToken, {
    polling: true,
    request: { family: 4 } as unknown as TelegramBot.ConstructorOptions['request'],
  });

  const processingChats = new Set<number>();
  const allowed = (uid: number) => allowedUsers.length === 0 || allowedUsers.includes(uid);

  async function editSafe(chatId: number, msgId: number, text: string) {
    try { await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }); }
    catch { try { await bot.editMessageText(text, { chat_id: chatId, message_id: msgId }); } catch { /* ignore */ } }
  }

  bot.onText(/\/start/, async (msg) => {
    if (!allowed(msg.from!.id)) return bot.sendMessage(msg.chat.id, '🚫 未授權');
    await bot.sendMessage(msg.chat.id, '👋 Kiro Bridge Bot\n\n直接輸入文字即可對話。\n\n/new — 新 session\n/cancel — 取消\n/status — 狀態');
  });

  bot.onText(/\/new/, async (msg) => {
    if (!allowed(msg.from!.id)) return;
    const key = `tg-${msg.chat.id}`;
    pool.release(key);
    await bot.sendMessage(msg.chat.id, '✅ 新 session 已建立');
  });

  bot.onText(/\/cancel/, async (msg) => {
    if (!allowed(msg.from!.id)) return;
    processingChats.delete(msg.chat.id);
    await bot.sendMessage(msg.chat.id, '🛑 已取消');
  });

  bot.onText(/\/status/, async (msg) => {
    if (!allowed(msg.from!.id)) return;
    await bot.sendMessage(msg.chat.id, `📂 ${workspacePath}\n⏳ 處理中: ${processingChats.has(msg.chat.id) ? '是' : '否'}`);
  });

  bot.on('message', async (msg) => {
    if (msg.text?.startsWith('/') || !msg.text || !msg.from || !allowed(msg.from.id)) return;
    const chatId = msg.chat.id;

    if (processingChats.has(chatId)) {
      await bot.sendMessage(chatId, '⏳ 處理中，請稍候或 /cancel');
      return;
    }
    processingChats.add(chatId);

    const safetyTimer = setTimeout(() => processingChats.delete(chatId), 360000);

    try {
      const key = `tg-${chatId}`;
      const backend = await pool.getOrCreate(key, workspacePath);

      const ph = await bot.sendMessage(chatId, '🧠 思考中...');
      let textBuf = '';
      const tools: ToolEntry[] = [];
      let lastEdit = 0;
      let editQueued = false;
      let editTimer: ReturnType<typeof setTimeout> | null = null;

      const doEdit = async () => {
        const d = compose(tools, textBuf);
        await editSafe(chatId, ph.message_id, d.length > 3900 ? d.substring(0, 3900) + '…' : d);
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
          if (s) { s.title = ev.title; s.state = 'running'; } else tools.push({ id: ev.id, title: ev.title, state: 'running' });
          schedEdit();
        } else if (ev.type === 'tool_done') {
          const s = tools.find(t => t.id === ev.id);
          if (s) { if (ev.title) s.title = ev.title; s.state = ev.status; }
          else if (ev.title) tools.push({ id: ev.id, title: ev.title, state: ev.status });
          schedEdit();
        }
      };

      const senderCtx = `<sender_context>\n  userId: ${msg.from.id}\n  displayName: ${msg.from.first_name}\n  platform: telegram\n</sender_context>\n\n`;
      const content: ContentBlock[] = [{ type: 'text', text: senderCtx + msg.text }];

      const full = await backend.sendPrompt(content, onEvent);
      if (editTimer) clearTimeout(editTimer);

      const chunks = splitMsg(compose(tools, full));
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) await editSafe(chatId, ph.message_id, chunks[0]);
        else await bot.sendMessage(chatId, chunks[i], { parse_mode: 'Markdown' }).catch(() => bot.sendMessage(chatId, chunks[i]));
      }
    } catch (e) {
      logger.error('Prompt error', { error: e instanceof Error ? e.message : String(e) });
      await bot.sendMessage(chatId, `⚠️ ${e instanceof Error ? e.message : e}`);
    } finally {
      clearTimeout(safetyTimer);
      processingChats.delete(chatId);
    }
  });

  bot.on('polling_error', (err) => logger.error('Polling error', { error: err.message }));
  logger.info('Telegram bot started');
  return { stop: () => { bot.stopPolling(); logger.info('Telegram bot stopped'); } };
}
