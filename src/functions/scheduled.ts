import { app, InvocationContext, Timer } from '@azure/functions';
import { db } from '../lib/db/prisma.js';
import { ManagementApiClient } from '../lib/microsoft/management-api.js';
import { detectAnomalies, checkHealth, AuditEventInput } from '../lib/ml/client.js';
import type { Prisma } from '@prisma/client';

/**
 * Scheduled Sync - Fetch audit events from Microsoft 365
 * Runs every 15 minutes
 */
app.timer('scheduled-sync', {
  schedule: '0 */15 * * * *', // Every 15 minutes
  handler: async (timer: Timer, context: InvocationContext): Promise<void> => {
    context.log('Scheduled sync triggered at:', timer.scheduleStatus);

    try {
      // Get all active Microsoft connections
      const connections = await db.microsoftConnection.findMany({
        where: { status: 'active' },
        include: { user: true },
      });

      if (connections.length === 0) {
        context.log('No active Microsoft connections found');
        return;
      }

      let totalNewEvents = 0;
      let totalDuplicates = 0;

      // Process each connection
      for (const connection of connections) {
        try {
          const managementApi = new ManagementApiClient(connection.userId, connection.tenantId);

          // Fetch events from last 24 hours
          const endTime = new Date();
          const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);

          context.log(`[${connection.tenantId}] Fetching audit events from ${startTime.toISOString()} to ${endTime.toISOString()}`);

          const events = await managementApi.fetchAuditEvents(startTime, endTime);

          context.log(`[${connection.tenantId}] Fetched ${events.length} events from O365`);

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
              context.error(`[${connection.tenantId}] Failed to store event ${event.Id}:`, err);
            }
          }

          // Update last sync time
          await db.microsoftConnection.update({
            where: { id: connection.id },
            data: { lastSyncAt: new Date() },
          });

          totalNewEvents += newCount;
          totalDuplicates += duplicateCount;

          context.log(`[${connection.tenantId}] Synced ${newCount} new events (${duplicateCount} duplicates)`);
        } catch (err) {
          context.error(`[${connection.tenantId}] Failed to sync:`, err);
        }
      }

      context.log(`Scheduled sync completed: ${totalNewEvents} new events across ${connections.length} tenants`);
    } catch (error) {
      context.error('Scheduled sync failed:', error);
    }
  },
});

/**
 * Scheduled Anomaly Detection - Analyze events using ML service
 * Runs every 15 minutes
 */
app.timer('scheduled-anomaly-detection', {
  schedule: '0 */15 * * * *', // Every 15 minutes
  handler: async (timer: Timer, context: InvocationContext): Promise<void> => {
    context.log('Scheduled anomaly detection triggered at:', timer.scheduleStatus);

    try {
      // Check ML service health first
      const mlHealthy = await checkHealth();
      if (!mlHealthy) {
        context.warn('ML service unavailable, skipping anomaly detection');
        return;
      }

      // Get audit events that don't have an associated anomaly yet
      // Process in batches to avoid overwhelming the ML service
      const unprocessedEvents = await db.auditEvent.findMany({
        where: {
          anomalies: { none: {} },
        },
        orderBy: { creationTime: 'desc' },
        take: 500,
      });

      if (unprocessedEvents.length === 0) {
        context.log('No unprocessed events to analyze');
        return;
      }

      context.log(`Processing ${unprocessedEvents.length} audit events for anomaly detection`);

      // Compute historical context for each event and prepare for ML
      const eventsForMl: AuditEventInput[] = [];

      for (const event of unprocessedEvents) {
        const eventContext = await computeHistoricalContext(event.userId, event.creationTime);

        eventsForMl.push({
          event_id: event.eventId,
          creation_time: event.creationTime.toISOString(),
          operation: event.operation,
          user_id: event.userId,
          user_type: event.userType,
          site_url: event.siteUrl,
          source_file_name: event.sourceFileName,
          client_ip: event.clientIp,
          raw_event: event.rawEvent as Record<string, unknown>,
          event_count_1h: eventContext.eventCount1h,
          event_count_24h: eventContext.eventCount24h,
          unique_sites_24h: eventContext.uniqueSites24h,
          unique_ops_24h: eventContext.uniqueOps24h,
          events_last_5min: eventContext.eventsLast5min,
          is_new_ip: eventContext.isNewIp,
          unusual_location: eventContext.unusualLocation,
        });
      }

      // Send to ML service
      const mlResults = await detectAnomalies(eventsForMl);

      // Store detected anomalies
      let anomaliesCreated = 0;
      let alertsCreated = 0;

      for (const result of mlResults.results) {
        if (result.is_anomaly) {
          // Find the audit event
          const auditEvent = unprocessedEvents.find((e) => e.eventId === result.event_id);
          if (!auditEvent) continue;

          // Create anomaly record
          const severity = calculateSeverity(result.anomaly_score, result.confidence);

          const anomaly = await db.anomaly.create({
            data: {
              auditEventId: auditEvent.id,
              anomalyScore: result.anomaly_score,
              confidence: result.confidence,
              anomalyType: result.anomaly_type || 'general',
              featuresUsed: result.features_used,
              severity,
            },
          });

          anomaliesCreated++;

          // Create alert for medium+ severity
          if (severity !== 'LOW') {
            await db.alert.create({
              data: {
                type: 'ANOMALY',
                severity,
                title: `Anomaly Detected: ${result.anomaly_type || 'Unusual Activity'}`,
                description: `Suspicious activity detected for user ${auditEvent.userId}. Operation: ${auditEvent.operation}`,
                anomalyId: anomaly.id,
                metadata: {
                  eventId: auditEvent.eventId,
                  operation: auditEvent.operation,
                  userId: auditEvent.userId,
                  anomalyScore: result.anomaly_score,
                  confidence: result.confidence,
                },
              },
            });
            alertsCreated++;
          }
        }
      }

      context.log(`Scheduled anomaly detection completed: ${anomaliesCreated} anomalies, ${alertsCreated} alerts`);
    } catch (error) {
      context.error('Scheduled anomaly detection failed:', error);
    }
  },
});

/**
 * Compute historical context for anomaly detection
 */
async function computeHistoricalContext(
  userId: string | null,
  eventTime: Date
): Promise<{
  eventCount1h: number;
  eventCount24h: number;
  uniqueSites24h: number;
  uniqueOps24h: number;
  eventsLast5min: number;
  isNewIp: boolean;
  unusualLocation: boolean;
}> {
  if (!userId) {
    return {
      eventCount1h: 0,
      eventCount24h: 0,
      uniqueSites24h: 0,
      uniqueOps24h: 0,
      eventsLast5min: 0,
      isNewIp: false,
      unusualLocation: false,
    };
  }

  const oneHourAgo = new Date(eventTime.getTime() - 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(eventTime.getTime() - 24 * 60 * 60 * 1000);
  const fiveMinutesAgo = new Date(eventTime.getTime() - 5 * 60 * 1000);

  const [eventCount1h, eventCount24h, eventsLast5min, uniqueSites, uniqueOps] = await Promise.all([
    db.auditEvent.count({
      where: {
        userId,
        creationTime: { gte: oneHourAgo, lt: eventTime },
      },
    }),
    db.auditEvent.count({
      where: {
        userId,
        creationTime: { gte: twentyFourHoursAgo, lt: eventTime },
      },
    }),
    db.auditEvent.count({
      where: {
        userId,
        creationTime: { gte: fiveMinutesAgo, lt: eventTime },
      },
    }),
    db.auditEvent.groupBy({
      by: ['siteUrl'],
      where: {
        userId,
        creationTime: { gte: twentyFourHoursAgo, lt: eventTime },
        siteUrl: { not: null },
      },
    }),
    db.auditEvent.groupBy({
      by: ['operation'],
      where: {
        userId,
        creationTime: { gte: twentyFourHoursAgo, lt: eventTime },
      },
    }),
  ]);

  return {
    eventCount1h,
    eventCount24h,
    uniqueSites24h: uniqueSites.length,
    uniqueOps24h: uniqueOps.length,
    eventsLast5min,
    isNewIp: false,
    unusualLocation: false,
  };
}

/**
 * Calculate severity based on anomaly score and confidence
 */
function calculateSeverity(score: number, confidence: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  const combined = score * confidence;

  if (combined >= 0.9) return 'CRITICAL';
  if (combined >= 0.7) return 'HIGH';
  if (combined >= 0.4) return 'MEDIUM';
  return 'LOW';
}
