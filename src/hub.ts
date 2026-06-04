import { EventEmitter } from "node:events";
import { TraceStore } from "./trace-store.js";
import type { StoredFrame } from "./trace-store.js";
import { log } from "./util/log.js";
import { CostAnnotator } from "./cost-annotator.js";
import { emptyPricing } from "./pricing.js";
import { startUiServer } from "./ui-server.js";
import { openBrowserAt } from "./util/open.js";

export interface HubUpstream {
  label: string;
  host: string;
  port: number;
}

export interface WebSocketLike {
  addEventListener(event: "open", listener: () => void): void;
  addEventListener(event: "message", listener: (ev: { data: string }) => void): void;
  addEventListener(event: "close", listener: () => void): void;
  addEventListener(event: "error", listener: (err: unknown) => void): void;
  close(): void;
}

export type WsFactory = (url: string) => WebSocketLike;

const MAX_BACKOFF_MS = 30_000;

export function connectProxy(
  upstream: HubUpstream,
  store: TraceStore,
  events: EventEmitter,
  wsFactory: WsFactory,
  attempt = 0,
): void {
  const url = `ws://${upstream.host}:${upstream.port}/ws`;
  let ws: WebSocketLike;
  let currentAttempt = attempt;

  const scheduleReconnect = () => {
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** currentAttempt);
    setTimeout(
      () => connectProxy(upstream, store, events, wsFactory, currentAttempt + 1),
      delay,
    );
  };

  try {
    ws = wsFactory(url);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    currentAttempt = 0; // reset backoff on successful connection
    log.info(`hub connected → ${upstream.label} (${url})`);
  });

  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data) as { type: string; frames: StoredFrame[] };
      if (msg.type !== "frame" || !Array.isArray(msg.frames)) return;
      for (const f of msg.frames) {
        const id = store.record({
          direction: f.direction,
          frame: f.frame,
          server: upstream.label,
        });
        events.emit("frame", id);
      }
    } catch {
      /* ignore malformed message — never crash the hub */
    }
  });

  ws.addEventListener("close", () => {
    log.info(`hub disconnected from ${upstream.label} — reconnecting (attempt ${currentAttempt + 1})`);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    /* close event will fire and handle reconnect */
  });
}

export interface HubOptions {
  upstreams: HubUpstream[];
  port: number;
  openBrowser: boolean;
}

export async function startHub(opts: HubOptions, wsFactory?: WsFactory): Promise<void> {
  const store = new TraceStore();
  const events = new EventEmitter();
  const annotator = new CostAnnotator({ pricing: emptyPricing() });

  await startUiServer({ port: opts.port, store, events, annotator });
  log.info(`hub ready → http://localhost:${opts.port}/inspect/`);
  log.info(`aggregating ${opts.upstreams.length} upstream${opts.upstreams.length === 1 ? "" : "s"}`);

  const factory = wsFactory ?? defaultWsFactory;
  for (const upstream of opts.upstreams) {
    connectProxy(upstream, store, events, factory);
  }

  if (opts.openBrowser) {
    await openBrowserAt(`http://localhost:${opts.port}/inspect/`);
  }
}

/**
 * Parse `label:host:port` upstream flag value.
 * Examples: `filesystem:proxy-filesystem:7457`
 *           `github:localhost:7458`
 */
export function parseHubUpstream(raw: string): HubUpstream {
  const parts = raw.split(":");
  if (parts.length !== 3) {
    throw new Error(`--upstream must be label:host:port, got: ${JSON.stringify(raw)}`);
  }
  const [label, host, portStr] = parts as [string, string, string];
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--upstream port must be 1–65535, got: ${JSON.stringify(portStr)}`);
  }
  return { label, host, port };
}

function defaultWsFactory(url: string): WebSocketLike {
  // Node 22+ has WebSocket as a stable global.
  const ws = new (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket(url);
  return ws;
}
