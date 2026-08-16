import { Command } from "commander";
import pc from "picocolors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startRepl, connectPersistent } from "./src/cliRepl.js";
import { loadCliConfig, saveCliConfig, saveSessionCache } from "./src/cliConfig.js";

const program = new Command();
const API_BASE = "http://localhost:3000/api/mcp";

// Get credentials from environment
const getAuthHeaders = () => {
  const user = process.env.DASHBOARD_USERNAME;
  const pass = process.env.DASHBOARD_PASSWORD;
  if (user && pass) {
    const b64 = Buffer.from(`${user}:${pass}`).toString("base64");
    return {
      "Content-Type": "application/json",
      Authorization: `Basic ${b64}`,
    };
  }
  return { "Content-Type": "application/json" };
};

program
  .name("mcp")
  .description("CLI to manage MCP Dashboard connection or connect directly in Interactive REPL mode")
  .version("1.0.5")
  .option("-u, --url <url>", "Connect to an MCP server URL directly")
  .option("-H, --header <header...>", "Custom headers (e.g., -H 'Authorization: Bearer token')")
  .option("-i, --interactive", "Launch interactive persistent REPL shell immediately");

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
    console.log(pc.cyan("Tip: You can run standalone REPL mode with: mcp shell (or mcp repl)"));
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
  return await connectPersistent(url, customHeaders);
}

// 1. REPL / Shell Command
program
  .command("shell [url]")
  .alias("repl")
  .description("Launch Interactive Persistent REPL Shell with Keep-Alive & Auto-complete")
  .action(async (url) => {
    const opts = program.opts();
    const headers = parseHeaders(opts.header);
    await startRepl(url || opts.url, headers);
  });

// 2. Profile Management Commands
const profileCmd = program.command("profile").description("Manage cached MCP server profiles");

profileCmd
  .command("list")
  .description("List all saved server profiles")
  .action(() => {
    const cfg = loadCliConfig();
    console.log(pc.bold("\nSaved Profiles (~/.mcp-jnm/config.json):"));
    const keys = Object.keys(cfg.profiles);
    if (keys.length === 0) {
      console.log(pc.yellow("  No profiles saved yet."));
      return;
    }
    keys.forEach((k) => {
      const p = cfg.profiles[k];
      console.log(`  • ${pc.cyan(pc.bold(k))}: ${p.url}`);
      if (p.headers && Object.keys(p.headers).length > 0) {
        console.log(pc.gray(`    Headers: ${JSON.stringify(p.headers)}`));
      }
      if (p.lastConnected) {
        console.log(pc.gray(`    Last connected: ${p.lastConnected}`));
      }
    });
    console.log("");
  });

profileCmd
  .command("add <name> <url>")
  .description("Add or update a server profile")
  .action((name, url) => {
    const opts = program.opts();
    const headers = parseHeaders(opts.header);
    const cfg = loadCliConfig();
    cfg.profiles[name] = { name, url, headers };
    saveCliConfig(cfg);
    console.log(pc.green(`✓ Profile '${name}' saved successfully.`));
  });

profileCmd
  .command("remove <name>")
  .description("Delete a saved profile")
  .action((name) => {
    const cfg = loadCliConfig();
    if (cfg.profiles[name]) {
      delete cfg.profiles[name];
      saveCliConfig(cfg);
      console.log(pc.green(`✓ Profile '${name}' removed.`));
    } else {
      console.log(pc.yellow(`Profile '${name}' not found.`));
    }
  });

// 3. Status Command
program
  .command("status")
  .description("Get current MCP connection status")
  .action(async () => {
    const opts = program.opts();
    if (opts.url) {
      console.log(pc.cyan(`Testing standalone connection to ${opts.url}...`));
      try {
        const headers = parseHeaders(opts.header);
        const { client, transport, tools } = await connectStandalone(opts.url, headers);
        console.log(pc.green("✓ Connected successfully"));
        console.log(`Available Tools: ${tools.length}`);
        await transport.close();
      } catch (err: any) {
        console.log(pc.red(`✗ Disconnected: ${err.message}`));
      }
      return;
    }
    const data = await fetchApi("/status");
    if (data.connected) {
      console.log(pc.green("✓ Connected"));
      console.log(`Server URL: ${pc.cyan(data.serverUrl)}`);
      if (data.serverVersion) {
        console.log(`Version: ${data.serverVersion.name} v${data.serverVersion.version}`);
      }
      console.log(
        pc.gray(
          `Available: ${data.tools?.length || 0} tools, ${data.resources?.length || 0} resources, ${
            data.prompts?.length || 0
          } prompts`
        )
      );
    } else {
      console.log(pc.red("✗ Disconnected"));
      if (data.error) {
        console.log(`Last Error: ${pc.red(data.error)}`);
      }
    }
  });

// 4. Connect Command
program
  .command("connect <url>")
  .description("Connect dashboard to an MCP server")
  .action(async (url) => {
    const opts = program.opts();
    if (opts.interactive) {
      const headers = parseHeaders(opts.header);
      await startRepl(url, headers);
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
      saveSessionCache(url, headers);
    } else {
      console.log(pc.red(`✗ Failed to connect: ${data.error}`));
    }
  });

// 5. Disconnect Command
program
  .command("disconnect")
  .description("Disconnect dashboard from current MCP server")
  .action(async () => {
    const data = await fetchApi("/disconnect", { method: "POST" });
    if (data.success) {
      console.log(pc.green("✓ Disconnected dashboard"));
    }
  });

// 6. Tools Command
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
        const { transport, tools: loadedTools } = await connectStandalone(opts.url, headers);
        tools = loadedTools;
        await transport.close();
      } catch (err: any) {
        console.error(pc.red(`✗ Failed to connect: ${err.message}`));
        process.exit(1);
      }
    } else {
      const data = await fetchApi("/status");
      if (!data.connected) {
        console.log(pc.red("Dashboard not connected to any MCP server."));
        console.log(pc.gray("Tip: Use 'mcp shell' to open an interactive standalone session."));
        return;
      }
      tools = data.tools || [];
    }

    if (tools.length === 0) {
      console.log(pc.yellow("No tools available."));
      return;
    }
    console.log(pc.bold(`\nAvailable Tools (${tools.length}):`));
    tools.forEach((t: any) => {
      console.log(`\n- ${pc.green(t.name)}: ${t.description || "No description"}`);
      if (t.inputSchema) {
        console.log(pc.gray(`  Schema: ${JSON.stringify(t.inputSchema)}`));
      }
    });
  });

// 7. Call Command
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
        body: JSON.stringify({
          serverUrl: statusData.serverUrl || statusData.connections?.[0]?.serverUrl,
          name,
          arguments: argsObj,
        }),
      });

      if (data.success) {
        console.log(pc.green("✓ Success\n"));
        console.log(JSON.stringify(data.result, null, 2));
      } else {
        console.log(pc.red(`✗ Error: ${data.error}`));
      }
    }
  });

// Default action: if --interactive is passed or no args, show help or open repl
program.action(async () => {
  const opts = program.opts();
  if (opts.interactive) {
    const headers = parseHeaders(opts.header);
    await startRepl(opts.url, headers);
  } else if (opts.url) {
    console.log(pc.cyan(`Connecting to ${opts.url}...`));
    try {
      const headers = parseHeaders(opts.header);
      const { transport, tools } = await connectStandalone(opts.url, headers);
      console.log(pc.green("✓ Successfully connected"));
      console.log(`Found ${tools.length} tools.`);
      await transport.close();
    } catch (err: any) {
      console.error(pc.red(`✗ Failed to connect: ${err.message}`));
    }
  } else {
    program.help();
  }
});

program.parse(process.argv);
