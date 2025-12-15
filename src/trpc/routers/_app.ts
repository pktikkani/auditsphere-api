import { createTRPCRouter } from '../init.js';
import { accessReviewRouter } from './accessReview.js';
import { microsoftRouter } from './microsoft.js';
import { userRouter } from './user.js';
import { settingsRouter } from './settings.js';

/**
 * Root tRPC Router - Access Review Only
 *
 * All routers added here will be available at /api/trpc/*
 */
export const appRouter = createTRPCRouter({
  // Access Review
  accessReview: accessReviewRouter,

  // Microsoft/Azure integration (required for OAuth)
  microsoft: microsoftRouter,

  // User settings and profile
  settings: settingsRouter,
  user: userRouter,
});

/**
 * Export type definition of API
 * This is used by the SPFx client for end-to-end type safety
 */
export type AppRouter = typeof appRouter;
