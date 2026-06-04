import { describe, expect, it } from "vitest";
import { parseServersYaml, generateDockerCompose } from "./generate.js";

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

  it("throws on command containing double-quotes", () => {
    const yaml = `
servers:
  - name: test
    command: node x.js --arg "bad"
`;
    expect(() => parseServersYaml(yaml)).toThrow(/double-quote/);
  });
});

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
    const hubIdx = out.indexOf("hub:");
    const proxy1Idx = out.indexOf("proxy-filesystem:");
    expect(out.indexOf('"7456:7456"')).toBeGreaterThan(hubIdx);
    const proxy1Section = out.slice(proxy1Idx, hubIdx);
    expect(proxy1Section).not.toContain("ports:");
  });

  it("includes a shared mcp-internal bridge network", () => {
    const out = generateDockerCompose(config);
    expect(out).toContain("mcp-internal:");
    expect(out).toContain("driver: bridge");
  });
});
