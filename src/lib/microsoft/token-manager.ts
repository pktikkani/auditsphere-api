import { db } from '../db/prisma.js';
import { encrypt, decrypt } from './crypto.js';

const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com';
const MANAGEMENT_SCOPE = 'https://manage.office.com/.default';

// Cache for Management API tokens (app-only)
const managementTokenCache: Map<string, { token: string; expiresAt: Date }> = new Map();

// Cache for Graph API tokens (app-only)
const graphTokenCache: Map<string, { token: string; expiresAt: Date }> = new Map();

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface ValidToken {
  accessToken: string;
  tokenExpiresAt: Date;
}

interface AppCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Get app credentials for a user (custom or env)
 */
export async function getAppCredentials(userId?: string): Promise<AppCredentials> {
  // Try to get user-specific credentials if userId provided
  if (userId) {
    const userCredentials = await db.appCredentials.findUnique({
      where: { userId },
    });

    if (userCredentials && userCredentials.useCustomCredentials) {
      return {
        tenantId: decrypt(userCredentials.tenantId),
        clientId: decrypt(userCredentials.clientId),
        clientSecret: decrypt(userCredentials.clientSecret),
      };
    }
  }

  // Fall back to environment variables
  const tenantId = process.env.MICROSOFT_TENANT_ID;
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Microsoft credentials not configured. Set up credentials in Settings or provide environment variables.');
  }

  return {
    tenantId: tenantId || 'common',
    clientId,
    clientSecret,
  };
}

export class TokenManager {
  private userId: string;
  private tenantId?: string;

  constructor(userId: string, tenantId?: string) {
    this.userId = userId;
    this.tenantId = tenantId;
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getValidToken(): Promise<ValidToken> {
    const connection = await db.microsoftConnection.findFirst({
      where: {
        userId: this.userId,
        ...(this.tenantId ? { tenantId: this.tenantId } : {}),
        status: 'active',
      },
    });

    if (!connection) {
      throw new Error('No active Microsoft connection found');
    }

    // Check if token needs refresh (5 minute buffer)
    const bufferTime = 5 * 60 * 1000; // 5 minutes
    if (connection.tokenExpiresAt.getTime() - Date.now() < bufferTime) {
      return this.refreshToken(connection.id, connection.tenantId);
    }

    return {
      accessToken: decrypt(connection.accessToken),
      tokenExpiresAt: connection.tokenExpiresAt,
    };
  }

  /**
   * Refresh an expired token
   */
  private async refreshToken(
    connectionId: string,
    tenantId: string
  ): Promise<ValidToken> {
    const connection = await db.microsoftConnection.findUnique({
      where: { id: connectionId },
    });

    if (!connection) {
      throw new Error('Connection not found');
    }

    const refreshTokenValue = decrypt(connection.refreshToken);
    const credentials = await getAppCredentials(this.userId);

    const tokenEndpoint = `${MICROSOFT_TOKEN_URL}/${tenantId}/oauth2/v2.0/token`;

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: refreshTokenValue,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/.default offline_access',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Token refresh failed:', error);

      // Mark connection as expired
      await db.microsoftConnection.update({
        where: { id: connectionId },
        data: { status: 'expired' },
      });

      throw new Error('Failed to refresh token');
    }

    const tokens = await response.json() as TokenResponse;
    const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Update stored tokens
    await db.microsoftConnection.update({
      where: { id: connectionId },
      data: {
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token),
        tokenExpiresAt,
        status: 'active',
      },
    });

    return {
      accessToken: tokens.access_token,
      tokenExpiresAt,
    };
  }

  /**
   * Exchange authorization code for tokens
   */
  static async exchangeCodeForTokens(
    code: string,
    tenantId: string,
    redirectUri: string,
    userId?: string
  ): Promise<TokenResponse> {
    const credentials = await getAppCredentials(userId);
    const tokenEndpoint = `${MICROSOFT_TOKEN_URL}/${tenantId}/oauth2/v2.0/token`;

    // Use the same scopes as authorization request
    const scopes = [
      'https://graph.microsoft.com/Sites.Read.All',
      'https://graph.microsoft.com/AuditLog.Read.All',
      'https://graph.microsoft.com/SecurityEvents.Read.All',
      'https://graph.microsoft.com/Directory.Read.All',
      'https://graph.microsoft.com/User.Read.All',
      'offline_access',
    ];

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: scopes.join(' '),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return await response.json() as TokenResponse;
  }

  /**
   * Store tokens for a user
   */
  static async storeTokens(
    userId: string,
    tenantId: string,
    tenantName: string | null,
    tokens: TokenResponse,
    scopes: string[]
  ): Promise<void> {
    const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    await db.microsoftConnection.upsert({
      where: {
        userId_tenantId: {
          userId,
          tenantId,
        },
      },
      update: {
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token),
        tokenExpiresAt,
        scopes,
        status: 'active',
        isActive: true,
        tenantName,
      },
      create: {
        userId,
        tenantId,
        tenantName,
        accessToken: encrypt(tokens.access_token),
        refreshToken: encrypt(tokens.refresh_token),
        tokenExpiresAt,
        scopes,
        status: 'active',
        isActive: true,
      },
    });
  }

  /**
   * Get a Management API token using client credentials flow (app-only)
   */
  async getManagementApiToken(): Promise<string> {
    const credentials = await getAppCredentials(this.userId);
    const tenantId = this.tenantId || credentials.tenantId;
    const cacheKey = `${tenantId}:${this.userId}`;

    // Check cache
    const cached = managementTokenCache.get(cacheKey);
    if (cached && cached.expiresAt.getTime() - Date.now() > 60000) {
      return cached.token;
    }

    const tokenEndpoint = `${MICROSOFT_TOKEN_URL}/${tenantId}/oauth2/v2.0/token`;

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: 'client_credentials',
        scope: MANAGEMENT_SCOPE,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get Management API token: ${error}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    // Cache the token
    managementTokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt,
    });

    return data.access_token;
  }

  /**
   * Get a Graph API token using client credentials flow (app-only)
   * Required for Sites.FullControl.All and other application permissions
   */
  async getAppOnlyGraphToken(): Promise<string> {
    const credentials = await getAppCredentials(this.userId);
    const tenantId = this.tenantId || credentials.tenantId;
    const cacheKey = `graph:${tenantId}:${this.userId}`;

    // Check cache
    const cached = graphTokenCache.get(cacheKey);
    if (cached && cached.expiresAt.getTime() - Date.now() > 60000) {
      return cached.token;
    }

    const tokenEndpoint = `${MICROSOFT_TOKEN_URL}/${tenantId}/oauth2/v2.0/token`;

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: 'client_credentials',
        scope: 'https://graph.microsoft.com/.default',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get Graph API token: ${error}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    // Cache the token
    graphTokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt,
    });

    return data.access_token;
  }
}

/**
 * Get authorization URL for Microsoft OAuth
 */
export async function getAuthorizationUrl(state: string, redirectUri: string, userId?: string): Promise<string> {
  const credentials = await getAppCredentials(userId);

  const scopes = [
    'https://graph.microsoft.com/Sites.Read.All',
    'https://graph.microsoft.com/AuditLog.Read.All',
    'https://graph.microsoft.com/SecurityEvents.Read.All',
    'https://graph.microsoft.com/Directory.Read.All',
    'https://graph.microsoft.com/User.Read.All',
    'https://manage.office.com/ActivityFeed.Read',
    'offline_access',
  ];

  const params = new URLSearchParams({
    client_id: credentials.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: scopes.join(' '),
    state,
    prompt: 'consent',
  });

  return `${MICROSOFT_TOKEN_URL}/${credentials.tenantId}/oauth2/v2.0/authorize?${params}`;
}
