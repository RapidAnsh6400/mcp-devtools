# Multi-Server Hub — Design Spec

**Date:** 2026-06-04  
**Status:** Approved

---

## Problem

Running `mcp-devtools proxy` once watches one MCP server. To watch three servers you need three terminal windows and three browser tabs. When an agent talks to 4+ MCP servers simultaneously the flat per-server timelines are unreadable — you can't see the cross-server call pattern at a glance.

## Goal

One command, one browser tab, all servers visible. A topology view makes the system legible when many servers are active at once.

---

## Architecture

Two new commands are added to the CLI:

- **`mcp-devtools generate`** — reads a config file, writes a `docker-compose.yml`
- **`mcp-devtools hub`** — aggregates frame streams from multiple running proxies into one UI

### End-to-end flow

```
You write servers.yaml
       ↓
mcp-devtools generate --config servers.yaml --out docker-compose.yml
       ↓
docker compose up
       ↓
┌─────────────────── container network ───────────────────┐
│  proxy-filesystem  :7457  →  node servers/filesystem.js  │
│  proxy-github      :7458  →  node servers/github.js      │
│  proxy-database    :7459  →  python servers/db.py        │
│  hub               :7456  ← polls all proxies' /ws       │
└──────────────────────────────────────────────────────────┘
       ↓  (only 7456 exposed to host)
browser → localhost:7456/inspect/  (sees all servers)
```

The per-server proxies are the **existing `proxy` command unchanged**. The hub is new.

---

## Config File Format

`servers.yaml`:

```yaml
servers:
  - name: filesystem
    command: "node servers/filesystem.js /data"
  - name: github
    command: "node servers/github.js"
  - name: database
    command: "python servers/db.py"
```

Each entry: a `name` (used as the Docker service name and server label in the UI) and a `command` (identical to `--upstream` today).

---

## `generate` Command

```bash
mcp-devtools generate --config servers.yaml --out docker-compose.yml
```

Reads `servers.yaml` and writes a `docker-compose.yml` where:

- Each server gets a `proxy-<name>` service running the existing proxy on an internal port (7457, 7458, … incrementing per server)
- A `hub` service on port 7456 is the only service with `ports:` exposed to the host
- The hub receives `--upstream filesystem:7457 --upstream github:7458 …` matching the service names and ports
- All services share a private Docker bridge network so the hub can reach proxies by service name

The `generate` command is pure string templating — no Docker dependency in the code itself.

---

## `hub` Command

```bash
mcp-devtools hub \
  --upstream filesystem:proxy-filesystem:7457 \
  --upstream github:proxy-github:7458 \
  --port 7456
```

Each `--upstream` value is `<label>:<host>:<port>`:
- `label` — display name shown in the UI and stamped on frames as `server`
- `host` — hostname reachable from the hub (Docker service name inside the network; `localhost` outside Docker)
- `port` — the proxy's internal port

The `generate` command fills in the correct Docker hostnames automatically.

On startup the hub does two things in parallel:

**1. Aggregate frames from all proxies**

For each upstream, it opens a WebSocket to `ws://<host>:<port>/ws` — the same `/ws` endpoint already served by `ui-server.ts`. When a frame arrives it stamps it with `server: "<label>"` and writes it into a shared `TraceStore`.

If a proxy disconnects, the hub reconnects automatically with exponential backoff. Proxies that haven't started yet are retried until they come up — this handles Docker startup ordering without requiring `depends_on` health checks.

**2. Serve the UI**

Calls the existing `startUiServer()` on its own port. The browser talks to the hub exactly like it talks to a single proxy today. The only runtime difference is frames carry a `server` field.

```
hub
 ├─ ws client → proxy-filesystem:7457/ws  → tags server="filesystem"
 ├─ ws client → proxy-github:7458/ws      → tags server="github"
 └─ startUiServer(:7456)
     ├─ GET /api/frames   → shared TraceStore
     ├─ WS  /ws           → pushes to browser
     └─ GET /inspect/     → static UI
```

---

## Data Model

One field added to `StoredFrame` in `trace-store.ts`:

```ts
export interface StoredFrame {
  id: number;
  direction: "in" | "out";
  ts: number;
  server?: string;   // set by hub; undefined in single-server proxy mode
  frame: JsonRpcFrame;
}
```

`server` is optional. The existing `proxy` command continues to work unchanged — it never sets the field. `TraceStore` itself requires no changes.

---

## UI Changes

Three additions to `ui/index.html`:

### 1. Server badge on timeline rows

When `frame.server` is set, a small colored pill renders next to the method name — e.g. `[filesystem]`. Each server gets a consistent color derived from a hash of its name against a fixed palette. In single-server mode (`server` is undefined) no badge appears — no visual regression.

### 2. Server filter dropdown

A dropdown added to the filter bar beside the existing search input. Default: "All servers". Selecting a server filters the timeline to that server's frames only. Clicking a node in the topology view sets this dropdown automatically.

### 3. Topology tab

A second tab at the top: **Timeline** (default) | **Topology**.

The topology view is a force-directed node-and-edge graph built from the frames already in memory — no external library, plain canvas/SVG:

- **Nodes** — one per unique `server` value. Node size scales with call volume.
- **Edges** — from a virtual "agent" node to each server node. Edge weight = count of `tools/call` frames to that server.
- **Hover** — shows the last 3 tool calls to that server (method name + latency).
- **Click** — switches to Timeline tab with the server filter set to that server.

**Attribution** is already solved at the hub layer: every frame has `server` stamped before it reaches the UI. The topology view is a read over `frames.filter(f => f.frame.method === 'tools/call')` grouped by `f.server` — no inference required.

---

## Files Changed

| File | Change |
|---|---|
| `src/generate.ts` | New — reads `servers.yaml`, writes `docker-compose.yml` |
| `src/hub.ts` | New — WS client per proxy, shared TraceStore, starts UI server |
| `src/cli.ts` | Add `generate` and `hub` commands |
| `src/trace-store.ts` | Add `server?: string` to `StoredFrame` interface |
| `ui/index.html` | Server badges, server filter dropdown, Topology tab |

All other files — `proxy.ts`, `ui-server.ts`, `recorder.ts`, analysis commands — are untouched.

---

## Out of Scope

- HTTP/SSE upstream support (hub uses the same stdio proxy it already does)
- Authentication or multi-user access to the hub UI
- Persisting cross-server sessions to `.mcptrace` files (single-server record command handles that independently)
