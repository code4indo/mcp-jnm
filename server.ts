import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface ConnectionState {
  client: Client;
  transport: any;
  serverUrl: string;
}

interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  expiresAt?: number;
  scope?: string;
  idToken?: string;
  provider?: string;
  clientId?: string;
}

interface PendingOAuthState {
  state: string;
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  codeVerifier?: string;
  redirectUri: string;
  provider: string;
  scope?: string;
  createdAt: number;
}

// In-memory OAuth state and active session store
const pendingOAuthStates = new Map<string, PendingOAuthState>();
let activeOAuthTokens: OAuthTokens | null = null;

// Helpers for PKCE (Proof Key for Code Exchange)
function base64URLEncode(str: Buffer): string {
  return str
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateCodeVerifier(): string {
  return base64URLEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  return base64URLEncode(hash);
}

// Clean up pending states older than 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingOAuthStates.entries()) {
    if (now - val.createdAt > 15 * 60 * 1000) {
      pendingOAuthStates.delete(key);
    }
  }
}, 60 * 1000);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  // Basic Auth Middleware
  app.use((req, res, next) => {
    // Exclude public OAuth callback routes from basic auth so provider redirects work cleanly
    if (req.path === "/auth/callback" || req.path === "/auth/callback/") {
      return next();
    }

    const expectedUser = process.env.DASHBOARD_USERNAME;
    const expectedPass = process.env.DASHBOARD_PASSWORD;

    if (!expectedUser && !expectedPass) {
      return next(); // Skip auth if not configured
    }

    const b64auth = (req.headers.authorization || "").split(" ")[1] || "";
    const [login, password] = Buffer.from(b64auth, "base64").toString().split(":");

    if (login && password && login === expectedUser && password === expectedPass) {
      return next();
    }

    res.set("WWW-Authenticate", 'Basic realm="401"');
    res.status(401).send("Authentication required.");
  });

  const PORT = 3000;
  const connections = new Map<string, ConnectionState>();
  const SESSIONS_FILE = path.join(process.cwd(), ".mcp_sessions.json");

  function saveSessionsToDisk() {
    try {
      const activeUrls = Array.from(connections.keys()).map((url) => {
        return { url };
      });
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ urls: activeUrls }, null, 2), "utf8");
    } catch (_) {}
  }

  async function restoreSessionsFromDisk() {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const raw = fs.readFileSync(SESSIONS_FILE, "utf8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.urls)) {
          for (const item of data.urls) {
            const u = typeof item === "string" ? item : item.url;
            if (u && !connections.has(u)) {
              console.log(`[Auto-Restore] Re-establishing MCP connection to ${u}...`);
              // Internal connection attempt
              try {
                const urlObj = new URL(u);
                const client = new Client({ name: "mcp-web-client", version: "1.0.5" }, { capabilities: {} } as any);
                let transport: any;
                const reqHeaders: Record<string, string> = { "Accept": "application/json, text/event-stream" };
                if (activeOAuthTokens?.accessToken && (u.includes("github") || u.includes("cloudflare"))) {
                  reqHeaders["Authorization"] = `Bearer ${activeOAuthTokens.accessToken}`;
                }
                if (urlObj.pathname.endsWith("/sse")) {
                  transport = new SSEClientTransport(urlObj, { requestInit: { headers: reqHeaders }, eventSourceInit: { headers: reqHeaders } as any });
                } else {
                  transport = new StreamableHTTPClientTransport(urlObj, { requestInit: { headers: reqHeaders } });
                }
                await client.connect(transport);
                connections.set(u, { client, transport, serverUrl: u });
                console.log(`[Auto-Restore] Successfully restored ${u}`);
              } catch (e: any) {
                console.warn(`[Auto-Restore] Could not auto-restore ${u}:`, e.message);
              }
            }
          }
        }
      }
    } catch (_) {}
  }

  // Restore previous sessions in background
  restoreSessionsFromDisk();

  // ==========================================
  // OAuth 2.0 API Endpoints
  // ==========================================

  // Endpoint: Generate OAuth Authorization URL with PKCE
  app.post("/api/oauth/authorize-url", (req, res) => {
    try {
      const {
        provider = "custom",
        clientId,
        clientSecret,
        authUrl,
        tokenUrl,
        scope = "openid profile",
        usePKCE = true,
        redirectUri,
      } = req.body;

      if (!clientId || !authUrl || !tokenUrl) {
        return res.status(400).json({ error: "clientId, authUrl, and tokenUrl are required." });
      }

      const state = crypto.randomBytes(16).toString("hex");
      let codeVerifier: string | undefined;
      let codeChallenge: string | undefined;

      if (usePKCE) {
        codeVerifier = generateCodeVerifier();
        codeChallenge = generateCodeChallenge(codeVerifier);
      }

      // Determine redirect URI
      const finalRedirectUri =
        redirectUri ||
        (process.env.APP_URL ? `${process.env.APP_URL}/auth/callback` : `${req.protocol}://${req.get("host")}/auth/callback`);

      // Store pending OAuth state for validation upon callback
      pendingOAuthStates.set(state, {
        state,
        clientId,
        clientSecret,
        tokenUrl,
        codeVerifier,
        redirectUri: finalRedirectUri,
        provider,
        scope,
        createdAt: Date.now(),
      });

      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: finalRedirectUri,
        scope,
        state,
      });

      if (codeChallenge) {
        params.append("code_challenge", codeChallenge);
        params.append("code_challenge_method", "S256");
      }

      // Add access_type=offline & prompt=consent for Google to get refresh tokens
      if (authUrl.includes("google.com")) {
        params.append("access_type", "offline");
        params.append("prompt", "consent");
      }

      const fullAuthUrl = `${authUrl}${authUrl.includes("?") ? "&" : "?"}${params.toString()}`;

      res.json({
        url: fullAuthUrl,
        state,
        redirectUri: finalRedirectUri,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to generate authorization URL" });
    }
  });

  // Endpoint: OAuth Callback (Handles code exchange and sends postMessage to popup opener)
  const oauthCallbackHandler = async (req: express.Request, res: express.Response) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      const errMsg = (error_description || error || "OAuth authorization failed").toString();
      return res.send(`
        <!DOCTYPE html>
        <html>
          <head><title>OAuth Authentication Failed</title></head>
          <body style="font-family: system-ui, sans-serif; background: #0f172a; color: #f87171; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
            <div style="text-align: center; padding: 24px; border: 1px solid #7f1d1d; border-radius: 16px; background: #1e1b4b; max-width: 450px;">
              <h2 style="margin: 0 0 10px 0; color: #f87171;">Authentication Failed</h2>
              <p style="font-size: 13px; color: #cbd5e1; margin-bottom: 20px;">${errMsg}</p>
              <button onclick="window.close()" style="background: #334155; color: #fff; border: 0; padding: 8px 16px; border-radius: 8px; cursor: pointer;">Close Window</button>
            </div>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: ${JSON.stringify(errMsg)} }, '*');
              }
            </script>
          </body>
        </html>
      `);
    }

    if (!code || !state) {
      return res.status(400).send("Missing code or state parameter.");
    }

    const stateStr = String(state);
    const pending = pendingOAuthStates.get(stateStr);

    if (!pending) {
      return res.status(400).send("Invalid or expired OAuth state parameter. Please try logging in again.");
    }

    pendingOAuthStates.delete(stateStr);

    try {
      // Exchange authorization code for tokens
      const tokenBodyParams: Record<string, string> = {
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
      };

      if (pending.clientSecret) {
        tokenBodyParams.client_secret = pending.clientSecret;
      }

      if (pending.codeVerifier) {
        tokenBodyParams.code_verifier = pending.codeVerifier;
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      };

      // If client secret is used with Basic auth for providers that require it
      if (pending.clientSecret && pending.tokenUrl.includes("github.com")) {
        headers["Accept"] = "application/json";
      }

      const tokenResponse = await fetch(pending.tokenUrl, {
        method: "POST",
        headers,
        body: new URLSearchParams(tokenBodyParams).toString(),
      });

      const responseText = await tokenResponse.text();
      let tokenData: any;

      try {
        tokenData = JSON.parse(responseText);
      } catch (_) {
        // Fallback parse URL-encoded response if not JSON
        const parsedUrlParams = new URLSearchParams(responseText);
        tokenData = Object.fromEntries(parsedUrlParams.entries());
      }

      if (tokenData.error || (!tokenData.access_token && !tokenData.accessToken)) {
        throw new Error(tokenData.error_description || tokenData.error || "Token exchange failed");
      }

      const accessToken = tokenData.access_token || tokenData.accessToken;
      const refreshToken = tokenData.refresh_token || tokenData.refreshToken;
      const expiresIn = Number(tokenData.expires_in || tokenData.expiresIn) || 3600;
      const tokenType = tokenData.token_type || tokenData.tokenType || "Bearer";
      const scope = tokenData.scope || pending.scope || "";

      activeOAuthTokens = {
        accessToken,
        refreshToken,
        tokenType,
        expiresIn,
        expiresAt: Date.now() + expiresIn * 1000,
        scope,
        idToken: tokenData.id_token,
        provider: pending.provider,
        clientId: pending.clientId,
      };

      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>OAuth Authentication Successful</title>
          </head>
          <body style="font-family: system-ui, -apple-system, sans-serif; background: #020617; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
            <div style="text-align: center; padding: 28px; border: 1px solid #1e293b; border-radius: 20px; background: #0f172a; max-width: 440px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
              <div style="width: 52px; height: 52px; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 16px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
              </div>
              <h2 style="margin: 0 0 8px 0; color: #ffffff; font-size: 20px; font-weight: 700;">OAuth 2.0 Authenticated</h2>
              <p style="font-size: 13px; color: #94a3b8; line-height: 1.5; margin: 0 0 20px 0;">Authentication complete. Returning your access token to the MCP Dashboard...</p>
              <div style="font-size: 11px; color: #64748b; font-family: monospace;">This window will close automatically.</div>
            </div>
            <script>
              try {
                if (window.opener) {
                  window.opener.postMessage({
                    type: 'OAUTH_AUTH_SUCCESS',
                    tokens: ${JSON.stringify(activeOAuthTokens)}
                  }, '*');
                  setTimeout(() => {
                    window.close();
                  }, 800);
                } else {
                  window.location.href = '/';
                }
              } catch (e) {
                window.close();
              }
            </script>
          </body>
        </html>
      `);
    } catch (err: any) {
      console.error("OAuth token exchange error:", err);
      res.status(500).send(`
        <!DOCTYPE html>
        <html>
          <body style="font-family: system-ui, sans-serif; background: #0f172a; color: #f87171; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
            <div style="text-align: center; padding: 24px; border: 1px solid #7f1d1d; border-radius: 16px; background: #1e1b4b; max-width: 450px;">
              <h3 style="margin: 0 0 10px 0; color: #f87171;">Token Exchange Error</h3>
              <p style="font-size: 13px; color: #cbd5e1; margin-bottom: 20px;">${err.message || String(err)}</p>
              <button onclick="window.close()" style="background: #334155; color: #fff; border: 0; padding: 8px 16px; border-radius: 8px; cursor: pointer;">Close Window</button>
            </div>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: ${JSON.stringify(err.message || String(err))} }, '*');
              }
            </script>
          </body>
        </html>
      `);
    }
  };

  app.get(["/auth/callback", "/auth/callback/"], oauthCallbackHandler);

  // Endpoint: Get current OAuth session status
  app.get("/api/oauth/session", (req, res) => {
    res.json({
      active: !!activeOAuthTokens,
      tokens: activeOAuthTokens
        ? {
            ...activeOAuthTokens,
            accessToken: activeOAuthTokens.accessToken
              ? `${activeOAuthTokens.accessToken.substring(0, 8)}...${activeOAuthTokens.accessToken.slice(-6)}`
              : "",
          }
        : null,
      rawTokens: activeOAuthTokens,
    });
  });

  // Endpoint: Refresh Token
  app.post("/api/oauth/refresh", async (req, res) => {
    if (!activeOAuthTokens || !activeOAuthTokens.refreshToken) {
      return res.status(400).json({ success: false, error: "No active OAuth refresh token available." });
    }

    try {
      // Find token URL from provider
      let tokenUrl = "https://dash.cloudflare.com/oauth2/token";
      if (activeOAuthTokens.provider === "google") {
        tokenUrl = "https://oauth2.googleapis.com/token";
      } else if (activeOAuthTokens.provider === "github") {
        tokenUrl = "https://github.com/login/oauth/access_token";
      }

      const params = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: activeOAuthTokens.refreshToken,
        client_id: activeOAuthTokens.clientId || "",
      });

      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
        body: params.toString(),
      });

      const tokenData = await response.json();
      if (tokenData.error) {
        throw new Error(tokenData.error_description || tokenData.error);
      }

      const accessToken = tokenData.access_token || tokenData.accessToken;
      const expiresIn = Number(tokenData.expires_in || tokenData.expiresIn) || 3600;

      activeOAuthTokens = {
        ...activeOAuthTokens,
        accessToken,
        refreshToken: tokenData.refresh_token || activeOAuthTokens.refreshToken,
        expiresIn,
        expiresAt: Date.now() + expiresIn * 1000,
      };

      res.json({ success: true, tokens: activeOAuthTokens });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || "Failed to refresh token" });
    }
  });

  // Endpoint: Logout / Revoke OAuth Session
  app.post("/api/oauth/logout", (req, res) => {
    activeOAuthTokens = null;
    res.json({ success: true });
  });

  // Endpoint: Check MCP status
  app.get("/api/mcp/status", async (req, res) => {
    try {
      const activeConnections = [];
      for (const [url, state] of connections.entries()) {
        const tools = await state.client.listTools().catch(() => ({ tools: [] }));
        const resources = await state.client.listResources().catch(() => ({ resources: [] }));
        const prompts = await state.client.listPrompts().catch(() => ({ prompts: [] }));

        activeConnections.push({
          serverUrl: url,
          connected: true,
          serverVersion: state.client.getServerVersion?.(),
          tools: tools.tools || [],
          resources: resources.resources || [],
          prompts: prompts.prompts || [],
        });
      }

      res.json({
        connections: activeConnections,
        oauthActive: !!activeOAuthTokens,
      });
    } catch (err: any) {
      res.json({
        connections: [],
        error: err.message || "Failed to query server status",
      });
    }
  });

  // Endpoint: Connect to MCP endpoint
  app.post("/api/mcp/connect", async (req, res) => {
    const targetUrl = req.body.url || "https://mcp-ssh.jatnikonm.tech/mcp";
    const customHeaders = req.body.headers || {};

    // Auto-inject OAuth Bearer token if no Authorization header provided
    if (!customHeaders["Authorization"] && !customHeaders["authorization"] && activeOAuthTokens?.accessToken) {
      customHeaders["Authorization"] = `Bearer ${activeOAuthTokens.accessToken}`;
    }

    const mergedHeaders = { "Accept": "application/json, text/event-stream", ...customHeaders };

    try {
      if (connections.has(targetUrl)) {
        const state = connections.get(targetUrl)!;
        const toolsRes = await state.client.listTools().catch(() => ({ tools: [] }));
        const resourcesRes = await state.client.listResources().catch(() => ({ resources: [] }));
        const promptsRes = await state.client.listPrompts().catch(() => ({ prompts: [] }));
        return res.json({
          success: true,
          connected: true,
          serverUrl: targetUrl,
          serverVersion: state.client.getServerVersion?.(),
          tools: toolsRes.tools || [],
          resources: resourcesRes.resources || [],
          prompts: promptsRes.prompts || [],
        });
      }

      const urlObj = new URL(targetUrl);
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

      for (const attempt of attempts) {
        const client = new Client(
          {
            name: "mcp-web-client",
            version: "1.0.5",
          },
          {
            capabilities: {},
          } as any
        );

        let transport: any;
        if (attempt.type === "streamable") {
          transport = new StreamableHTTPClientTransport(attempt.url, {
            requestInit: {
              headers: mergedHeaders,
            },
          });
        } else {
          transport = new SSEClientTransport(attempt.url, {
            requestInit: {
              headers: mergedHeaders,
            },
            eventSourceInit: {
              headers: mergedHeaders,
            } as any,
          });
        }

        try {
          const connectPromise = client.connect(transport);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout connecting via ${attempt.type}`)), 8000)
          );
          await Promise.race([connectPromise, timeoutPromise]);
          connectedClient = client;
          connectedTransport = transport;
          break;
        } catch (err: any) {
          console.warn(`Attempt failed (${attempt.type} on ${attempt.url.href}):`, err.message);
          lastErr = err;
          try {
            await transport.close();
          } catch (_) {}
        }
      }

      if (!connectedClient || !connectedTransport) {
        throw lastErr || new Error("All connection attempts failed");
      }

      connections.set(targetUrl, {
        client: connectedClient,
        transport: connectedTransport,
        serverUrl: targetUrl,
      });
      saveSessionsToDisk();

      const toolsRes = await connectedClient.listTools().catch(() => ({ tools: [] }));
      const resourcesRes = await connectedClient.listResources().catch(() => ({ resources: [] }));
      const promptsRes = await connectedClient.listPrompts().catch(() => ({ prompts: [] }));

      return res.json({
        success: true,
        connected: true,
        serverUrl: targetUrl,
        serverVersion: connectedClient.getServerVersion?.(),
        tools: toolsRes.tools || [],
        resources: resourcesRes.resources || [],
        prompts: promptsRes.prompts || [],
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        connected: false,
        error: err.message || String(err),
      });
    }
  });

  // Endpoint: Disconnect
  app.post("/api/mcp/disconnect", async (req, res) => {
    const { url } = req.body;
    if (url && connections.has(url)) {
      const state = connections.get(url)!;
      try {
        await state.transport.close();
      } catch (_) {}
      connections.delete(url);
      saveSessionsToDisk();
    }
    res.json({ success: true, connected: false });
  });

  // Endpoint: Call Tool
  app.post("/api/mcp/call-tool", async (req, res) => {
    const { serverUrl, name, arguments: args } = req.body;
    if (!serverUrl || !connections.has(serverUrl)) {
      return res.status(400).json({ error: "No active MCP connection for the given server URL" });
    }

    if (!name) {
      return res.status(400).json({ error: "Tool name is required" });
    }

    const state = connections.get(serverUrl)!;

    try {
      const result = await state.client.callTool({
        name,
        arguments: args || {},
      });
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Endpoint: Read Resource
  app.post("/api/mcp/read-resource", async (req, res) => {
    const { serverUrl, uri } = req.body;
    if (!serverUrl || !connections.has(serverUrl)) {
      return res.status(400).json({ error: "No active MCP connection for the given server URL" });
    }

    if (!uri) {
      return res.status(400).json({ error: "Resource URI is required" });
    }

    const state = connections.get(serverUrl)!;

    try {
      const result = await state.client.readResource({ uri });
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Endpoint: Get Prompt
  app.post("/api/mcp/get-prompt", async (req, res) => {
    const { serverUrl, name, arguments: args } = req.body;
    if (!serverUrl || !connections.has(serverUrl)) {
      return res.status(400).json({ error: "No active MCP connection for the given server URL" });
    }

    if (!name) {
      return res.status(400).json({ error: "Prompt name is required" });
    }

    const state = connections.get(serverUrl)!;

    try {
      const result = await state.client.getPrompt({
        name,
        arguments: args || {},
      });
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Endpoint: Sync current codebase directly to GitHub repo via MCP
  app.post("/api/github/sync-project", async (req, res) => {
    const { serverUrl = "https://api.githubcopilot.com/mcp/", owner = "code4indo", repo = "mcp-jnm", branch = "main", message = "feat: Sync codebase from MCP Inspector" } = req.body;
    if (!connections.has(serverUrl)) {
      return res.status(400).json({ error: "No active MCP connection for GitHub server" });
    }

    const state = connections.get(serverUrl)!;
    const projectFiles: { path: string; content: string }[] = [];

    const includeFiles = [
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "index.html",
      "metadata.json",
      ".env.example",
      ".gitignore",
      "README.md",
      "server.ts",
      "cli.ts",
      "src/main.tsx",
      "src/App.tsx",
      "src/types.ts",
      "src/index.css",
      "src/components/OAuthModal.tsx",
      "bin/mcp-dashboard.js",
    ];

    for (const relPath of includeFiles) {
      const fullPath = path.join(process.cwd(), relPath);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          projectFiles.push({ path: relPath, content });
        } catch (e) {
          console.warn("Failed to read file:", relPath, e);
        }
      }
    }

    try {
      // Call MCP push_files tool
      const result = await state.client.callTool({
        name: "push_files",
        arguments: {
          owner,
          repo,
          branch,
          message,
          files: projectFiles,
        },
      });
      res.json({ success: true, filesCount: projectFiles.length, result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || String(err) });
    }
  });

  // Vite middleware for dev or static serving for prod
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

