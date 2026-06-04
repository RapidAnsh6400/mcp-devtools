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
