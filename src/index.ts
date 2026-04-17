/**
 * Kiro Bot — entry point.
 * Bridges Telegram and/or Discord to kiro-cli via ACP protocol.
 * Updated: session pool, env var expansion, reaction config.
 */
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { createSessionPool } from './sessionPool.js';
import { createTelegramBot } from './telegramBot.js';
import { createDiscordBot } from './discordBot.js';
import { createSlackBot } from './slackBot.js';

async function main() {
  const config = loadConfig();
  const { frontend } = config;

  const needTelegram = frontend === 'telegram' || frontend === 'both' || frontend === 'all';
  const needDiscord = frontend === 'discord' || frontend === 'both' || frontend === 'all';
  const needSlack = frontend === 'slack' || frontend === 'all';

  if (needTelegram && !config.telegram.botToken) {
    logger.error('Telegram enabled but no botToken. Set telegram.botToken in ~/.kiro-bridge/config.json');
    process.exit(1);
  }
  if (needDiscord && !config.discord.botToken) {
    logger.error('Discord enabled but no botToken. Set discord.botToken in ~/.kiro-bridge/config.json');
    process.exit(1);
  }
  if (needSlack && (!config.slack.botToken || !config.slack.appToken)) {
    logger.error('Slack enabled but missing tokens. Set slack.botToken and slack.appToken in ~/.kiro-bridge/config.json');
    process.exit(1);
  }

  logger.info('Starting', { frontend, command: config.acp.command, workspace: config.workspace });

  // Security warnings
  if (needDiscord && config.discord.allowedUsers.length === 0) {
    logger.warn('⚠️  discord.allowedUsers is empty — ANYONE can use your bot! Set user IDs to restrict access.');
  }
  if (needDiscord && config.discord.allowedChannels.length === 0) {
    logger.warn('⚠️  discord.allowedChannels is empty — bot responds in ALL channels.');
  }
  if (needTelegram && config.telegram.allowedUsers.length === 0) {
    logger.warn('⚠️  telegram.allowedUsers is empty — ANYONE can use your bot!');
  }

  if (needSlack && config.slack.allowedChannels.length === 0) {
    logger.warn('⚠️  slack.allowedChannels is empty — bot responds in ALL channels.');
  }

  const pool = createSessionPool(
    config.acp.command, config.acp.args, config.workspace, config.acp.env, config.pool,
  );

  const stoppers: Array<() => void | Promise<void>> = [() => pool.stopAll()];

  if (needTelegram) {
    const tg = createTelegramBot(config.telegram.botToken, config.telegram.allowedUsers, pool, config.workspace, config.stt);
    stoppers.push(() => tg.stop());
  }

  if (needDiscord) {
    const dc = createDiscordBot({
      botToken: config.discord.botToken,
      allowedChannels: config.discord.allowedChannels,
      allowedUsers: config.discord.allowedUsers,
      allowBotMessages: config.discord.allowBotMessages,
      trustedBotIds: config.discord.trustedBotIds,
      reactionsConfig: config.reactions,
      sttConfig: config.stt,
    }, pool, config.workspace);
    stoppers.push(() => dc.stop());
  }

  if (needSlack) {
    const sl = createSlackBot({
      botToken: config.slack.botToken,
      appToken: config.slack.appToken,
      allowedChannels: config.slack.allowedChannels,
      allowedUsers: config.slack.allowedUsers,
      sttConfig: config.stt,
    }, pool, config.workspace);
    stoppers.push(() => sl.stop());
  }

  logger.info('Running. Ctrl+C to stop.');

  const shutdown = async () => {
    for (const stop of stoppers) await stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('Fatal', { error: err.message ?? err });
  process.exit(1);
});
