import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import crypto from 'crypto';
import { db } from '../lib/db/prisma.js';
import { getAuthorizationUrl, TokenManager, getAppCredentials } from '../lib/microsoft/token-manager.js';

// In-memory state storage (in production, use Redis or similar)
const stateStore: Map<string, { userId: string; createdAt: number }> = new Map();

// Clean up expired states (older than 10 minutes)
function cleanupStates() {
  const now = Date.now();
  for (const [state, data] of stateStore.entries()) {
    if (now - data.createdAt > 10 * 60 * 1000) {
      stateStore.delete(state);
    }
  }
}

/**
 * Microsoft Connect - Initiates OAuth flow
 * GET /api/microsoft/connect?userId=xxx&returnUrl=xxx
 */
app.http('microsoft-connect', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'microsoft/connect',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const url = new URL(request.url);
      const userId = url.searchParams.get('userId');
      const returnUrl = url.searchParams.get('returnUrl') || process.env.SPFX_RETURN_URL || 'https://localhost:4321';

      if (!userId) {
        return {
          status: 400,
          jsonBody: { error: 'userId is required' },
        };
      }

      // Verify user exists
      const user = await db.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        return {
          status: 404,
          jsonBody: { error: 'User not found' },
        };
      }

      // Generate state for CSRF protection
      const state = crypto.randomBytes(32).toString('hex');

      // Store state with userId
      cleanupStates();
      stateStore.set(state, { userId, createdAt: Date.now() });

      // Build redirect URI
      const baseUrl = process.env.API_BASE_URL || `https://${request.headers.get('host')}`;
      const redirectUri = `${baseUrl}/api/microsoft/callback`;

      // Get authorization URL
      const authUrl = await getAuthorizationUrl(state, redirectUri, userId);

      // Store return URL in state (append to state)
      const fullState = `${state}|${Buffer.from(returnUrl).toString('base64')}`;
      stateStore.set(fullState, { userId, createdAt: Date.now() });

      // Update auth URL with full state
      const authUrlWithReturn = authUrl.replace(`state=${state}`, `state=${encodeURIComponent(fullState)}`);

      return {
        status: 302,
        headers: {
          'Location': authUrlWithReturn,
        },
      };
    } catch (error) {
      context.error('Microsoft connect error:', error);

      if (error instanceof Error && error.message.includes('credentials not configured')) {
        return {
          status: 400,
          jsonBody: { error: 'Microsoft credentials not configured. Please set up credentials first.' },
        };
      }

      return {
        status: 500,
        jsonBody: { error: 'Failed to initiate Microsoft connection' },
      };
    }
  },
});

/**
 * Microsoft Callback - Handles OAuth callback
 * GET /api/microsoft/callback?code=xxx&state=xxx
 */
app.http('microsoft-callback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'microsoft/callback',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const url = new URL(request.url);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');

      // Default return URL
      let returnUrl = process.env.SPFX_RETURN_URL || 'https://localhost:4321';

      // Parse state to extract return URL
      if (state) {
        const stateParts = decodeURIComponent(state).split('|');
        if (stateParts.length > 1) {
          try {
            returnUrl = Buffer.from(stateParts[1], 'base64').toString('utf8');
          } catch {
            // Ignore invalid base64
          }
        }
      }

      // Handle OAuth errors
      if (error) {
        context.error('OAuth error:', error, errorDescription);
        return {
          status: 302,
          headers: {
            'Location': `${returnUrl}?error=${encodeURIComponent(errorDescription || error)}`,
          },
        };
      }

      if (!code || !state) {
        return {
          status: 302,
          headers: {
            'Location': `${returnUrl}?error=missing_params`,
          },
        };
      }

      // Validate state
      const stateData = stateStore.get(decodeURIComponent(state));
      if (!stateData) {
        return {
          status: 302,
          headers: {
            'Location': `${returnUrl}?error=invalid_state`,
          },
        };
      }

      const { userId } = stateData;
      stateStore.delete(decodeURIComponent(state));

      // Get user
      const user = await db.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        return {
          status: 302,
          headers: {
            'Location': `${returnUrl}?error=user_not_found`,
          },
        };
      }

      // Get credentials
      const credentials = await getAppCredentials(userId);
      const tenantId = credentials.tenantId;

      // Build redirect URI (must match what was used in connect)
      const baseUrl = process.env.API_BASE_URL || `https://${request.headers.get('host')}`;
      const redirectUri = `${baseUrl}/api/microsoft/callback`;

      // Exchange code for tokens
      const tokens = await TokenManager.exchangeCodeForTokens(
        code,
        tenantId,
        redirectUri,
        userId
      );

      // Get tenant info from Graph API
      let tenantName: string | null = null;
      try {
        const orgResponse = await fetch(
          'https://graph.microsoft.com/v1.0/organization',
          {
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
            },
          }
        );
        if (orgResponse.ok) {
          const orgData = await orgResponse.json() as { value?: Array<{ displayName?: string }> };
          tenantName = orgData.value?.[0]?.displayName || null;
        }
      } catch (e) {
        context.warn('Failed to get tenant info:', e);
      }

      // Store tokens
      const scopes = [
        'Sites.Read.All',
        'AuditLog.Read.All',
        'SecurityEvents.Read.All',
        'Directory.Read.All',
        'User.Read.All',
        'ActivityFeed.Read',
      ];

      await TokenManager.storeTokens(
        userId,
        tenantId,
        tenantName,
        tokens,
        scopes
      );

      context.log(`Microsoft 365 connected for user ${userId}, tenant: ${tenantName || tenantId}`);

      return {
        status: 302,
        headers: {
          'Location': `${returnUrl}?success=true&tenant=${encodeURIComponent(tenantName || tenantId)}`,
        },
      };
    } catch (error) {
      context.error('Microsoft callback error:', error);

      const returnUrl = process.env.SPFX_RETURN_URL || 'https://localhost:4321';
      return {
        status: 302,
        headers: {
          'Location': `${returnUrl}?error=${encodeURIComponent(String(error))}`,
        },
      };
    }
  },
});

/**
 * Microsoft Status - Get connection status for a user
 * GET /api/microsoft/status (requires auth via tRPC, but also available directly)
 */
app.http('microsoft-status', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'microsoft/status/{userId}',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const userId = request.params.userId;

      if (!userId) {
        return {
          status: 400,
          jsonBody: { error: 'userId is required' },
        };
      }

      const connections = await db.microsoftConnection.findMany({
        where: {
          userId,
          isActive: true,
        },
        select: {
          id: true,
          tenantId: true,
          tenantName: true,
          status: true,
          isActive: true,
          lastSyncAt: true,
          tokenExpiresAt: true,
          createdAt: true,
        },
      });

      return {
        jsonBody: {
          connected: connections.length > 0,
          connections,
        },
      };
    } catch (error) {
      context.error('Microsoft status error:', error);
      return {
        status: 500,
        jsonBody: { error: 'Failed to get Microsoft status' },
      };
    }
  },
});
