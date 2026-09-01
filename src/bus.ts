// In-process fan-out for channel events. Feeds three consumers: the webview's
// SSE streams, long-polling read_messages MCP calls, and (for deletions) the
// "kick everyone out" path.
import { EventEmitter } from "node:events";
import type { Message } from "./db";

export const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open SSE tab / long-poll; unbounded is fine locally

export function publish(message: Message): void {
  bus.emit(`msg:${message.channel_id}`, message);
  bus.emit("msg:*", message); // firehose for the webview's all-channels feed
}

export function subscribe(channelId: string, handler: (msg: Message) => void): () => void {
  const key = `msg:${channelId}`;
  bus.on(key, handler);
  return () => bus.off(key, handler);
}

export function subscribeAll(handler: (msg: Message) => void): () => void {
  bus.on("msg:*", handler);
  return () => bus.off("msg:*", handler);
}

/**
 * Channel deletion: wakes that channel's blocked long-polls (which then see
 * the channel is gone and error out) and lets SSE streams close themselves —
 * the stateless-MCP equivalent of kicking everyone out.
 */
export function publishChannelDeleted(channelId: string): void {
  bus.emit(`deleted:${channelId}`);
  bus.emit("deleted:*", channelId);
}

export function subscribeDeleted(channelId: string, handler: () => void): () => void {
  const key = `deleted:${channelId}`;
  bus.on(key, handler);
  return () => bus.off(key, handler);
}

export function subscribeAllDeleted(handler: (channelId: string) => void): () => void {
  bus.on("deleted:*", handler);
  return () => bus.off("deleted:*", handler);
}

/**
 * Resolves true when a message lands in the channel, false on timeout — and
 * also resolves (true) when the channel is deleted, so the caller re-checks
 * the channel and reports it gone instead of blocking out the full wait.
 */
export function waitForMessage(channelId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubMsg();
      unsubDel();
      resolve(value);
    };
    const unsubMsg = subscribe(channelId, () => finish(true));
    const unsubDel = subscribeDeleted(channelId, () => finish(true));
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
