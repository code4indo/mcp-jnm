import { Command } from "commander";
import pc from "picocolors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const program = new Command();
const API_BASE = "http://localhost:3000/api/mcp";

// Get credentials from environment
const getAuthHeaders = () => {
  const user = process.env.DASHBOARD_USERNAME;
  const pass = process.env.DASHBOARD_PASSWORD;
  if (user && pass) {
    const b64 = Buffer.from(`${user}:${pass}`).toString('base64');
    return {
      "Content-Type": "application/json",
      "Authorization": `Basic ${b64}`
    };
  }
  return { "Content-Type": "application/json" };
};

program
  .name("mcp")
  .description("CLI to manage the local MCP Dashboard connection or connect directly")
  .version("1.0.5")
  .option("-u, --url <url>", "Connect to an MCP server URL directly (Standalone mode)")
  .option("-H, --header <header...>", "Custom headers for MCP server connection (e.g., -H 'Authorization: Bearer token')");

async function fetchApi(endpoint: string, options?: RequestInit) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: getAuthHeaders(),
      ...options,
    });
    return await res.json();
  } catch (err: any) {
    console.error(pc.red(`Error connecting to dashboard API: ${err.message}`));
    console.log(pc.yellow("Make sure the dashboard server is running (npm run dev) on port 3000."));
    console.log(pc.cyan("Alternatively, use the --url flag to run in standalone mode without the dashboard."));
    process.exit(1);
  }
}

function parseHeaders(headerArray?: string[]) {
  const customHeaders: Record<string, string> = {};
  if (headerArray) {
    for (const h of headerArray) {
      const [k, ...v] = h.split(":");
      if (k && v.length > 0) customHeaders[k.trim()] = v.join(":").trim();
    }
  }
  return customHeaders;
}

// Standalone mode helper
async function connectStandalone(url: string, customHeaders?: Record<string, string>) {
  const urlObj = new URL(url);
  const attempts: Array<{ type: "streamable" | "sse"; url: URL }> = [];
  
  if (urlObj.pathname.endsWith("/sse")) {
    attempts.push({ type: "sse", url: urlObj });
    attempts.push({ type: "streamable", url: urlObj });
    const altUrl = new URL(urlObj.href);
    altUrl.pathname = altUrl.pathname.replace(/\/sse$/, "/mcp");
    attempts.push({ type: "streamable", url: altUrl });
  } else {
    attempts.push({ type: "streamable", url: urlObj });
    attempts.push({ type: "sse", url: urlObj });
    const altUrl = new URL(urlObj.href);
    if (altUrl.pathname.endsWith("/mcp")) {
      altUrl.pathname = altUrl.pathname.replace(/\/mcp$/, "/sse");
      attempts.push({ type: "sse", url: altUrl });
    }
  }

  let connectedClient: Client | null = null;
  let connectedTransport: any = null;
  let lastErr: any = null;
  const mergedHeaders = { "Accept": "application/json, text/event-stream", ...(customHeaders || {}) };

  for (const attempt of attempts) {
    const client = new Client({ name: "mcp-cli-standalone", version: "1.0.0" }, { capabilities: {} } as any);
    let transport: any;
    if (attempt.type === "streamable") {
      transport = new StreamableHTTPClientTransport(attempt.url, {
        requestInit: { headers: mergedHeaders },
      });
    } else {
      transport = new SSEClientTransport(attempt.url, {
        requestInit: { headers: mergedHeaders },
        eventSourceInit: { headers: mergedHeaders } as any
      });
    }

    try {
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout`)), 8000));
      await Promise.race([connectPromise, timeoutPromise]);
      connectedClient = client;
      connectedTransport = transport;
      break;
    } catch (err: any) {
      lastErr = err;
      try { await transport.close(); } catch (_) {}
    }
  }

  if (!connectedClient || !connectedTransport) {
    throw lastErr || new Error("All connection attempts failed");
  }
  return { client: connectedClient, transport: connectedTransport };
}

program
  .command("status")
  .description("Get current MCP connection status")
  .action(async () => {
    const opts = program.opts();
    if (opts.url) {
      console.log(pc.yellow("Status command is only applicable to the dashboard. With --url, you are connecting statelessly. Use 'mcp --url <url>' without a command to test connection."));
      return;
    }
    const data = await fetchApi("/status");
    if (data.connected) {
      console.log(pc.green("✓ Connected"));
      console.log(`Server URL: ${pc.cyan(data.serverUrl)}`);
      if (data.serverVersion) {
        console.log(`Version: ${data.serverVersion.name} v${data.serverVersion.version}`);
      }
      console.log(pc.gray(`Available: ${data.tools?.length || 0} tools, ${data.resources?.length || 0} resources, ${data.prompts?.length || 0} prompts`));
    } else {
      console.log(pc.red("✗ Disconnected"));
      if (data.error) {
        console.log(`Last Error: ${pc.red(data.error)}`);
      }
    }
  });

program
  .command("connect <url>")
  .description("Connect dashboard to an MCP server")
  .action(async (url) => {
    const opts = program.opts();
    if (opts.url) {
      console.log(pc.yellow("You specified --url globally. Just use 'mcp --url <url>' to connect directly without dashboard."));
      return;
    }
    console.log(pc.cyan(`Connecting dashboard to ${url}...`));
    const headers = parseHeaders(opts.header);
    const data = await fetchApi("/connect", {
      method: "POST",
      body: JSON.stringify({ url, headers: Object.keys(headers).length > 0 ? headers : undefined }),
    });
    if (data.success) {
      console.log(pc.green("✓ Successfully connected dashboard"));
      console.log(`Found ${data.tools?.length || 0} tools.`);
    } else {
      console.log(pc.red(`✗ Failed to connect: ${data.error}`));
    }
  });

program
  .command("disconnect")
  .description("Disconnect dashboard from current MCP server")
  .action(async () => {
    const data = await fetchApi("/disconnect", { method: "POST" });
    if (data.success) {
      console.log(pc.green("✓ Disconnected dashboard"));
    }
  });

program
  .command("tools")
  .description("List available tools")
  .action(async () => {
    const opts = program.opts();
    let tools = [];
    if (opts.url) {
      console.log(pc.cyan(`Connecting to ${opts.url} (Standalone)...`));
      try {
        const headers = parseHeaders(opts.header);
        const { client, transport } = await connectStandalone(opts.url, headers);
        const res = await client.listTools();
        tools = res.tools || [];
        await transport.close();
      } catch (err: any) {
        console.error(pc.red(`✗ Failed to connect: ${err.message}`));
        process.exit(1);
      }
    } else {
      const data = await fetchApi("/status");
      if (!data.connected) {
        console.log(pc.red("Dashboard not connected to any MCP server."));
        return;
      }
      tools = data.tools || [];
    }

    if (tools.length === 0) {
      console.log(pc.yellow("No tools available."));
      return;
    }
    console.log(pc.bold("\nAvailable Tools:"));
    tools.forEach((t: any) => {
      console.log(`\n- ${pc.green(t.name)}: ${t.description || "No description"}`);
      if (t.inputSchema) {
        console.log(pc.gray(`  Schema: ${JSON.stringify(t.inputSchema)}`));
      }
    });
  });

program
  .command("call <name> [args...]")
  .description("Call an MCP tool with JSON arguments")
  .action(async (name, argsArray) => {
    let argsObj = {};
    if (argsArray.length > 0) {
      try {
        argsObj = JSON.parse(argsArray.join(" "));
      } catch (e) {
        console.error(pc.red("Invalid JSON arguments provided. Please provide a valid JSON string."));
        console.log(pc.gray(`Example: mcp call myTool '{"param":"value"}'`));
        return;
      }
    }
        
    const opts = program.opts();
    console.log(pc.cyan(`Calling tool '${name}'...`));
    
    if (opts.url) {
      try {
        const headers = parseHeaders(opts.header);
        const { client, transport } = await connectStandalone(opts.url, headers);
        const result = await client.callTool({ name, arguments: argsObj });
        console.log(pc.green("✓ Success\n"));
        console.log(JSON.stringify(result, null, 2));
        await transport.close();
      } catch (err: any) {
        console.error(pc.red(`✗ Error: ${err.message}`));
      }
    } else {
      const statusData = await fetchApi("/status");
      if (!statusData.connected) {
         console.log(pc.red("Dashboard not connected to any MCP server."));
         return;
      }
      const data = await fetchApi("/call-tool", {
        method: "POST",
        body: JSON.stringify({ serverUrl: statusData.serverUrl || statusData.connections?.[0]?.serverUrl, name, arguments: argsObj }),
      });
          
      if (data.success) {
        console.log(pc.green("✓ Success\n"));
        console.log(JSON.stringify(data.result, null, 2));
      } else {
        console.log(pc.red(`✗ Error: ${data.error}`));
      }
    }
  });

program.action(async () => {
  const opts = program.opts();
  if (opts.url) {
    console.log(pc.cyan(`Connecting to ${opts.url} (Standalone)...`));
    try {
      const headers = parseHeaders(opts.header);
      const { client, transport } = await connectStandalone(opts.url, headers);
      console.log(pc.green("✓ Successfully connected"));
      const tools = await client.listTools().catch(() => ({ tools: [] }));
      console.log(`Found ${tools.tools?.length || 0} tools.`);
      await transport.close();
    } catch (err: any) {
      console.error(pc.red(`✗ Failed to connect: ${err.message}`));
    }
  } else {
    program.help();
  }
});

program.parse(process.argv);
