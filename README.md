# mcp-jnm

Interactive Web Dashboard, Inspector & CLI for Model Context Protocol (MCP) servers with full **OAuth 2.0 (PKCE & Authorization Code Flow)** support.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)
![React](https://img.shields.io/badge/React-19-cyan)
![TailwindCSS](https://img.shields.io/badge/TailwindCSS-4.0-38bdf8)

---

## Features

- **OAuth 2.0 & PKCE Flow**: Integrated PKCE authorization with support for Cloudflare Sandbox, Google OAuth, GitHub Copilot MCP, and Custom OIDC Providers.
- **Web Dashboard**: Interactive interface to inspect tools, prompts, resources, execute tool calls, and view live JSON-RPC request/response payloads.
- **Direct CLI Client**: Run tool queries, listings, and executions directly from your terminal.
- **SSE & Streamable HTTP Transports**: Supports modern MCP streaming protocols.
- **Custom Security Headers**: Basic Auth protection for dashboard with Bearer token injection.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/code4indo/mcp-jnm.git
cd mcp-jnm

# Install dependencies
npm install

# Build the client & server
npm run build
```

---

## Quick Start

### 1. Launch Web Dashboard
```bash
# Set credentials (optional)
export DASHBOARD_USERNAME="admin"
export DASHBOARD_PASSWORD="secretpassword"

# Start the dev server
npm run dev
```
Open `http://localhost:3000` in your browser.

### 2. Run with CLI
```bash
# Connect to an MCP server directly
npm run cli -- -u "https://api.githubcopilot.com/mcp/" -H "Authorization: Bearer <TOKEN>" tools

# Call a tool
npm run cli -- -u "https://api.githubcopilot.com/mcp/" -H "Authorization: Bearer <TOKEN>" call get_me '{}'
```

---

## Environment Variables

Copy `.env.example` to `.env`:

```env
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=password
GEMINI_API_KEY=
```

---

## License

MIT © [Jatniko NM](https://github.com/code4indo)
