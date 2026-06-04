/**
 * mcp-devtools CLI entry point.
 *
 * Subcommands:
 *   proxy     spin up a transparent MCP proxy + browser UI
 *   record    record a session to a .mcptrace file
 *   open      open a previously recorded .mcptrace file in the UI
 *   doctor    probe an upstream MCP server for spec compliance
 *   diff      compare two .mcptrace files structurally
 *   profile   per-method latency profiler for a .mcptrace file
 *   summary   one-shot overview combining profile + cost + error breakdown
 *   cost      focused per-trace cost gate (exits 1 if over --budget)
 *   serve     replay a .mcptrace as a fake MCP server over stdio
 *   bench     benchmark replay throughput (frames/sec, time to drain)
 *   tail      live `tail -f`-style viewer for a .mcptrace
 *   version   print version
 *
 * Global flags:
 *   --quiet   suppress informational logs (warnings and errors still print)
 */
import { cac } from "cac";
import kleur from "kleur";
import { benchTrace, formatBench, printBenchJson } from "./bench.js";
import {
  type CallOptions,
  callTool,
  exitCodeFor,
  formatCallResultHuman,
  formatCallResultJson,
} from "./call.js";
import { formatCostGate, printCostGateJson, runCostGate } from "./cost.js";
import { diffFrames, formatDiffReport, readTrace } from "./diff.js";
import { printResults, printResultsJson, runDoctor } from "./doctor.js";
import { loadServersConfig, writeDockerCompose } from "./generate.js";
import { type HubOptions, parseHubUpstream, startHub } from "./hub.js";
import { formatProfile, printProfileJson, profileTrace } from "./profile.js";
import { startProxy } from "./proxy.js";
import { parseSize, startRecorder } from "./recorder.js";
import { startReplay } from "./replay.js";
import { formatSummary, printSummaryJson, summarizeTrace } from "./summary.js";
import { createPrinter, tailTrace } from "./tail.js";
import { log, setQuiet } from "./util/log.js";
import { validatePort } from "./util/validate-port.js";
import { openTrace } from "./viewer.js";

const VERSION = "0.1.0";
const cli = cac("mcp-devtools");

cli
  .command("proxy", "Start a transparent MCP proxy with a live inspector UI")
  .option("--upstream <cmd>", "Command (stdio) or URL (http) for the upstream MCP server")
  .option("--port <port>", "Port for the UI and proxy endpoint", { default: 7456 })
  .option("--transport <type>", "stdio | http", { default: "stdio" })
  .option("--no-open", "Don't auto-open the browser")
  .option("--model <id>", "Active model id for cost attribution (e.g. claude-sonnet-4-6)")
  .option("--pricing-file <path>", "YAML file of per-token rates; overrides the built-in table")
  .option(
    "--header <kv>",
    "Extra HTTP header for the upstream (http transport). Repeatable. Format: 'Name: value'",
    { type: [String] },
  )
  .option("--quiet", "Suppress informational logs")
  .action(async (opts) => {
    setQuiet(!!opts.quiet);
    if (!opts.upstream) {
      console.error("error: --upstream is required");
      process.exit(1);
    }
    const port = validatePort(opts.port);
    if (!port.ok) {
      console.error(port.message);
      process.exit(1);
    }
    const httpHeaders = parseHeaderFlags(opts.header);
    await startProxy({
      upstreamCommand: opts.upstream,
      port: port.value,
      transport: opts.transport,
      openBrowser: opts.open !== false,
      modelId: opts.model,
      pricingFile: opts.pricingFile,
      httpHeaders,
    });
  });

/** Parse `--header 'Name: value'` flags into a header bag. */
function parseHeaderFlags(raw: unknown): Record<string, string> | undefined {
  if (!raw) return undefined;
  // cac with `type: [String]` collects repeats into an array, but it stringifies
  // a literal `undefined` into the array when the flag is omitted ("undefined"
  // is what comes through). Drop those alongside empty strings.
  const list = (Array.isArray(raw) ? (raw as unknown[]) : [raw]).filter(
    (v) => typeof v === "string" && v.length > 0 && v !== "undefined",
  ) as string[];
  if (list.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const item of list) {
    const idx = item.indexOf(":");
    if (idx === -1) {
      console.error(`error: --header expects 'Name: value', got: ${item}`);
      process.exit(1);
    }
    const name = item.slice(0, idx).trim().toLowerCase();
    const value = item.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

cli
  .command("record", "Record an MCP session to disk")
  .option("--upstream <cmd>", "Command that launches the upstream MCP server")
  .option("--out <path>", "Output file", { default: "session.mcptrace" })
  .option(
    "--rotate <size>",
    "Rotate the trace when it grows past this size (e.g. '10MB', '500KB', '1GB'). Disabled when omitted.",
  )
  .option("--keep <N>", "Maximum number of rotated files to retain", { default: 3 })
  .option("--quiet", "Suppress informational logs")
  .action(async (opts) => {
    setQuiet(!!opts.quiet);
    if (!opts.upstream) {
      console.error("error: --upstream is required");
      process.exit(1);
    }
    let rotateBytes: number | undefined;
    if (opts.rotate != null) {
      try {
        rotateBytes = parseSize(String(opts.rotate));
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    const keep = Number(opts.keep);
    if (!Number.isFinite(keep) || keep <= 0 || !Number.isInteger(keep)) {
      console.error(`error: --keep must be a positive integer, got ${JSON.stringify(opts.keep)}`);
      process.exit(1);
    }
    await startRecorder({
      upstreamCommand: opts.upstream,
      outPath: opts.out,
      rotateBytes,
      keep,
    });
  });

cli
  .command("open <file>", "Open a recorded .mcptrace file in the UI")
  .option("--port <port>", "Port for the UI", { default: 7456 })
  .option("--quiet", "Suppress informational logs")
  .action(async (file: string, opts) => {
    setQuiet(!!opts.quiet);
    const port = validatePort(opts.port);
    if (!port.ok) {
      console.error(port.message);
      process.exit(1);
    }
    await openTrace({ tracePath: file, port: port.value });
  });

cli
  .command("doctor", "Probe an upstream MCP server for spec compliance")
  .option("--upstream <cmd>", "Command that launches the upstream MCP server")
  .option("--timeout <ms>", "Per-request timeout in ms", { default: 5000 })
  .option("--json", "Emit a single JSON envelope to stdout (no colors, no per-check lines)")
  .option("--quiet", "Suppress informational logs")
  .action(async (opts) => {
    // When --json is set we want the JSON envelope to be the *only* thing on
    // stdout — info chatter still goes to stderr but we silence it by default
    // so `... --json | jq .` Just Works. Users can opt back in with explicit
    // logging if they ever want it.
    setQuiet(!!opts.quiet || !!opts.json);
    if (!opts.upstream) {
      console.error("error: --upstream is required");
      process.exit(1);
    }
    const results = await runDoctor({
      upstreamCommand: opts.upstream,
      timeout: Number(opts.timeout),
    });
    if (opts.json) {
      printResultsJson(results, { version: VERSION, upstream: opts.upstream });
    } else {
      printResults(results);
    }
    process.exit(results.every((r) => r.passed) ? 0 : 1);
  });

cli
  .command("diff <baseline> <current>", "Compare two .mcptrace files structurally")
  .option("--quiet", "Suppress informational logs")
  .action(async (baselinePath: string, currentPath: string, opts) => {
    setQuiet(!!opts.quiet);
    try {
      const [baseline, current] = await Promise.all([
        readTrace(baselinePath),
        readTrace(currentPath),
      ]);
      const report = diffFrames(baseline, current);
      if (report.identical) {
        process.stdout.write(`${kleur.green("✓")} ${formatDiffReport(report)}\n`);
        process.exit(0);
      }
      process.stdout.write(`${kleur.red("✗")} ${formatDiffReport(report)}\n`);
      process.exit(1);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("profile <trace>", "Profile per-method latency in a .mcptrace file")
  .option("--json", "Emit a single JSON envelope to stdout (no colors, no table)")
  .option("--quiet", "Suppress informational logs")
  .action(async (tracePath: string, opts) => {
    // Mirror the doctor convention — --json implies --quiet so the envelope is
    // the only thing on stdout for `... | jq .` pipelines.
    setQuiet(!!opts.quiet || !!opts.json);
    try {
      const result = await profileTrace(tracePath);
      if (opts.json) {
        printProfileJson(result);
      } else {
        process.stdout.write(`${formatProfile(result)}\n`);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("summary <trace>", "One-shot overview: profile + cost + error breakdown")
  .option("--model <id>", "Active model id for cost attribution (e.g. gpt-4o-mini)")
  .option("--pricing-file <path>", "YAML file of per-token rates; overrides the built-in table")
  .option("--json", "Emit a single JSON envelope to stdout (no colors, no table)")
  .option("--quiet", "Suppress informational logs")
  .action(async (tracePath: string, opts) => {
    // Mirror profile/doctor: --json implies --quiet so the envelope is the
    // only thing on stdout for `... | jq .` pipelines.
    setQuiet(!!opts.quiet || !!opts.json);
    try {
      const result = await summarizeTrace({
        tracePath,
        modelId: opts.model,
        pricingFile: opts.pricingFile,
      });
      if (opts.json) {
        printSummaryJson(result);
      } else {
        process.stdout.write(`${formatSummary(result)}\n`);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("cost <trace>", "Cost gate: priced total for a trace; exit 1 if over --budget")
  .option("--model <id>", "Active model id for cost attribution (required)")
  .option("--pricing-file <path>", "YAML file of per-token rates; overrides the built-in table")
  .option("--budget <usd>", "Fail (exit 1) if the priced total strictly exceeds this many USD")
  .option("--json", "Emit a single JSON envelope to stdout (no colors, no table)")
  .option("--quiet", "Suppress informational logs")
  .action(async (tracePath: string, opts) => {
    // Mirror profile/summary/doctor: --json implies --quiet so the envelope
    // is the only thing on stdout for `... | jq .` pipelines.
    setQuiet(!!opts.quiet || !!opts.json);
    if (!opts.model) {
      process.stderr.write(`${kleur.red("error:")} --model <id> is required\n`);
      process.exit(2);
    }
    let budgetUsd: number | undefined;
    if (opts.budget != null) {
      const parsed = Number(opts.budget);
      if (!Number.isFinite(parsed) || parsed < 0) {
        process.stderr.write(
          `${kleur.red("error:")} --budget must be a non-negative number, got ${JSON.stringify(opts.budget)}\n`,
        );
        process.exit(2);
      }
      budgetUsd = parsed;
    }
    try {
      const result = await runCostGate({
        tracePath,
        modelId: opts.model,
        pricingFile: opts.pricingFile,
        budgetUsd,
      });
      if (opts.json) {
        printCostGateJson(result);
      } else {
        process.stdout.write(`${formatCostGate(result)}\n`);
      }
      // Exit 0 if no budget or under budget; 1 if over.
      process.exit(result.overBudget ? 1 : 0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      // I/O or config error (e.g. missing trace, bad YAML, missing model)
      process.exit(2);
    }
  });

cli
  .command("serve", "Replay a .mcptrace as a fake MCP server over stdio")
  .option("--replay <trace>", "Path to a .mcptrace file to replay")
  .option("--strict", "Reject unknown methods with -32601 (default)", { default: true })
  .option("--no-strict", "Return a canned { result: {} } for unknown methods")
  .option("--quiet", "Suppress informational logs")
  .action(async (opts) => {
    setQuiet(!!opts.quiet);
    if (!opts.replay) {
      console.error("error: --replay <trace> is required");
      process.exit(1);
    }
    try {
      // strict defaults to true; --no-strict flips it via cac's negation flag.
      const handle = await startReplay({ tracePath: opts.replay, strict: opts.strict !== false });
      // Stay alive until stdin closes — same lifecycle as `proxy` stdio mode.
      await handle.done;
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("bench <trace>", "Benchmark replay throughput (frames/sec, time to drain)")
  .option("--iterations <N>", "Number of measured drain runs", { default: 1 })
  .option("--warmup <N>", "Number of warmup runs to discard before measuring", { default: 0 })
  .option("--json", "Emit a single JSON envelope to stdout (no colors, no table)")
  .option("--quiet", "Suppress informational logs")
  .action(async (tracePath: string, opts) => {
    // Mirror profile/summary/cost: --json implies --quiet so the envelope is
    // the only thing on stdout for `... | jq .` pipelines.
    setQuiet(!!opts.quiet || !!opts.json);
    const iterations = Number(opts.iterations);
    if (!Number.isFinite(iterations) || !Number.isInteger(iterations) || iterations < 1) {
      process.stderr.write(
        `${kleur.red("error:")} --iterations must be a positive integer, got ${JSON.stringify(opts.iterations)}\n`,
      );
      process.exit(2);
    }
    const warmup = Number(opts.warmup);
    if (!Number.isFinite(warmup) || !Number.isInteger(warmup) || warmup < 0) {
      process.stderr.write(
        `${kleur.red("error:")} --warmup must be a non-negative integer, got ${JSON.stringify(opts.warmup)}\n`,
      );
      process.exit(2);
    }
    try {
      const result = await benchTrace({ tracePath, iterations, warmup });
      if (opts.json) {
        printBenchJson(result);
      } else {
        process.stdout.write(`${formatBench(result)}\n`);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command("tail <trace>", "Live `tail -f`-style viewer for a .mcptrace file")
  .option("--from-start", "Read the trace from the beginning (default)")
  .option("--from-end", "Skip existing content and only show frames appended after we attach")
  .option("--no-follow", "Print existing frames and exit instead of following appends")
  .option("--quiet", "Suppress informational logs")
  .action(async (tracePath: string, opts) => {
    setQuiet(!!opts.quiet);
    // --from-end wins over --from-start when both are passed; --from-start is
    // the documented default and serves as an explicit opt-in for readability.
    const since: "start" | "end" = opts.fromEnd ? "end" : "start";
    // cac's --no-X flips opts.X to false; default is undefined → follow.
    const follow = opts.follow !== false;
    try {
      const print = createPrinter((line) => process.stdout.write(`${line}\n`));
      const handle = await tailTrace({ path: tracePath, since, follow, onLine: print });
      if (!follow) {
        // Initial drain has already run synchronously inside tailTrace; tear
        // down and exit so the user gets their shell prompt back.
        await handle.stop();
        process.exit(0);
      }
      // Follow mode: hold the process open, stop cleanly on Ctrl-C.
      const shutdown = async () => {
        await handle.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err) {
      process.stderr.write(`${kleur.red("error:")} ${(err as Error).message}\n`);
      process.exit(1);
    }
  });

cli
  .command(
    "call <tool>",
    "Single-shot tool invocation against an upstream MCP server (non-interactive)",
  )
  .option("--upstream <cmd>", "Command (stdio) or URL (http) for the upstream MCP server")
  .option("--args <json>", "Tool arguments as a JSON object (default '{}')")
  .option("--transport <type>", "stdio | http", { default: "stdio" })
  .option("--timeout <ms>", "Per-request timeout in ms", { default: 10_000 })
  .option(
    "--header <kv>",
    "Extra HTTP header for the upstream (http transport). Repeatable. Format: 'Name: value'",
    { type: [String] },
  )
  .option("--json", "Emit a single JSON envelope to stdout (no colors, no per-step lines)")
  .option("--quiet", "Suppress informational logs")
  .action(async (tool: string, opts) => {
    // Mirror the doctor/profile convention — --json implies --quiet so the
    // envelope is the *only* thing on stdout for `... --json | jq .` pipelines.
    setQuiet(!!opts.quiet || !!opts.json);
    if (!opts.upstream) {
      process.stderr.write(`${kleur.red("error:")} --upstream is required\n`);
      process.exit(2);
    }
    const transport: "stdio" | "http" = opts.transport === "http" ? "http" : "stdio";
    const timeoutMs = Number(opts.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      process.stderr.write(
        `${kleur.red("error:")} --timeout must be a positive number, got ${JSON.stringify(opts.timeout)}\n`,
      );
      process.exit(2);
    }
    let parsedArgs: Record<string, unknown> | undefined;
    if (opts.args != null) {
      try {
        const v = JSON.parse(String(opts.args));
        if (v == null || typeof v !== "object" || Array.isArray(v)) {
          throw new Error("args must be a JSON object");
        }
        parsedArgs = v as Record<string, unknown>;
      } catch (err) {
        process.stderr.write(
          `${kleur.red("error:")} --args must be a JSON object: ${(err as Error).message}\n`,
        );
        process.exit(2);
      }
    }
    const httpHeaders = parseHeaderFlags(opts.header);
    const callOpts: CallOptions = {
      upstream: opts.upstream,
      toolName: tool,
      transport,
      timeoutMs,
    };
    if (parsedArgs !== undefined) callOpts.args = parsedArgs;
    if (httpHeaders !== undefined) callOpts.headers = httpHeaders;

    if (!opts.json) {
      process.stdout.write(`Calling ${kleur.bold(tool)}...\n`);
    }
    const result = await callTool(callOpts);
    if (opts.json) {
      // Single line — jq-friendly.
      process.stdout.write(`${formatCallResultJson(result)}\n`);
    } else {
      process.stdout.write(`${formatCallResultHuman(result)}\n`);
    }
    process.exit(exitCodeFor(result));
  });

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

cli.help();
cli.version(VERSION);
cli.parse();
