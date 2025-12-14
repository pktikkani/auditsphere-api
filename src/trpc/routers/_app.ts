import { createTRPCRouter } from '../init.js';
import { anomaliesRouter } from './anomalies.js';
import { auditEventsRouter } from './auditEvents.js';
import { complianceRouter } from './compliance.js';
import { alertsRouter } from './alerts.js';
import { reportsRouter } from './reports.js';
import { dashboardRouter } from './dashboard.js';
import { microsoftRouter } from './microsoft.js';
import { sitesRouter } from './sites.js';
import { settingsRouter } from './settings.js';

/**
 * Root tRPC Router
 *
 * All routers added here will be available at /api/trpc/*
 */
export const appRouter = createTRPCRouter({
  // Core feature routers
  anomalies: anomaliesRouter,
  auditEvents: auditEventsRouter,
  compliance: complianceRouter,
  alerts: alertsRouter,
  reports: reportsRouter,
  sites: sitesRouter,

  // Dashboard and overview
  dashboard: dashboardRouter,

  // Microsoft/Azure integration
  microsoft: microsoftRouter,

  // User settings
  settings: settingsRouter,
});

/**
 * Export type definition of API
 * This is used by the SPFx client for end-to-end type safety
 */
export type AppRouter = typeof appRouter;
