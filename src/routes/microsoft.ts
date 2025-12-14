import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../lib/db/prisma.js';
import { getAuthorizationUrl, TokenManager, getAppCredentials } from '../lib/microsoft/token-manager.js';

export const microsoftRouter = Router();

// In-memory state storage (in production, use Redis or similar)
const stateStore: Map<string, { userId: string; createdAt: number }> = new Map();

// Clean up expired states (older than 10 minutes)
function cleanupStates(): void {
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
microsoftRouter.get('/connect', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const returnUrl = (req.query.returnUrl as string) || process.env.SPFX_RETURN_URL || 'https://localhost:4321';

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Verify user exists
    const user = await db.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Generate state for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');

    // Store state with userId
    cleanupStates();
    stateStore.set(state, { userId, createdAt: Date.now() });

    // Build redirect URI
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = process.env.API_BASE_URL || `${protocol}://${host}`;
    const redirectUri = `${baseUrl}/api/microsoft/callback`;

    // Get authorization URL
    const authUrl = await getAuthorizationUrl(state, redirectUri, userId);

    // Store return URL in state (append to state)
    const fullState = `${state}|${Buffer.from(returnUrl).toString('base64')}`;
    stateStore.set(fullState, { userId, createdAt: Date.now() });

    // Update auth URL with full state
    const authUrlWithReturn = authUrl.replace(`state=${state}`, `state=${encodeURIComponent(fullState)}`);

    return res.redirect(authUrlWithReturn);
  } catch (error) {
    console.error('Microsoft connect error:', error);

    if (error instanceof Error && error.message.includes('credentials not configured')) {
      return res.status(400).json({ error: 'Microsoft credentials not configured. Please set up credentials first.' });
    }

    return res.status(500).json({ error: 'Failed to initiate Microsoft connection' });
  }
});

/**
 * Microsoft Callback - Handles OAuth callback
 * GET /api/microsoft/callback?code=xxx&state=xxx
 */
microsoftRouter.get('/callback', async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const error = req.query.error as string;
    const errorDescription = req.query.error_description as string;

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
      console.error('OAuth error:', error, errorDescription);
      return res.redirect(`${returnUrl}?error=${encodeURIComponent(errorDescription || error)}`);
    }

    if (!code || !state) {
      return res.redirect(`${returnUrl}?error=missing_params`);
    }

    // Validate state
    const stateData = stateStore.get(decodeURIComponent(state));
    if (!stateData) {
      return res.redirect(`${returnUrl}?error=invalid_state`);
    }

    const { userId } = stateData;
    stateStore.delete(decodeURIComponent(state));

    // Get user
    const user = await db.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.redirect(`${returnUrl}?error=user_not_found`);
    }

    // Get credentials
    const credentials = await getAppCredentials(userId);
    const tenantId = credentials.tenantId;

    // Build redirect URI (must match what was used in connect)
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = process.env.API_BASE_URL || `${protocol}://${host}`;
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
      const orgResponse = await fetch('https://graph.microsoft.com/v1.0/organization', {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
        },
      });
      if (orgResponse.ok) {
        const orgData = (await orgResponse.json()) as { value?: Array<{ displayName?: string }> };
        tenantName = orgData.value?.[0]?.displayName || null;
      }
    } catch (e) {
      console.warn('Failed to get tenant info:', e);
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

    await TokenManager.storeTokens(userId, tenantId, tenantName, tokens, scopes);

    console.log(`Microsoft 365 connected for user ${userId}, tenant: ${tenantName || tenantId}`);

    return res.redirect(`${returnUrl}?success=true&tenant=${encodeURIComponent(tenantName || tenantId)}`);
  } catch (error) {
    console.error('Microsoft callback error:', error);

    const returnUrl = process.env.SPFX_RETURN_URL || 'https://localhost:4321';
    return res.redirect(`${returnUrl}?error=${encodeURIComponent(String(error))}`);
  }
});

/**
 * Microsoft Status - Get connection status for a user
 * GET /api/microsoft/status/:userId
 */
microsoftRouter.get('/status/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
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

    return res.json({
      connected: connections.length > 0,
      connections,
    });
  } catch (error) {
    console.error('Microsoft status error:', error);
    return res.status(500).json({ error: 'Failed to get Microsoft status' });
  }
});
