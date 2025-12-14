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
