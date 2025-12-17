import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from './trpc/routers/_app.js';
import { createTRPCContext } from './trpc/init.js';
import { microsoftRouter } from './routes/microsoft.js';
import { scheduledSync, scheduledAnomalyDetection } from './jobs/scheduled.js';
import { startAccessReviewScheduler } from './jobs/access-review-scheduler.js';
import { db } from './lib/db/prisma.js';
import jwt from 'jsonwebtoken';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// Debug endpoint
app.get('/api/debug', async (_req: Request, res: Response) => {
  try {
    const userCount = await db.user.count();
    res.json({ status: 'ok', database: 'connected', users: userCount });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown',
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
});

// Auth debug endpoint
app.all('/api/auth-debug', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.json({
      error: 'No Bearer token',
      headers: req.headers,
    });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.decode(token, { complete: true });
    return res.json({
      status: 'token_received',
      header: decoded?.header,
      payload: decoded?.payload,
      envConfig: {
        MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID,
        MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
      },
    });
  } catch (error) {
    return res.status(500).json({
      status: 'decode_error',
      message: error instanceof Error ? error.message : 'Unknown',
    });
  }
});

// Microsoft OAuth routes
app.use('/api/microsoft', microsoftRouter);

// tRPC handler (Express 5 requires named wildcard parameter)
app.all('/api/trpc/*path', async (req: Request, res: Response) => {
  try {
    // Build the full URL
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    const fullUrl = `${protocol}://${host}${req.originalUrl}`;

    // Create a fetch-compatible Request
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
    }

    const fetchRequest = new globalThis.Request(fullUrl, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
    });

    const response = await fetchRequestHandler({
      endpoint: '/api/trpc',
      req: fetchRequest,
      router: appRouter,
      createContext: ({ req }) => createTRPCContext({ headers: req.headers }),
      onError: ({ path, error }) => {
        console.error(`tRPC error on ${path}:`, error);
      },
    });

    // Send response
    res.status(response.status);
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const body = await response.text();
    res.send(body);
  } catch (error) {
    console.error('tRPC handler error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Cron jobs (run every 15 minutes)
cron.schedule('*/15 * * * *', async () => {
  console.log('[Cron] Running scheduled sync...');
  try {
    await scheduledSync();
  } catch (error) {
    console.error('[Cron] Scheduled sync failed:', error);
  }
});

cron.schedule('*/15 * * * *', async () => {
  console.log('[Cron] Running anomaly detection...');
  try {
    await scheduledAnomalyDetection();
  } catch (error) {
    console.error('[Cron] Anomaly detection failed:', error);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
  console.log(`📍 tRPC endpoint: http://localhost:${PORT}/api/trpc/*`);

  // Start the Access Review scheduler
  startAccessReviewScheduler();
});

export default app;
