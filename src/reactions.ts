/**
 * Status Reaction Controller — debounced emoji transitions with stall detection.
 * Ported from OpenAB's reactions.rs.
 */
import type { ReactionsConfig } from './config.js';

type ReactionFn = (emoji: string) => Promise<void>;
type ClearFn = () => Promise<void>;

const MOOD_FACES = ['😊', '🤓', '😎', '🫡', '🙂', '😏', '🤗'];

export interface ReactionController {
  onQueued(): void;
  onThinking(): void;
  onTool(): void;
  onDone(): void;
  onError(): void;
  dispose(): void;
}

export function createReactionController(
  config: ReactionsConfig,
  react: ReactionFn,
  clear: ClearFn,
): ReactionController {
  if (!config.enabled) {
    return { onQueued() {}, onThinking() {}, onTool() {}, onDone() {}, onError() {}, dispose() {} };
  }

  let current = '';
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let stallSoftTimer: ReturnType<typeof setTimeout> | null = null;
  let stallHardTimer: ReturnType<typeof setTimeout> | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (stallSoftTimer) { clearTimeout(stallSoftTimer); stallSoftTimer = null; }
    if (stallHardTimer) { clearTimeout(stallHardTimer); stallHardTimer = null; }
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  }

  function setEmoji(emoji: string) {
    if (emoji === current) return;
    current = emoji;
    clear().then(() => react(emoji)).catch(() => {});
  }

  function debouncedSet(emoji: string) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => setEmoji(emoji), config.timing.debounceMs);
  }

  function resetStallTimers() {
    if (stallSoftTimer) clearTimeout(stallSoftTimer);
    if (stallHardTimer) clearTimeout(stallHardTimer);
    stallSoftTimer = setTimeout(() => setEmoji('🥱'), config.timing.stallSoftMs);
    stallHardTimer = setTimeout(() => setEmoji('😨'), config.timing.stallHardMs);
  }

  return {
    onQueued() { setEmoji(config.emojis.queued); resetStallTimers(); },
    onThinking() { debouncedSet(config.emojis.thinking); resetStallTimers(); },
    onTool() { debouncedSet(config.emojis.tool); resetStallTimers(); },
    onDone() {
      clearTimers();
      const mood = MOOD_FACES[Math.floor(Math.random() * MOOD_FACES.length)];
      clear().then(() => react(config.emojis.done)).then(() => react(mood)).catch(() => {});
      if (config.removeAfterReply) {
        holdTimer = setTimeout(() => clear().catch(() => {}), config.timing.doneHoldMs);
      }
    },
    onError() {
      clearTimers();
      setEmoji(config.emojis.error);
    },
    dispose() { clearTimers(); },
  };
}
