import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketLike, WsFactory } from "./hub.js";
import { connectProxy, parseHubUpstream } from "./hub.js";
import { TraceStore } from "./trace-store.js";

let workDir: string;
beforeEach(() => { workDir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-hub-test-"))); });
afterEach(() => { if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true }); });

/** Minimal controllable WebSocket double. */
function makeWs(): { ws: WebSocketLike; emit: (event: string, data?: unknown) => void } {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const ws: WebSocketLike = {
    addEventListener(event: string, listener: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(listener);
    },
    close() {},
  };
  const emit = (event: string, data?: unknown) => {
    for (const fn of listeners[event] ?? []) fn(data);
  };
  return { ws, emit };
}

describe("connectProxy", () => {
  it("tags incoming frames with the server label", () => {
    const store = new TraceStore({ logDir: workDir });
    const events = new EventEmitter();
    const { ws, emit } = makeWs();
    const factory: WsFactory = () => ws;

    connectProxy({ label: "github", host: "localhost", port: 7457 }, store, events, factory);
    emit("open");

    const payload = JSON.stringify({
      type: "frame",
      frames: [{ id: 1, direction: "out", ts: 0, frame: { jsonrpc: "2.0", id: 1, method: "tools/list" } }],
    });
    emit("message", { data: payload });

    const stored = store.since(0);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.server).toBe("github");
    expect(stored[0]!.direction).toBe("out");
  });

  it("emits a frame event when a frame is stored", () => {
    const store = new TraceStore({ logDir: workDir });
    const events = new EventEmitter();
    const { ws, emit } = makeWs();
    const factory: WsFactory = () => ws;
    const frameIds: number[] = [];
    events.on("frame", (id: number) => frameIds.push(id));

    connectProxy({ label: "fs", host: "localhost", port: 7457 }, store, events, factory);
    emit("open");

    emit("message", {
      data: JSON.stringify({
        type: "frame",
        frames: [{ id: 1, direction: "in", ts: 0, frame: { jsonrpc: "2.0", id: 1, result: {} } }],
      }),
    });

    expect(frameIds).toHaveLength(1);
  });

  it("schedules a reconnect when the WebSocket closes", () => {
    vi.useFakeTimers();
    const store = new TraceStore({ logDir: workDir });
    const events = new EventEmitter();
    let connectCount = 0;
    const factory: WsFactory = () => {
      connectCount++;
      const { ws, emit } = makeWs();
      if (connectCount === 1) {
        setTimeout(() => { emit("open"); emit("close"); }, 0);
      }
      return ws;
    };

    connectProxy({ label: "test", host: "localhost", port: 7457 }, store, events, factory);
    vi.runAllTimers();

    expect(connectCount).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });

  it("ignores malformed WebSocket messages without throwing", () => {
    const store = new TraceStore({ logDir: workDir });
    const events = new EventEmitter();
    const { ws, emit } = makeWs();
    const factory: WsFactory = () => ws;

    connectProxy({ label: "fs", host: "localhost", port: 7457 }, store, events, factory);
    emit("open");
    expect(() => emit("message", { data: "not json{" })).not.toThrow();
    expect(store.since(0)).toHaveLength(0);
  });
});

describe("parseHubUpstream", () => {
  it("parses label:host:port correctly", () => {
    expect(parseHubUpstream("filesystem:proxy-filesystem:7457")).toEqual({
      label: "filesystem",
      host: "proxy-filesystem",
      port: 7457,
    });
  });

  it("throws on wrong number of segments", () => {
    expect(() => parseHubUpstream("no-port:host")).toThrow(/label:host:port/);
  });

  it("throws on non-integer port", () => {
    expect(() => parseHubUpstream("fs:host:abc")).toThrow(/port/);
  });
});
