import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '../trpc/routers/_app.js';
import { createTRPCContext } from '../trpc/init.js';

/**
 * Azure Function handler for tRPC
 *
 * Handles all tRPC requests at /api/trpc/*
 */
async function trpcHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log(`tRPC request: ${request.method} ${request.url}`);

  try {
    // Extract the path after /api/trpc/
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/api/trpc/');
    const trpcPath = pathParts[1] || '';

    // Create a fetch-compatible Request object
    const fetchRequest = new Request(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.text()
        : undefined,
    });

    // Handle the request using tRPC's fetch adapter
    const response = await fetchRequestHandler({
      endpoint: '/api/trpc',
      req: fetchRequest,
      router: appRouter,
      createContext: ({ req }) => createTRPCContext({ headers: req.headers }),
      onError: ({ path, error }) => {
        context.error(`tRPC error on ${path}:`, error);
      },
    });

    // Convert the Response to Azure Functions format
    const body = await response.text();

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  } catch (error) {
    context.error('tRPC handler error:', error);
    return {
      status: 500,
      jsonBody: {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    };
  }
}

// Register the function for all HTTP methods at /api/trpc/{*path}
app.http('trpc', {
  methods: ['GET', 'POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'trpc/{*path}',
  handler: trpcHandler,
});

// Health check endpoint
app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    return {
      jsonBody: {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };
  },
});

// Debug endpoint - test database connection
app.http('debug', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'debug',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const { db } = await import('../lib/db/prisma.js');
      const userCount = await db.user.count();
      return {
        jsonBody: { status: 'ok', database: 'connected', users: userCount },
      };
    } catch (error) {
      return {
        status: 500,
        jsonBody: {
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown',
          stack: error instanceof Error ? error.stack : undefined,
        },
      };
    }
  },
});

// Auth debug endpoint - test token validation
app.http('auth-debug', {
  methods: ['GET', 'POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'auth-debug',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const jwt = await import('jsonwebtoken');

    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return {
        jsonBody: {
          error: 'No Bearer token',
          headers: Object.fromEntries(request.headers.entries()),
        },
      };
    }

    const token = authHeader.substring(7);

    try {
      // Decode without verification to see claims
      const decoded = jwt.default.decode(token, { complete: true });

      return {
        jsonBody: {
          status: 'token_received',
          header: decoded?.header,
          payload: decoded?.payload,
          envConfig: {
            MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID,
            MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
          },
        },
      };
    } catch (error) {
      return {
        status: 500,
        jsonBody: {
          status: 'decode_error',
          message: error instanceof Error ? error.message : 'Unknown',
        },
      };
    }
  },
});
