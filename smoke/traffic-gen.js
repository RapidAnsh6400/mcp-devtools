/**
 * MCP traffic generator for manual UI testing.
 *
 * Spawns two proxy instances (filesystem :7457, github :7458) and pumps
 * realistic tool-call traffic through them so the hub UI shows live badges,
 * server filtering, and a populated topology graph.
 *
 * Usage (3 terminals):
 *
 *   Terminal 1:  node smoke/traffic-gen.js
 *   Terminal 2:  node dist/cli.js hub \
 *                  --upstream filesystem:localhost:7457 \
 *                  --upstream github:localhost:7458 \
 *                  --port 7456 --no-open
 *   Browser:     http://localhost:7456/inspect/
 */
import { spawn } from 'node:child_process';

const SERVERS = [
  {
    name: 'filesystem',
    port: 7457,
    tools: ['read_file', 'write_file', 'list_directory', 'delete_file', 'move_file'],
  },
  {
    name: 'github',
    port: 7458,
    tools: ['search_repositories', 'get_file_contents', 'create_issue', 'list_pull_requests'],
  },
];

let reqId = 1;

function frame(method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id: reqId++, method, params }) + '\n';
}

function startProxy(server) {
  const proc = spawn('node', [
    'dist/cli.js', 'proxy',
    '--upstream', 'node smoke/fake-server.js',
    '--port', String(server.port),
    '--no-open', '--quiet',
  ], { stdio: ['pipe', 'pipe', 'inherit'] });

  proc.on('error', (err) => console.error(`[${server.name}] spawn error: ${err.message}`));
  proc.on('exit', (code) => {
    if (code !== 0) console.error(`[${server.name}] proxy exited with code ${code}`);
  });

  // Give the proxy ~1.5 s to start, then run the MCP handshake + periodic tool calls
  setTimeout(() => {
    proc.stdin.write(frame('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'traffic-gen', version: '1.0' },
    }));
    proc.stdin.write(frame('tools/list'));

    let i = 0;
    setInterval(() => {
      const tool = server.tools[i % server.tools.length];
      proc.stdin.write(frame('tools/call', {
        name: tool,
        arguments: { path: `/data/${tool}-${i}.txt` },
      }));
      console.log(`[${server.name}] → tools/call  ${tool}`);
      i++;
    }, 1500);
  }, 1500);
}

console.log('Starting proxies on :7457 (filesystem) and :7458 (github)...\n');
console.log('Next steps:');
console.log('  1. Run in another terminal:');
console.log('       node dist/cli.js hub --upstream filesystem:localhost:7457 --upstream github:localhost:7458 --port 7456 --no-open');
console.log('  2. Open http://localhost:7456/inspect/\n');

SERVERS.forEach(startProxy);
