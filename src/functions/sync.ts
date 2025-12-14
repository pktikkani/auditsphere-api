import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { db } from '../lib/db/prisma.js';
import { ManagementApiClient } from '../lib/microsoft/management-api.js';
import type { Prisma } from '@prisma/client';

/**
 * Sync Audit Events - Fetch and store audit events from Microsoft 365
 * POST /api/sync/events
 * Query params: userId (required), hours (optional, default 24)
 */
app.http('sync-events', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'sync/events',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const url = new URL(request.url);
      const userId = url.searchParams.get('userId');
      const hours = parseInt(url.searchParams.get('hours') || '24', 10);

      if (!userId) {
        return {
          status: 400,
          jsonBody: { error: 'userId is required' },
        };
      }

      // Get user
      const user = await db.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        return {
          status: 404,
          jsonBody: { error: 'User not found' },
        };
      }

      // Get Microsoft connection
      const connection = await db.microsoftConnection.findFirst({
        where: {
          userId: user.id,
          status: 'active',
        },
      });

      if (!connection) {
        return {
          status: 400,
          jsonBody: { error: 'No active Microsoft connection. Please connect Microsoft 365 first.' },
        };
      }

      // Create Management API client
      const managementApi = new ManagementApiClient(user.id, connection.tenantId);

      // Fetch events from last N hours
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

      context.log(`Fetching audit events from ${startTime.toISOString()} to ${endTime.toISOString()}`);

      const events = await managementApi.fetchAuditEvents(startTime, endTime);

      context.log(`Fetched ${events.length} events from O365`);

      // Store events in database
      let newCount = 0;
      let duplicateCount = 0;

      for (const event of events) {
        try {
          // Check if event already exists
          const existing = await db.auditEvent.findUnique({
            where: { eventId: event.Id },
          });

          if (existing) {
            duplicateCount++;
            continue;
          }

          // Create new event
          await db.auditEvent.create({
            data: {
              eventId: event.Id,
              tenantId: event.OrganizationId,
              creationTime: new Date(event.CreationTime),
              recordType: event.RecordType,
              operation: event.Operation,
              workload: event.Workload,
              userId: event.UserId || event.UserKey,
              userType: event.UserType,
              clientIp: event.ClientIP || null,
              siteUrl: event.SiteUrl || null,
              sourceFileName: event.SourceFileName || null,
              sourceRelativeUrl: null,
              itemType: event.ItemType || null,
              userAgent: event.UserAgent || null,
              rawEvent: event as unknown as Prisma.JsonObject,
            },
          });

          newCount++;
        } catch (err) {
          context.error(`Failed to store event ${event.Id}:`, err);
        }
      }

      // Update last sync time
      await db.microsoftConnection.update({
        where: { id: connection.id },
        data: { lastSyncAt: new Date() },
      });

      return {
        jsonBody: {
          success: true,
          message: `Synced ${newCount} new events (${duplicateCount} duplicates skipped)`,
          count: newCount,
          duplicates: duplicateCount,
          total: events.length,
        },
      };
    } catch (error) {
      context.error('Sync error:', error);
      return {
        status: 500,
        jsonBody: {
          error: error instanceof Error ? error.message : 'Failed to sync audit events',
        },
      };
    }
  },
});

/**
 * Start Subscription - Start listening for audit events
 * POST /api/sync/subscription/start
 */
app.http('start-subscription', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'sync/subscription/start',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const url = new URL(request.url);
      const userId = url.searchParams.get('userId');

      if (!userId) {
        return {
          status: 400,
          jsonBody: { error: 'userId is required' },
        };
      }

      // Get Microsoft connection
      const connection = await db.microsoftConnection.findFirst({
        where: {
          userId,
          status: 'active',
        },
      });

      if (!connection) {
        return {
          status: 400,
          jsonBody: { error: 'No active Microsoft connection' },
        };
      }

      const managementApi = new ManagementApiClient(userId, connection.tenantId);

      // Start subscription (without webhook for now - we'll poll)
      const subscription = await managementApi.startSubscription();

      return {
        jsonBody: {
          success: true,
          subscription,
        },
      };
    } catch (error) {
      context.error('Start subscription error:', error);
      return {
        status: 500,
        jsonBody: {
          error: error instanceof Error ? error.message : 'Failed to start subscription',
        },
      };
    }
  },
});

/**
 * List Subscriptions - Get current subscriptions
 * GET /api/sync/subscriptions
 */
app.http('list-subscriptions', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'sync/subscriptions',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const url = new URL(request.url);
      const userId = url.searchParams.get('userId');

      if (!userId) {
        return {
          status: 400,
          jsonBody: { error: 'userId is required' },
        };
      }

      // Get Microsoft connection
      const connection = await db.microsoftConnection.findFirst({
        where: {
          userId,
          status: 'active',
        },
      });

      if (!connection) {
        return {
          status: 400,
          jsonBody: { error: 'No active Microsoft connection' },
        };
      }

      const managementApi = new ManagementApiClient(userId, connection.tenantId);
      const subscriptions = await managementApi.listSubscriptions();

      return {
        jsonBody: { subscriptions },
      };
    } catch (error) {
      context.error('List subscriptions error:', error);
      return {
        status: 500,
        jsonBody: {
          error: error instanceof Error ? error.message : 'Failed to list subscriptions',
        },
      };
    }
  },
});
