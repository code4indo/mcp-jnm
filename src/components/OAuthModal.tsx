import React, { useState, useEffect } from "react";
import {
  ShieldCheck,
  Key,
  Globe,
  ExternalLink,
  Copy,
  Check,
  X,
  RefreshCw,
  Lock,
  Zap,
  Info,
  CheckCircle2,
  AlertCircle,
  LogOut,
  Sliders,
  ChevronDown
} from "lucide-react";
import { OAuthTokens, OAuthProviderConfig } from "../types";

const PRESET_PROVIDERS: OAuthProviderConfig[] = [
  {
    id: "cloudflare",
    name: "Cloudflare OAuth 2.0",
    authUrl: "https://dash.cloudflare.com/oauth2/auth",
    tokenUrl: "https://dash.cloudflare.com/oauth2/token",
    defaultScope: "mcp:containers:read mcp:containers:write",
    usePKCE: true,
    requiresClientSecret: false,
    description: "Cloudflare Sandbox Container & Workers MCP endpoints authentication."
  },
  {
    id: "google",
    name: "Google OAuth 2.0",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    defaultScope: "openid email profile",
    usePKCE: true,
    requiresClientSecret: true,
    description: "Google Cloud Platform, Vertex AI, & Workspace MCP endpoints."
  },
  {
    id: "github",
    name: "GitHub OAuth 2.0",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    defaultScope: "read:user repo",
    usePKCE: false,
    requiresClientSecret: true,
    description: "GitHub API & repository tools authentication."
  },
  {
    id: "custom",
    name: "Custom OAuth 2.0 / OIDC",
    authUrl: "",
    tokenUrl: "",
    defaultScope: "openid profile mcp",
    usePKCE: true,
    requiresClientSecret: true,
    description: "Connect to any Keycloak, Auth0, Okta, or custom OAuth 2.0 provider."
  }
];

interface OAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  oauthSession?: OAuthTokens | null;
  onSessionUpdated?: (tokens: OAuthTokens | null) => void;
  onApplyTokenToConnection?: (token: string) => void;
  onSuccess?: (tokens: OAuthTokens) => void;
}

export function OAuthModal({
  isOpen,
  onClose,
  oauthSession = null,
  onSessionUpdated,
  onApplyTokenToConnection,
  onSuccess,
}: OAuthModalProps) {
  const [selectedProviderId, setSelectedProviderId] = useState<string>("cloudflare");
  const [clientId, setClientId] = useState<string>("");
  const [clientSecret, setClientSecret] = useState<string>("");
  const [authUrl, setAuthUrl] = useState<string>("https://dash.cloudflare.com/oauth2/auth");
  const [tokenUrl, setTokenUrl] = useState<string>("https://dash.cloudflare.com/oauth2/token");
  const [scope, setScope] = useState<string>("mcp:containers:read mcp:containers:write");
  const [usePKCE, setUsePKCE] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedCallback, setCopiedCallback] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Dynamic redirect URI for user convenience
  const redirectUri = typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : "/auth/callback";

  useEffect(() => {
    const selected = PRESET_PROVIDERS.find((p) => p.id === selectedProviderId);
    if (selected && selectedProviderId !== "custom") {
      setAuthUrl(selected.authUrl);
      setTokenUrl(selected.tokenUrl);
      setScope(selected.defaultScope);
      setUsePKCE(selected.usePKCE);
    }
  }, [selectedProviderId]);

  if (!isOpen) return null;

  const handleCopyCallback = () => {
    navigator.clipboard.writeText(redirectUri);
    setCopiedCallback(true);
    setTimeout(() => setCopiedCallback(false), 2000);
  };

  const handleCopyToken = () => {
    if (oauthSession?.accessToken) {
      navigator.clipboard.writeText(oauthSession.accessToken);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    }
  };

  const handleStartOAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientId.trim()) {
      setError("Client ID is required.");
      return;
    }
    if (!authUrl.trim() || !tokenUrl.trim()) {
      setError("Authorization URL and Token URL are required.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 1. Get OAuth authorization URL from server
      const res = await fetch("/api/oauth/authorize-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProviderId,
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim() || undefined,
          authUrl: authUrl.trim(),
          tokenUrl: tokenUrl.trim(),
          scope: scope.trim(),
          usePKCE,
          redirectUri,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Failed to generate OAuth Authorization URL");
      }

      // 2. Open provider OAuth URL in popup (AI Studio requirement)
      const authWindow = window.open(
        data.url,
        "oauth_popup",
        "width=600,height=750,menubar=no,toolbar=no,location=no,status=no"
      );

      if (!authWindow) {
        throw new Error("Popup was blocked by your browser. Please allow popups for this site to complete OAuth 2.0 login.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to start OAuth flow");
    } finally {
      setLoading(false);
    }
  };

  const handleRefreshToken = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/refresh", { method: "POST" });
      const data = await res.json();
      if (data.success && data.tokens) {
        if (onSessionUpdated) onSessionUpdated(data.tokens);
        if (onApplyTokenToConnection) onApplyTokenToConnection(data.tokens.accessToken);
        if (onSuccess) onSuccess(data.tokens);
      } else {
        setError(data.error || "Failed to refresh token");
      }
    } catch (err: any) {
      setError(err.message || "Error refreshing token");
    } finally {
      setRefreshing(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/oauth/logout", { method: "POST" });
      if (onSessionUpdated) onSessionUpdated(null);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl flex flex-col relative">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-900/95 backdrop-blur z-10">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
                OAuth 2.0 Authentication
                <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  PKCE & Code Flow
                </span>
              </h2>
              <p className="text-xs text-slate-400">Connect securely to MCP servers using OAuth 2.0 authorization</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6 flex-1">
          {/* Active OAuth Session Card if logged in */}
          {oauthSession?.accessToken && (
            <div className="bg-emerald-950/30 border border-emerald-500/40 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span className="text-sm font-semibold text-emerald-300">
                    OAuth 2.0 Session Active ({oauthSession.provider || "Connected Provider"})
                  </span>
                </div>
                <div className="flex items-center space-x-2">
                  {oauthSession.refreshToken && (
                    <button
                      onClick={handleRefreshToken}
                      disabled={refreshing}
                      className="px-2.5 py-1 text-xs bg-emerald-900/40 hover:bg-emerald-800/50 text-emerald-200 border border-emerald-500/30 rounded-lg flex items-center space-x-1 cursor-pointer transition-colors"
                    >
                      <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
                      <span>Refresh Token</span>
                    </button>
                  )}
                  <button
                    onClick={handleLogout}
                    className="px-2.5 py-1 text-xs bg-rose-950/40 hover:bg-rose-900/50 text-rose-300 border border-rose-800/40 rounded-lg flex items-center space-x-1 cursor-pointer transition-colors"
                  >
                    <LogOut className="w-3 h-3" />
                    <span>Revoke / Logout</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono">
                <div className="bg-slate-950/80 p-2.5 rounded border border-slate-800/60">
                  <span className="text-[10px] text-slate-400 block font-sans">Token Type & Expiration:</span>
                  <span className="text-emerald-400">
                    {oauthSession.tokenType || "Bearer"}
                    {oauthSession.expiresAt
                      ? ` (Expires: ${new Date(oauthSession.expiresAt).toLocaleTimeString()})`
                      : " (No expiry provided)"}
                  </span>
                </div>
                <div className="bg-slate-950/80 p-2.5 rounded border border-slate-800/60">
                  <span className="text-[10px] text-slate-400 block font-sans">Granted Scope:</span>
                  <span className="text-slate-300 truncate block">{oauthSession.scope || "default"}</span>
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={handleCopyToken}
                  className="text-xs text-slate-400 hover:text-white flex items-center space-x-1.5 cursor-pointer font-mono"
                >
                  {copiedToken ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Access Token Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Raw Access Token</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    onApplyTokenToConnection(oauthSession.accessToken);
                    onClose();
                  }}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors flex items-center space-x-1.5 cursor-pointer"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>Use Token in Connection</span>
                </button>
              </div>
            </div>
          )}

          {/* Setup / Authorize Form */}
          <form onSubmit={handleStartOAuth} className="space-y-4">
            {/* Provider selector tabs */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Choose OAuth Provider Preset</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {PRESET_PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setSelectedProviderId(p.id);
                      setError(null);
                    }}
                    className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                      selectedProviderId === p.id
                        ? "bg-indigo-950/60 border-indigo-500 text-white shadow-sm"
                        : "bg-slate-950/40 border-slate-800 text-slate-400 hover:bg-slate-800/40 hover:text-slate-200"
                    }`}
                  >
                    <span className="text-xs font-semibold block">{p.name}</span>
                    <span className="text-[10px] text-slate-500 mt-1 line-clamp-1">{p.id}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Provider Description */}
            <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 text-xs text-slate-400 flex items-start space-x-2">
              <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
              <span>
                {PRESET_PROVIDERS.find((p) => p.id === selectedProviderId)?.description ||
                  "Configure OAuth 2.0 authorization parameters."}
              </span>
            </div>

            {/* OAuth Callback Redirect URI banner */}
            <div className="p-3.5 bg-indigo-950/30 border border-indigo-500/30 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-indigo-300 flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5" />
                  Your OAuth Callback URL (Redirect URI)
                </span>
                <button
                  type="button"
                  onClick={handleCopyCallback}
                  className="text-xs text-indigo-300 hover:text-white flex items-center space-x-1 cursor-pointer"
                >
                  {copiedCallback ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy URL</span>
                    </>
                  )}
                </button>
              </div>
              <div className="p-2 bg-slate-950 rounded border border-slate-800/80 font-mono text-xs text-emerald-400 select-all break-all">
                {redirectUri}
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Add this exact Redirect URI to your OAuth App configuration on your provider's Developer Console (e.g. Cloudflare Dashboard, Google Cloud Console, or GitHub Settings).
              </p>
            </div>

            {/* Credentials input */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300 flex items-center gap-1">
                  <span>Client ID</span>
                  <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="e.g. 748392019-mcp-client.apps.googleusercontent.com"
                  className="w-full bg-slate-950 text-slate-100 text-xs rounded-lg px-3 py-2.5 border border-slate-800 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300 flex items-center justify-between">
                  <span>Client Secret</span>
                  <span className="text-[10px] text-slate-500 font-normal">Optional if PKCE only</span>
                </label>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="Enter client secret (if applicable)"
                  className="w-full bg-slate-950 text-slate-100 text-xs rounded-lg px-3 py-2.5 border border-slate-800 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>
            </div>

            {/* Endpoints and Scope */}
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">Authorize Endpoint URL</label>
                  <input
                    type="text"
                    required
                    value={authUrl}
                    onChange={(e) => setAuthUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full bg-slate-950 text-slate-100 text-xs rounded-lg px-3 py-2.5 border border-slate-800 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">Token Endpoint URL</label>
                  <input
                    type="text"
                    required
                    value={tokenUrl}
                    onChange={(e) => setTokenUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full bg-slate-950 text-slate-100 text-xs rounded-lg px-3 py-2.5 border border-slate-800 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Scopes (space or comma separated)</label>
                <input
                  type="text"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  placeholder="openid profile mcp"
                  className="w-full bg-slate-950 text-slate-100 text-xs rounded-lg px-3 py-2.5 border border-slate-800 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div className="flex items-center space-x-2 pt-1">
                <input
                  type="checkbox"
                  id="usePKCE"
                  checked={usePKCE}
                  onChange={(e) => setUsePKCE(e.target.checked)}
                  className="rounded bg-slate-950 border-slate-800 text-indigo-600 focus:ring-0 cursor-pointer"
                />
                <label htmlFor="usePKCE" className="text-xs text-slate-300 cursor-pointer">
                  Enable PKCE (Proof Key for Code Exchange with S256 challenge - Recommended)
                </label>
              </div>
            </div>

            {error && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-lg flex items-start space-x-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span className="text-xs text-rose-300 leading-relaxed">{error}</span>
              </div>
            )}

            <div className="pt-2 flex items-center justify-end space-x-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 rounded-xl border border-slate-800 text-slate-300 hover:bg-slate-800 text-xs font-medium transition-colors cursor-pointer"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition-all flex items-center space-x-2 shadow-lg shadow-indigo-600/20 cursor-pointer disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Opening Auth Popup...</span>
                  </>
                ) : (
                  <>
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Authorize with OAuth 2.0</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
