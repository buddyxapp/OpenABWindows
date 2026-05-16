/**
 * Turn-boundary batching dispatcher.
 * Synced with OpenAB v0.8.3-beta.3: 3-valued MessageProcessingMode.
 *
 * Modes:
 * - per-message: process each message independently (default for DMs)
 * - per-thread: batch messages in same thread, wait for idle before processing
 * - per-lane: like per-thread but with lane isolation (for multi-bot)
 *
 * This module provides a generic batcher that collects messages and dispatches
 * them as a batch once an idle timeout expires.
 */

export type ProcessingMode = 'per-message' | 'per-thread' | 'per-lane';

export interface BatchedMessage<T> {
  message: T;
  timestamp: number;
}

export interface DispatcherOptions {
  mode: ProcessingMode;
  idleTimeoutMs: number;  // How long to wait for more messages before dispatching
  maxBatchSize: number;   // Max messages in a batch before force-dispatch
}

const DEFAULT_OPTIONS: DispatcherOptions = {
  mode: 'per-message',
  idleTimeoutMs: 2000,
  maxBatchSize: 10,
};

export interface Dispatcher<T> {
  push(laneKey: string, message: T): void;
  dispose(): void;
}

/**
 * Creates a batching dispatcher.
 * In per-message mode, onDispatch is called immediately for each message.
 * In per-thread/per-lane mode, messages are batched by laneKey and dispatched
 * after idleTimeoutMs of silence or when maxBatchSize is reached.
 */
export function createDispatcher<T>(
  options: Partial<DispatcherOptions>,
  onDispatch: (laneKey: string, messages: T[]) => void,
): Dispatcher<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lanes = new Map<string, { messages: T[]; timer: ReturnType<typeof setTimeout> | null }>();

  function flush(laneKey: string) {
    const lane = lanes.get(laneKey);
    if (!lane || lane.messages.length === 0) return;
    if (lane.timer) { clearTimeout(lane.timer); lane.timer = null; }
    const batch = lane.messages.splice(0);
    lanes.delete(laneKey);
    onDispatch(laneKey, batch);
  }

  return {
    push(laneKey: string, message: T) {
      if (opts.mode === 'per-message') {
        onDispatch(laneKey, [message]);
        return;
      }

      let lane = lanes.get(laneKey);
      if (!lane) {
        lane = { messages: [], timer: null };
        lanes.set(laneKey, lane);
      }

      lane.messages.push(message);

      // Force dispatch if batch is full
      if (lane.messages.length >= opts.maxBatchSize) {
        flush(laneKey);
        return;
      }

      // Reset idle timer
      if (lane.timer) clearTimeout(lane.timer);
      lane.timer = setTimeout(() => flush(laneKey), opts.idleTimeoutMs);
    },

    dispose() {
      for (const [key, lane] of lanes) {
        if (lane.timer) clearTimeout(lane.timer);
        if (lane.messages.length > 0) onDispatch(key, lane.messages.splice(0));
      }
      lanes.clear();
    },
  };
}
