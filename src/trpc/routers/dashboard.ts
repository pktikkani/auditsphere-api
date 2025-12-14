import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../init.js';
import { db } from '../../lib/db/prisma.js';

export const dashboardRouter = createTRPCRouter({
  /**
   * Get complete dashboard overview data
   */
  overview: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(30).default(7) }))
    .query(async ({ input }) => {
      console.log('[Dashboard] overview called');
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - input.days);

      // Fetch all dashboard data in parallel
      const [
        totalEvents,
        eventsInPeriod,
        uniqueUsers,
        uniqueSites,
        recentEvents,
        totalAnomalies,
        recentAnomalies,
        unresolvedAnomalies,
        anomaliesBySeverity,
        totalAlerts,
        unreadAlerts,
        latestComplianceRun,
        dailyEventCounts,
        dailyAnomalyCounts,
      ] = await Promise.all([
        db.auditEvent.count(),
        db.auditEvent.count({ where: { creationTime: { gte: startDate } } }),
        db.auditEvent.groupBy({
          by: ['userId'],
          where: { creationTime: { gte: startDate }, userId: { not: null } },
        }),
        db.auditEvent.groupBy({
          by: ['siteUrl'],
          where: { creationTime: { gte: startDate }, siteUrl: { not: null } },
        }),
        db.auditEvent.findMany({
          orderBy: { creationTime: 'desc' },
          take: 5,
          select: {
            id: true,
            operation: true,
            userId: true,
            sourceFileName: true,
            creationTime: true,
          },
        }),
        db.anomaly.count(),
        db.anomaly.count({ where: { createdAt: { gte: startDate } } }),
        db.anomaly.count({ where: { status: { in: ['NEW', 'INVESTIGATING'] } } }),
        db.anomaly.groupBy({
          by: ['severity'],
          _count: true,
        }),
        db.alert.count(),
        db.alert.count({ where: { status: 'NEW' } }),
        db.complianceRun.findFirst({
          orderBy: { startedAt: 'desc' },
          where: { status: 'completed' },
        }),
        db.$queryRaw`
          SELECT DATE("creationTime") as date, COUNT(*)::int as count
          FROM audit_events
          WHERE "creationTime" >= ${startDate}
          GROUP BY DATE("creationTime")
          ORDER BY date ASC
        ` as Promise<Array<{ date: Date; count: number }>>,
        db.$queryRaw`
          SELECT DATE("createdAt") as date, COUNT(*)::int as count
          FROM anomalies
          WHERE "createdAt" >= ${startDate}
          GROUP BY DATE("createdAt")
          ORDER BY date ASC
        ` as Promise<Array<{ date: Date; count: number }>>,
      ]).catch((error) => {
        console.error('[Dashboard] Query error:', error);
        throw error;
      });

      // Calculate compliance score from latest run
      let complianceScore = null;
      let complianceSummary = null;
      if (latestComplianceRun) {
        const total = latestComplianceRun.totalChecks || 1;
        const passed = latestComplianceRun.passedChecks || 0;
        complianceScore = Math.round((passed / total) * 100);
        complianceSummary = {
          score: complianceScore,
          passed: latestComplianceRun.passedChecks,
          failed: latestComplianceRun.failedChecks,
          total: latestComplianceRun.totalChecks,
          lastRun: latestComplianceRun.startedAt,
        };
      }

      return {
        events: {
          total: totalEvents,
          inPeriod: eventsInPeriod,
          uniqueUsers: uniqueUsers.length,
          uniqueSites: uniqueSites.length,
          recent: recentEvents,
        },
        anomalies: {
          total: totalAnomalies,
          inPeriod: recentAnomalies,
          unresolved: unresolvedAnomalies,
          bySeverity: Object.fromEntries(
            anomaliesBySeverity.map((s) => [s.severity, s._count])
          ),
          criticalCount:
            (anomaliesBySeverity.find((s) => s.severity === 'CRITICAL')?._count || 0) +
            (anomaliesBySeverity.find((s) => s.severity === 'HIGH')?._count || 0),
        },
        alerts: {
          total: totalAlerts,
          unread: unreadAlerts,
        },
        compliance: complianceSummary,
        trends: {
          events: dailyEventCounts.map((d) => ({
            date: d.date,
            count: d.count,
          })),
          anomalies: dailyAnomalyCounts.map((d) => ({
            date: d.date,
            count: d.count,
          })),
        },
        period: {
          start: startDate,
          end: new Date(),
          days: input.days,
        },
      };
    }),

  /**
   * Get quick stats for header/nav display
   */
  quickStats: protectedProcedure.query(async () => {
    const [unresolvedAnomalies, unreadAlerts] = await Promise.all([
      db.anomaly.count({ where: { status: { in: ['NEW', 'INVESTIGATING'] } } }),
      db.alert.count({ where: { status: 'NEW' } }),
    ]);

    return {
      unresolvedAnomalies,
      unreadAlerts,
    };
  }),

  /**
   * Get activity feed (recent events + anomalies combined)
   */
  activityFeed: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ input }) => {
      const [events, anomalies] = await Promise.all([
        db.auditEvent.findMany({
          orderBy: { creationTime: 'desc' },
          take: input.limit,
          select: {
            id: true,
            operation: true,
            userId: true,
            sourceFileName: true,
            creationTime: true,
            siteUrl: true,
          },
        }),
        db.anomaly.findMany({
          orderBy: { createdAt: 'desc' },
          take: input.limit,
          include: {
            auditEvent: {
              select: {
                operation: true,
                userId: true,
                sourceFileName: true,
              },
            },
          },
        }),
      ]);

      const feed = [
        ...events.map((e) => ({
          type: 'event' as const,
          id: e.id,
          timestamp: e.creationTime,
          title: e.operation,
          subtitle: e.userId || 'Unknown user',
          details: e.sourceFileName,
        })),
        ...anomalies.map((a) => ({
          type: 'anomaly' as const,
          id: a.id,
          timestamp: a.createdAt,
          title: a.anomalyType.replace(/_/g, ' '),
          subtitle: a.auditEvent?.userId || 'Unknown user',
          details: `${a.severity} - ${a.auditEvent?.operation}`,
          severity: a.severity,
        })),
      ].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      return feed.slice(0, input.limit);
    }),
});
