import readline from "readline";
import pc from "picocolors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { saveSessionCache } from "./cliConfig.js";

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

export interface PersistentSession {
  client: Client;
  transport: any;
  tools: any[];
  url: string;
  headers: Record<string, string>;
  transportType: "streamable" | "sse";
  close: () => Promise<void>;
}

function buildTransport(type: "streamable" | "sse", url: URL, headers: Record<string, string>) {
  if (type === "sse") {
    return new SSEClientTransport(url, {
      requestInit: { headers },
      eventSourceInit: { headers } as any,
    });
  }
  return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

/**
 * Establish a persistent MCP connection with keep-alive heartbeat and
 * transparent auto-reconnect. Tries Streamable HTTP first, then SSE.
 */
export async function connectPersistent(
  url: string,
  customHeaders?: Record<string, string>
): Promise<PersistentSession> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    ...(customHeaders || {}),
  };
  const urlObj = new URL(url);

  const attempts: Array<{ type: "streamable" | "sse"; url: URL }> = [];
  if (urlObj.pathname.endsWith("/sse")) {
    attempts.push({ type: "sse", url: urlObj });
    attempts.push({ type: "streamable", url: urlObj });
  } else {
    attempts.push({ type: "streamable", url: urlObj });
    attempts.push({ type: "sse", url: urlObj });
  }

  let lastErr: any = null;
  for (const attempt of attempts) {
    const client = new Client({ name: "mcp-cli-client", version: "1.0.6" }, { capabilities: {} } as any);
    const transport = buildTransport(attempt.type, attempt.url, headers);
    try {
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout connecting via ${attempt.type}`)), 8000)
      );
      await Promise.race([connectPromise, timeoutPromise]);

      let tools: any[] = [];
      try {
        const toolsRes: any = await client.listTools();
        tools = toolsRes.tools || [];
      } catch (_) {
        tools = [];
      }

      const session: PersistentSession = {
        client,
        transport,
        tools,
        url,
        headers,
        transportType: attempt.type,
        close: async () => {
          try { await transport.close(); } catch (_) {}
        },
      };

      // Keep-alive heartbeat with auto-reconnect
      const timer = setInterval(async () => {
        try {
          await session.client.listTools();
        } catch (err: any) {
          try { await session.transport.close(); } catch (_) {}
          try {
            const reconnected = await connectPersistent(url, customHeaders);
            session.client = reconnected.client;
            session.transport = reconnected.transport;
            session.transportType = reconnected.transportType;
          } catch (_) {
            // will retry on next heartbeat
          }
        }
      }, HEARTBEAT_INTERVAL_MS);
      (timer as any).unref?.();

      saveSessionCache(url, customHeaders);
      return session;
    } catch (err: any) {
      lastErr = err;
      try { await transport.close(); } catch (_) {}
    }
  }
  throw lastErr || new Error("All connection attempts failed");
}

/**
 * Launch an interactive REPL shell against an MCP server.
 * Commands: help, tools, call <name> [json-args], resources, exit
 */
export async function startRepl(url?: string, headers?: Record<string, string>): Promise<void> {
  if (!url) {
    console.error(pc.red("No server URL provided. Use: mcp shell <url> or --url <url>"));
    process.exit(1);
  }

  console.log(pc.cyan(`Connecting to ${url} ...`));
  let session: PersistentSession;
  try {
    session = await connectPersistent(url, headers);
  } catch (err: any) {
    console.error(pc.red(`Failed to connect: ${err.message || String(err)}`));
    process.exit(1);
    return;
  }
  console.log(pc.green(`✓ Connected (${session.transportType}). Type 'help' for commands.`));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: pc.bold("mcp> "),
  });
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    const [cmd, ...rest] = input.split(/\s+/);

    try {
      switch (cmd) {
        case "help":
          console.log(`Commands:
  tools                 List available tools
  call <name> [json]    Call a tool with optional JSON arguments
  resources             List available resources
  help                  Show this help
  exit | quit           Close the connection and exit`);
          break;
        case "tools": {
          const res: any = await session.client.listTools();
          for (const t of res.tools || []) {
            console.log(`  ${pc.cyan(t.name)}${t.description ? " - " + t.description : ""}`);
          }
          break;
        }
        case "resources": {
          const res: any = await session.client.listResources().catch(() => ({ resources: [] }));
          for (const r of res.resources || []) {
            console.log(`  ${pc.cyan(r.uri)}${r.name ? " - " + r.name : ""}`);
          }
          break;
        }
        case "call": {
          const name = rest[0];
          if (!name) { console.log(pc.yellow("Usage: call <name> [json-args]")); break; }
          let args: any = {};
          const jsonPart = rest.slice(1).join(" ");
          if (jsonPart) {
            try { args = JSON.parse(jsonPart); }
            catch { console.log(pc.red("Invalid JSON arguments.")); break; }
          }
          const result = await session.client.callTool({ name, arguments: args });
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        case "exit":
        case "quit":
          await session.close();
          rl.close();
          return;
        default:
          console.log(pc.yellow(`Unknown command: ${cmd}. Type 'help'.`));
      }
    } catch (err: any) {
      console.error(pc.red(`Error: ${err.message || String(err)}`));
    }
    rl.prompt();
  });

  rl.on("close", () => {
    console.log(pc.gray("\nConnection closed. Goodbye."));
    process.exit(0);
  });
}
