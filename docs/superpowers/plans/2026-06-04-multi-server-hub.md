# Multi-Server Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `generate` and `hub` commands so a single `docker compose up` runs N MCP proxy containers plus one aggregating hub, all visible in one browser tab at `localhost:7456/inspect/`, with server badges, a server filter, and a topology view.

**Architecture:** `generate` reads `servers.yaml` and writes a `docker-compose.yml` with one `proxy-<name>` service per server plus a `hub` service. The hub opens a WebSocket to each proxy's `/ws` endpoint, tags incoming frames with the server label, and stores them in a shared `TraceStore` served by the existing `startUiServer`. The UI gains server badges, a filter dropdown, and a Topology tab built from the tagged frames.

**Tech Stack:** TypeScript, Node 22, Fastify, Vitest, plain SVG (no graph library), Docker Compose v3.8

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/trace-store.ts` | Modify | Add `server?: string` to `StoredFrame` and `RecordInput` |
| `src/generate.ts` | Create | Parse `servers.yaml`; render `docker-compose.yml` string |
| `src/generate.test.ts` | Create | Unit tests for YAML parser and compose renderer |
| `src/hub.ts` | Create | WS client per proxy, shared TraceStore, start UI server |
| `src/hub.test.ts` | Create | Unit tests for frame aggregation and reconnect logic |
| `src/cli.ts` | Modify | Register `generate` and `hub` commands |
| `ui/index.html` | Modify | Server badges, server filter dropdown, Topology tab |

---

## Task 1: Extend StoredFrame with `server` field

**Files:**
- Modify: `src/trace-store.ts`
- Create: `src/trace-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/trace-store.test.ts`:

```typescript
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TraceStore } from "./trace-store.js";

let workDir: string;

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-store-test-")));
});

afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe("TraceStore — server field", () => {
  it("stores server label when provided", () => {
    const store = new TraceStore({ logDir: workDir });
    const id = store.record({
      direction: "out",
      frame: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      server: "filesystem",
    });
    const frames = store.since(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.server).toBe("filesystem");
    expect(frames[0]!.id).toBe(id);
  });

  it("leaves server undefined when not provided", () => {
    const store = new TraceStore({ logDir: workDir });
    store.record({ direction: "in", frame: { jsonrpc: "2.0", id: 1, result: {} } });
    const frames = store.since(0);
    expect(frames[0]!.server).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```
pnpm test src/trace-store.test.ts
```

Expected: FAIL — `server` does not exist on `RecordInput`.

- [ ] **Step 3: Add `server` to `StoredFrame` and `RecordInput`**

In `src/trace-store.ts`, update the two interfaces:

```typescript
export interface StoredFrame {
  id: number;
  direction: "in" | "out";
  ts: number;
  server?: string;   // set by hub; undefined in single-server proxy mode
  frame: JsonRpcFrame;
}

export interface RecordInput {
  direction: "in" | "out";
  frame: JsonRpcFrame;
  server?: string;
}
```

Update the `record` method body to copy the field:

```typescript
record(input: RecordInput): number {
  const entry: StoredFrame = {
    id: this.nextId++,
    direction: input.direction,
    ts: Date.now(),
    server: input.server,
    frame: input.frame,
  };
  this.buf.push(entry);
  if (this.buf.length > MAX_FRAMES) this.buf.shift();
  void this.persist(entry);
  return entry.id;
}
```

- [ ] **Step 4: Run tests**

```
pnpm test src/trace-store.test.ts
```

Expected: PASS

- [ ] **Step 5: Run full suite to confirm no regressions**

```
pnpm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add src/trace-store.ts src/trace-store.test.ts
git commit -m "feat(store): add optional server field to StoredFrame and RecordInput"
```

---

## Task 2: servers.yaml config parser

**Files:**
- Create: `src/generate.ts` (parser only — compose renderer added in Task 3)
- Create: `src/generate.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/generate.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseServersYaml } from "./generate.js";

describe("parseServersYaml", () => {
  it("parses a two-server config", () => {
    const yaml = `
servers:
  - name: filesystem
    command: "node servers/filesystem.js /data"
  - name: github
    command: node servers/github.js
`;
    const config = parseServersYaml(yaml);
    expect(config.servers).toHaveLength(2);
    expect(config.servers[0]).toEqual({ name: "filesystem", command: "node servers/filesystem.js /data" });
    expect(config.servers[1]).toEqual({ name: "github", command: "node servers/github.js" });
  });

  it("strips inline comments", () => {
    const yaml = `
servers:
  - name: db  # primary database
    command: python db.py  # stdio transport
`;
    const config = parseServersYaml(yaml);
    expect(config.servers[0]!.command).toBe("python db.py");
  });

  it("throws on missing command", () => {
    const yaml = `
servers:
  - name: broken
`;
    expect(() => parseServersYaml(yaml)).toThrow(/command/);
  });

  it("throws on empty servers list", () => {
    expect(() => parseServersYaml("servers:\n")).toThrow(/no servers/);
  });

  it("throws on invalid name (uppercase)", () => {
    const yaml = `
servers:
  - name: MyServer
    command: node x.js
`;
    expect(() => parseServersYaml(yaml)).toThrow(/name/);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
pnpm test src/generate.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/generate.ts` with parser**

```typescript
import { readFileSync, writeFileSync } from "node:fs";

export interface ServerEntry {
  name: string;
  command: string;
}

export interface GenerateConfig {
  servers: ServerEntry[];
}

/**
 * Parse the minimal YAML subset used by servers.yaml.
 * Format:
 *   servers:
 *     - name: <alphanumeric-with-hyphens>
 *       command: <shell command>
 *
 * No external YAML dep — the format is fixed and a custom parser stays auditable.
 */
export function parseServersYaml(source: string): GenerateConfig {
  const servers: ServerEntry[] = [];
  let current: Partial<ServerEntry> | null = null;

  const flush = () => {
    if (!current) return;
    if (!current.name) throw new Error("server entry missing 'name'");
    if (!current.command) throw new Error(`server "${current.name}" missing 'command'`);
    servers.push({ name: current.name, command: current.command });
    current = null;
  };

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s*#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    if (/^servers:\s*$/.test(line)) continue;

    // List item start: `  - name: foo`
    const listItem = line.match(/^\s+-\s+name:\s*(.+?)\s*$/);
    if (listItem) {
      flush();
      current = { name: stripQuotes(listItem[1]!) };
      continue;
    }

    // Indented key: `    command: "..."`
    const kv = line.match(/^\s+([a-z]+):\s*(.+?)\s*$/);
    if (kv && current) {
      const [, key, val] = kv;
      if (key === "command") current.command = stripQuotes(val!);
      // unknown keys ignored for forward-compatibility
    }
  }
  flush();

  if (servers.length === 0) throw new Error("servers.yaml: no servers defined");

  for (const s of servers) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s.name)) {
      throw new Error(
        `server name "${s.name}" must be lowercase alphanumeric with optional hyphens`,
      );
    }
  }

  return { servers };
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

export function loadServersConfig(path: string): GenerateConfig {
  return parseServersYaml(readFileSync(path, "utf8"));
}
```

- [ ] **Step 4: Run tests**

```
pnpm test src/generate.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/generate.ts src/generate.test.ts
git commit -m "feat(generate): servers.yaml config parser"
```

---

## Task 3: Docker Compose renderer

**Files:**
- Modify: `src/generate.ts` (add `generateDockerCompose`)
- Modify: `src/generate.test.ts` (add compose tests)

- [ ] **Step 1: Add failing tests to `src/generate.test.ts`**

Append to the file:

```typescript
import { generateDockerCompose } from "./generate.js";

describe("generateDockerCompose", () => {
  const config = {
    servers: [
      { name: "filesystem", command: "node servers/fs.js" },
      { name: "github", command: "node servers/gh.js" },
    ],
  };

  it("emits one proxy service per server", () => {
    const out = generateDockerCompose(config);
    expect(out).toContain("proxy-filesystem:");
    expect(out).toContain("proxy-github:");
  });

  it("assigns incrementing internal ports starting at 7457", () => {
    const out = generateDockerCompose(config);
    expect(out).toContain("--port 7457");
    expect(out).toContain("--port 7458");
  });

  it("emits a hub service on port 7456 with correct --upstream flags", () => {
    const out = generateDockerCompose(config);
    expect(out).toContain("hub:");
    expect(out).toContain("--port 7456");
    expect(out).toContain("--upstream filesystem:proxy-filesystem:7457");
    expect(out).toContain("--upstream github:proxy-github:7458");
  });

  it("only exposes port 7456 to the host", () => {
    const out = generateDockerCompose(config);
    // Hub has ports mapping; proxies must not
    const hubIdx = out.indexOf("hub:");
    const proxy1Idx = out.indexOf("proxy-filesystem:");
    expect(out.indexOf('"7456:7456"')).toBeGreaterThan(hubIdx);
    // proxy section must not contain a ports: key
    const proxy1Section = out.slice(proxy1Idx, hubIdx);
    expect(proxy1Section).not.toContain("ports:");
  });

  it("includes a shared mcp-internal bridge network", () => {
    const out = generateDockerCompose(config);
    expect(out).toContain("mcp-internal:");
    expect(out).toContain("driver: bridge");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
pnpm test src/generate.test.ts
```

Expected: FAIL — `generateDockerCompose` not exported.

- [ ] **Step 3: Add `generateDockerCompose` to `src/generate.ts`**

Append after `loadServersConfig`:

```typescript
const HUB_UI_PORT = 7456;
const BASE_PROXY_PORT = 7457;

export function generateDockerCompose(config: GenerateConfig): string {
  const proxyServices = config.servers
    .map((server, i) => {
      const port = BASE_PROXY_PORT + i;
      return `  proxy-${server.name}:
    image: node:22-alpine
    working_dir: /app
    volumes:
      - .:/app
    command: >
      node dist/cli.js proxy
      --upstream "${server.command}"
      --port ${port}
      --no-open
      --quiet
    networks:
      - mcp-internal`;
    })
    .join("\n\n");

  const hubUpstreams = config.servers
    .map((server, i) => {
      const port = BASE_PROXY_PORT + i;
      return `      --upstream ${server.name}:proxy-${server.name}:${port}`;
    })
    .join("\n");

  const dependsOn = config.servers
    .map((s) => `      - proxy-${s.name}`)
    .join("\n");

  const hubService = `  hub:
    image: node:22-alpine
    working_dir: /app
    volumes:
      - .:/app
    command: >
      node dist/cli.js hub
${hubUpstreams}
      --port ${HUB_UI_PORT}
      --no-open
    ports:
      - "${HUB_UI_PORT}:${HUB_UI_PORT}"
    depends_on:
${dependsOn}
    networks:
      - mcp-internal`;

  return `version: "3.8"

services:
${proxyServices}

${hubService}

networks:
  mcp-internal:
    driver: bridge
`;
}
```

Also add `writeDockerCompose` helper at the end of the file for use by the CLI:

```typescript
export function writeDockerCompose(config: GenerateConfig, outPath: string): void {
  writeFileSync(outPath, generateDockerCompose(config), "utf8");
}
```

- [ ] **Step 4: Run tests**

```
pnpm test src/generate.test.ts
```

Expected: all PASS

- [ ] **Step 5: Commit**

```
git add src/generate.ts src/generate.test.ts
git commit -m "feat(generate): docker-compose renderer"
```

---

## Task 4: Add `generate` CLI command

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add the command after the existing `call` command block (before `cli.help()`)**

In `src/cli.ts`, add the import at the top with the other imports:

```typescript
import { loadServersConfig, writeDockerCompose } from "./generate.js";
```

Then add the command before `cli.help()`:

```typescript
cli
  .command("generate", "Generate a docker-compose.yml from a servers.yaml config")
  .option("--config <path>", "Path to servers.yaml", { default: "servers.yaml" })
  .option("--out <path>", "Output path for docker-compose.yml", { default: "docker-compose.yml" })
  .option("--quiet", "Suppress informational logs")
  .action((opts) => {
    setQuiet(!!opts.quiet);
    try {
      const config = loadServersConfig(opts.config);
      writeDockerCompose(config, opts.out);
      log.info(`generated ${opts.out} (${config.servers.length} server${config.servers.length === 1 ? "" : "s"})`);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });
```

- [ ] **Step 2: Build and smoke-test the command**

```
pnpm build
node dist/cli.js generate --help
```

Expected output includes `--config` and `--out` options.

- [ ] **Step 3: Create a test config and run generate**

```
echo "servers:\n  - name: test\n    command: node smoke/fake-server.js" > /tmp/test-servers.yaml
node dist/cli.js generate --config /tmp/test-servers.yaml --out /tmp/test-compose.yml
cat /tmp/test-compose.yml
```

Expected: valid docker-compose.yml with `proxy-test` and `hub` services.

- [ ] **Step 4: Commit**

```
git add src/cli.ts
git commit -m "feat(cli): generate command — docker-compose from servers.yaml"
```

---

## Task 5: Hub proxy connector

**Files:**
- Create: `src/hub.ts` (connectProxy + WebSocketLike interface)
- Create: `src/hub.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/hub.test.ts`:

```typescript
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocketLike, WsFactory } from "./hub.js";
import { connectProxy } from "./hub.js";
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```
pnpm test src/hub.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/hub.ts` with `connectProxy` and interfaces**

```typescript
import { EventEmitter } from "node:events";
import { TraceStore } from "./trace-store.js";
import type { StoredFrame } from "./trace-store.js";
import { log } from "./util/log.js";

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

  const scheduleReconnect = () => {
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    setTimeout(
      () => connectProxy(upstream, store, events, wsFactory, attempt + 1),
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
    log.info(`hub disconnected from ${upstream.label} — reconnecting (attempt ${attempt + 1})`);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    /* close event will fire and handle reconnect */
  });
}
```

- [ ] **Step 4: Run tests**

```
pnpm test src/hub.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/hub.ts src/hub.test.ts
git commit -m "feat(hub): WebSocket proxy connector with exponential backoff"
```

---

## Task 6: Hub entry point

**Files:**
- Modify: `src/hub.ts` (add `startHub` + `parseHubUpstream`)

- [ ] **Step 1: Add `startHub` and `parseHubUpstream` to `src/hub.ts`**

Add these imports at the top of `src/hub.ts` (after the existing imports from Task 5):

```typescript
import { CostAnnotator } from "./cost-annotator.js";
import { emptyPricing } from "./pricing.js";
import { startUiServer } from "./ui-server.js";
import { openBrowserAt } from "./util/open.js";
```

(`TraceStore` is already imported as a value import from Task 5 — do not add a duplicate.)

Append to the end of `src/hub.ts`:

```typescript
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
```

- [ ] **Step 2: Add `parseHubUpstream` tests to `src/hub.test.ts`**

Append to `src/hub.test.ts`:

```typescript
import { parseHubUpstream } from "./hub.js";

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
```

- [ ] **Step 3: Run tests**

```
pnpm test src/hub.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```
git add src/hub.ts src/hub.test.ts
git commit -m "feat(hub): startHub entry point and parseHubUpstream"
```

---

## Task 7: Add `hub` CLI command

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add imports at the top of `src/cli.ts`**

```typescript
import { type HubOptions, parseHubUpstream, startHub } from "./hub.js";
```

- [ ] **Step 2: Add the `hub` command before `cli.help()`**

```typescript
cli
  .command("hub", "Aggregate multiple MCP proxy streams into one inspector UI")
  .option("--upstream <spec>", "label:host:port of a running proxy. Repeatable.", {
    type: [String],
  })
  .option("--port <port>", "Port for the aggregated UI", { default: 7456 })
  .option("--no-open", "Don't auto-open the browser")
  .option("--quiet", "Suppress informational logs")
  .action(async (opts) => {
    setQuiet(!!opts.quiet);
    const rawUpstreams = (Array.isArray(opts.upstream) ? opts.upstream : [opts.upstream]).filter(
      (v): v is string => typeof v === "string" && v.length > 0 && v !== "undefined",
    );
    if (rawUpstreams.length === 0) {
      process.stderr.write(`${kleur.red("error:")} at least one --upstream is required\n`);
      process.exit(1);
    }
    let upstreams: HubOptions["upstreams"];
    try {
      upstreams = rawUpstreams.map(parseHubUpstream);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
    const port = validatePort(opts.port);
    if (!port.ok) {
      process.stderr.write(`${port.message}\n`);
      process.exit(1);
    }
    await startHub({
      upstreams,
      port: port.value,
      openBrowser: opts.open !== false,
    });
  });
```

- [ ] **Step 3: Build and smoke-test**

```
pnpm build
node dist/cli.js hub --help
```

Expected: help shows `--upstream`, `--port`, `--no-open`.

- [ ] **Step 4: Run full test suite**

```
pnpm test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```
git add src/cli.ts
git commit -m "feat(cli): hub command — aggregate multiple proxy streams"
```

---

## Task 8: UI — server badges on timeline rows

**Files:**
- Modify: `ui/index.html`

- [ ] **Step 1: Add server badge CSS inside the `<style>` block**

After the `.row .cost.unknown` rule add:

```css
.row .server-badge {
  display: inline-block; margin-left: 6px;
  padding: 1px 6px; border-radius: 3px;
  font-size: 10px; font-weight: 500; letter-spacing: 0.03em;
  opacity: 0.85; vertical-align: middle;
}
```

- [ ] **Step 2: Add server color helper to the `<script>` block**

After `const frames = [];` add:

```javascript
const SERVER_PALETTE = [
  '#6ee7b7','#fbbf24','#f87171','#818cf8',
  '#34d399','#fb923c','#60a5fa','#c084fc',
];

function serverColor(name) {
  if (!name) return '#8a8a8a';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return SERVER_PALETTE[Math.abs(h) % SERVER_PALETTE.length];
}

function serverBadgeHtml(f) {
  if (!f.server) return '';
  const color = serverColor(f.server);
  return `<span class="server-badge" style="background:${color}22;color:${color};border:1px solid ${color}44">${escapeHtml(f.server)}</span>`;
}
```

- [ ] **Step 3: Add badge to the row template inside `render()`**

Find the existing row template string:

```javascript
return `<div class="${cls.join(" ")}" data-i="${i}">
  <span class="dir">${f.direction === "in" ? "←" : "→"}</span>
  <span class="method">${escapeHtml(rowLabel(f))}</span>
  ${costBadgeHtml(f)}
</div>`;
```

Replace with:

```javascript
return `<div class="${cls.join(" ")}" data-i="${i}">
  <span class="dir">${f.direction === "in" ? "←" : "→"}</span>
  <span class="method">${escapeHtml(rowLabel(f))}</span>
  ${serverBadgeHtml(f)}
  ${costBadgeHtml(f)}
</div>`;
```

- [ ] **Step 4: Build and verify**

```
pnpm build
```

Start the proxy with the fake server and open the UI. Frames should render without error (no badge in single-server mode).

- [ ] **Step 5: Commit**

```
git add ui/index.html
git commit -m "feat(ui): server badge on timeline rows"
```

---

## Task 9: UI — server filter dropdown

**Files:**
- Modify: `ui/index.html`

- [ ] **Step 1: Add dropdown CSS inside `<style>`**

After `.filter-bar .count` rule add:

```css
.filter-bar select {
  background: #060606; color: var(--fg);
  border: 1px solid var(--border); border-radius: 4px;
  padding: 5px 8px; font-family: inherit; font-size: 12px;
  cursor: pointer;
}
.filter-bar select:focus { outline: none; border-color: var(--accent); }
```

- [ ] **Step 2: Add the `<select>` element inside `.filter-bar` in the HTML**

Find:

```html
<div class="filter-bar">
  <input id="filter" type="search" placeholder="Filter by method or body — Esc to clear" autocomplete="off" spellcheck="false" />
  <span class="count" id="filter-count"></span>
</div>
```

Replace with:

```html
<div class="filter-bar">
  <input id="filter" type="search" placeholder="Filter by method or body — Esc to clear" autocomplete="off" spellcheck="false" />
  <select id="server-filter"><option value="">All servers</option></select>
  <span class="count" id="filter-count"></span>
</div>
```

- [ ] **Step 3: Wire up the dropdown in the `<script>` block**

After `const fcount = ...` add:

```javascript
const serverFilterEl = document.getElementById("server-filter");
let serverFilterStr = "";
const knownServers = new Set();

function updateServerFilter() {
  const current = serverFilterEl.value;
  // Add any newly seen servers
  let changed = false;
  for (const f of frames) {
    if (f.server && !knownServers.has(f.server)) {
      knownServers.add(f.server);
      const opt = document.createElement("option");
      opt.value = f.server;
      opt.textContent = f.server;
      serverFilterEl.appendChild(opt);
      changed = true;
    }
  }
  // Restore selection (append may have reset it)
  if (changed) serverFilterEl.value = current;
}
```

- [ ] **Step 4: Update `matchesFilter` to respect server filter**

Replace the existing `matchesFilter` function:

```javascript
function matchesFilter(f) {
  if (serverFilterStr && f.server !== serverFilterStr) return false;
  if (!filterStr) return true;
  const c = classify(f);
  const hay = [
    c.method ?? "",
    String(c.id ?? ""),
    JSON.stringify(f.frame),
  ].join(" ").toLowerCase();
  return hay.includes(filterStr);
}
```

- [ ] **Step 5: Call `updateServerFilter()` inside `render()` and wire the change event**

At the top of the `render()` function add:

```javascript
updateServerFilter();
```

After the filter `input` event listener add:

```javascript
serverFilterEl.addEventListener("change", () => {
  serverFilterStr = serverFilterEl.value;
  render();
});
```

- [ ] **Step 6: Build and manually verify**

```
pnpm build
```

Start the hub against two fake servers. Dropdown should populate with server names and filter the timeline.

- [ ] **Step 7: Commit**

```
git add ui/index.html
git commit -m "feat(ui): server filter dropdown"
```

---

## Task 10: UI — Topology tab

**Files:**
- Modify: `ui/index.html`

- [ ] **Step 1: Add tab CSS inside `<style>`**

Add after the existing `header .total.zero` rule:

```css
.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); background: var(--panel); }
.tab {
  padding: 10px 20px; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase;
  cursor: pointer; border-bottom: 2px solid transparent; color: var(--muted);
}
.tab:hover { color: var(--fg); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.panel { display: none; }
.panel.active { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.topo-wrap { flex: 1; overflow: hidden; position: relative; }
.topo-tooltip {
  position: absolute; background: #1a1a1a; border: 1px solid var(--border);
  border-radius: 4px; padding: 8px 12px; font-size: 11px; pointer-events: none;
  display: none; max-width: 240px; z-index: 10;
}
```

- [ ] **Step 2: Restructure the `<main>` HTML to include tabs and two panels**

Replace the entire `<main>` block:

```html
<main style="display:flex;flex-direction:column;min-height:0">
  <div class="tabs">
    <div class="tab active" data-tab="timeline">Timeline</div>
    <div class="tab" data-tab="topology">Topology</div>
  </div>
  <!-- Timeline panel -->
  <div id="panel-timeline" class="panel active" style="display:flex;flex:1;min-height:0">
    <div class="timeline">
      <div class="filter-bar">
        <input id="filter" type="search" placeholder="Filter by method or body — Esc to clear" autocomplete="off" spellcheck="false" />
        <select id="server-filter"><option value="">All servers</option></select>
        <span class="count" id="filter-count"></span>
      </div>
      <div class="rows" id="rows"></div>
    </div>
    <div class="detail" id="detail">
      <div class="empty">Select a frame to inspect.</div>
    </div>
  </div>
  <!-- Topology panel -->
  <div id="panel-topology" class="panel" style="flex:1;min-height:0">
    <div class="topo-wrap" id="topo-wrap">
      <div class="empty" id="topo-empty">Waiting for multi-server frames…</div>
    </div>
    <div class="topo-tooltip" id="topo-tooltip"></div>
  </div>
</main>
```

- [ ] **Step 3: Add tab switching and topology rendering to the `<script>` block**

Add after `const fcount = ...`:

```javascript
const topoWrap   = document.getElementById("topo-wrap");
const topoTooltip = document.getElementById("topo-tooltip");
let activeTab = "timeline";

// Tab switching
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    activeTab = tab.dataset.tab;
    for (const t of document.querySelectorAll(".tab"))   t.classList.toggle("active", t.dataset.tab === activeTab);
    for (const p of document.querySelectorAll(".panel")) p.classList.toggle("active", p.id === `panel-${activeTab}`);
    if (activeTab === "topology") renderTopology();
  });
}

function switchToTimeline(server) {
  activeTab = "timeline";
  for (const t of document.querySelectorAll(".tab"))   t.classList.toggle("active", t.dataset.tab === "timeline");
  for (const p of document.querySelectorAll(".panel")) p.classList.toggle("active", p.id === "panel-timeline");
  if (server !== undefined) {
    serverFilterEl.value = server;
    serverFilterStr = server;
    render();
  }
}

// Topology rendering
function renderTopology() {
  // Group tool calls by server
  const callsByServer = {};
  for (const f of frames) {
    if (!f.server) continue;
    if (!callsByServer[f.server]) callsByServer[f.server] = [];
    const c = classify(f);
    if (c.kind === "request") callsByServer[f.server].push(f);
  }
  const serverNames = Object.keys(callsByServer);

  if (serverNames.length === 0) {
    topoWrap.innerHTML = '<div class="empty">Waiting for multi-server frames…</div>';
    return;
  }

  const W = topoWrap.clientWidth  || 800;
  const H = topoWrap.clientHeight || 500;
  const cx = W / 2;
  const cy = H / 2;
  const radius = Math.min(W, H) * 0.35;
  const count = serverNames.length;

  let svgParts = [`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`];

  // Edges
  serverNames.forEach((name, i) => {
    const angle = (2 * Math.PI * i / count) - Math.PI / 2;
    const nx = cx + radius * Math.cos(angle);
    const ny = cy + radius * Math.sin(angle);
    const weight = Math.min(6, 1 + (callsByServer[name].length / 5));
    const color = serverColor(name);
    svgParts.push(`<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="${color}" stroke-width="${weight.toFixed(1)}" opacity="0.35"/>`);
  });

  // Agent node
  svgParts.push(`<circle cx="${cx}" cy="${cy}" r="22" fill="#1a1a1a" stroke="#555" stroke-width="1.5"/>`);
  svgParts.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="#8a8a8a" font-size="10" font-family="monospace">agent</text>`);

  // Server nodes
  serverNames.forEach((name, i) => {
    const angle = (2 * Math.PI * i / count) - Math.PI / 2;
    const nx = cx + radius * Math.cos(angle);
    const ny = cy + radius * Math.sin(angle);
    const calls = callsByServer[name].length;
    const r = Math.min(44, 20 + calls * 1.5);
    const color = serverColor(name);
    svgParts.push(`<circle cx="${nx}" cy="${ny}" r="${r}" fill="#111" stroke="${color}" stroke-width="1.5" data-server="${escapeHtml(name)}" style="cursor:pointer"/>`);
    svgParts.push(`<text x="${nx}" y="${ny + 4}" text-anchor="middle" fill="${color}" font-size="11" font-family="monospace" pointer-events="none">${escapeHtml(name)}</text>`);
    svgParts.push(`<text x="${nx}" y="${ny + 17}" text-anchor="middle" fill="${color}" opacity="0.65" font-size="10" font-family="monospace" pointer-events="none">${calls} call${calls === 1 ? "" : "s"}</text>`);
  });

  svgParts.push("</svg>");
  topoWrap.innerHTML = svgParts.join("");

  // Hover + click on server nodes
  for (const circle of topoWrap.querySelectorAll("circle[data-server]")) {
    const server = circle.getAttribute("data-server");
    circle.addEventListener("mouseenter", (ev) => {
      const recent = (callsByServer[server] || []).slice(-3).reverse();
      if (!recent.length) return;
      topoTooltip.innerHTML = recent.map((f) => {
        const c = classify(f);
        return `<div style="margin-bottom:4px"><span style="color:${serverColor(server)}">${escapeHtml(c.method ?? "?")}</span></div>`;
      }).join("");
      topoTooltip.style.display = "block";
      topoTooltip.style.left = `${ev.offsetX + 12}px`;
      topoTooltip.style.top  = `${ev.offsetY + 8}px`;
    });
    circle.addEventListener("mousemove", (ev) => {
      topoTooltip.style.left = `${ev.offsetX + 12}px`;
      topoTooltip.style.top  = `${ev.offsetY + 8}px`;
    });
    circle.addEventListener("mouseleave", () => {
      topoTooltip.style.display = "none";
    });
    circle.addEventListener("click", () => {
      switchToTimeline(server);
    });
  }
}
```

- [ ] **Step 4: Re-render topology on new frames when topology tab is active**

Inside the WebSocket `onmessage` handler, after `render()` add:

```javascript
if (activeTab === "topology") renderTopology();
```

- [ ] **Step 5: Build**

```
pnpm build
```

- [ ] **Step 6: Commit**

```
git add ui/index.html
git commit -m "feat(ui): topology tab — radial graph with hover + click drill-down"
```

---

## Task 11: End-to-end smoke test

- [ ] **Step 1: Start two fake proxy instances**

Open two PowerShell terminals:

Terminal A:
```
cd C:\mcp-devtools
node dist/cli.js proxy --upstream "node smoke/fake-server.js" --port 7457 --no-open --quiet
```

Terminal B:
```
cd C:\mcp-devtools
node dist/cli.js proxy --upstream "node smoke/fake-server.js" --port 7458 --no-open --quiet
```

- [ ] **Step 2: Start the hub**

Terminal C:
```
cd C:\mcp-devtools
node dist/cli.js hub --upstream filesystem:localhost:7457 --upstream github:localhost:7458 --port 7456 --no-open
```

Expected log:
```
hub ready → http://localhost:7456/inspect/
aggregating 2 upstreams
hub connected → filesystem (ws://localhost:7457/ws)
hub connected → github (ws://localhost:7458/ws)
```

- [ ] **Step 3: Verify the UI**

Open `http://localhost:7456/inspect/` in a browser.

- Timeline tab loads with 0 frames and no errors in the browser console.
- "All servers" dropdown is present in the filter bar.
- Switching to Topology tab shows "Waiting for multi-server frames…" (no frames yet).

- [ ] **Step 4: Test the generate command**

```
node dist/cli.js generate --config docs/superpowers/specs/../../../smoke/../servers-example.yaml --out /tmp/test-compose.yml
```

Create `smoke/servers-example.yaml` first:

```yaml
servers:
  - name: filesystem
    command: node smoke/fake-server.js
  - name: github
    command: node smoke/fake-server.js
```

Then:
```
node dist/cli.js generate --config smoke/servers-example.yaml --out /tmp/test-compose.yml && cat /tmp/test-compose.yml
```

Expected: valid docker-compose.yml with proxy-filesystem, proxy-github, and hub services.

- [ ] **Step 5: Run the full test suite one final time**

```
pnpm test
```

Expected: all pass.

- [ ] **Step 6: Final commit**

```
git add smoke/servers-example.yaml
git commit -m "chore: add servers-example.yaml for smoke testing"
```
