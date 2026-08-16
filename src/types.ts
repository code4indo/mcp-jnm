export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: any;
}

export interface MCPResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: any[];
}

export interface LogEntry {
  id: string;
  timestamp: string;
  type: "info" | "request" | "response" | "error";
  title: string;
  data?: any;
}

export interface OAuthTokens {
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

export interface OAuthProviderConfig {
  name: string;
  id: string;
  authUrl: string;
  tokenUrl: string;
  defaultScope: string;
  usePKCE: boolean;
  requiresClientSecret: boolean;
  description: string;
}
