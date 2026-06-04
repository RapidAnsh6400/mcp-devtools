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
    if (/"/.test(current.command)) {
      throw new Error(`server "${current.name}" command must not contain double-quotes`);
    }
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

export function writeDockerCompose(config: GenerateConfig, outPath: string): void {
  writeFileSync(outPath, generateDockerCompose(config), "utf8");
}
