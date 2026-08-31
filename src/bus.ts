// In-process fan-out for "a message landed in channel X". Feeds two consumers:
// the webview's SSE stream and long-polling read_messages MCP calls.
import { EventEmitter } from "node:events";
import type { Message } from "./db";

export const bus = new EventEmitter();
bus.setMaxListeners(0); // one listener per open SSE tab / long-poll; unbounded is fine locally

export function publish(message: Message): void {
  bus.emit(`msg:${message.channel_id}`, message);
  bus.emit("msg:*", message); // firehose for the webview's all-channels feed
}

export function subscribeAll(handler: (msg: Message) => void): () => void {
  bus.on("msg:*", handler);
  return () => bus.off("msg:*", handler);
}

export function subscribe(channelId: string, handler: (msg: Message) => void): () => void {
  const key = `msg:${channelId}`;
  bus.on(key, handler);
  return () => bus.off(key, handler);
}

/** Resolves true when a message lands in the channel, false on timeout. */
export function waitForMessage(channelId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const unsub = subscribe(channelId, () => {
      clearTimeout(timer);
      unsub();
      resolve(true);
    });
    const timer = setTimeout(() => {
      unsub();
      resolve(false);
    }, timeoutMs);
  });
}
