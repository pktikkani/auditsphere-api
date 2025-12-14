import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../init.js';
import { db } from '@/lib/db/prisma.js';

const auditEventFilterSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  operation: z.string().optional(),
  userId: z.string().optional(),
  siteUrl: z.string().optional(),
  userType: z.number().int().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const auditEventsRouter = createTRPCRouter({
  /**
   * List audit events with filters
   */
  list: protectedProcedure
    .input(auditEventFilterSchema)
    .query(async ({ input }) => {
      const where: Record<string, unknown> = {};

      if (input.operation) {
        where.operation = { contains: input.operation, mode: 'insensitive' };
      }
      if (input.userId) {
        where.userId = { contains: input.userId, mode: 'insensitive' };
      }
      if (input.siteUrl) {
        where.siteUrl = { contains: input.siteUrl, mode: 'insensitive' };
      }
      if (input.userType !== undefined) {
        where.userType = input.userType;
      }
      if (input.startDate || input.endDate) {
        where.creationTime = {
          ...(input.startDate && { gte: new Date(input.startDate) }),
          ...(input.endDate && { lte: new Date(input.endDate) }),
        };
      }

      const [events, total, anomalyCount] = await Promise.all([
        db.auditEvent.findMany({
          where,
          orderBy: { creationTime: input.sortOrder },
          skip: (input.page - 1) * input.limit,
          take: input.limit,
          include: {
            anomalies: {
              select: {
                id: true,
                anomalyType: true,
                severity: true,
                anomalyScore: true,
              },
            },
          },
        }),
        db.auditEvent.count({ where }),
        db.anomaly.count(),
      ]);

      return {
        events,
        total,
        anomalyCount,
        page: input.page,
        limit: input.limit,
        totalPages: Math.ceil(total / input.limit),
      };
    }),

  /**
   * Get single event by ID
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const event = await db.auditEvent.findUnique({
        where: { id: input.id },
        include: {
          anomalies: true,
        },
      });

      return event;
    }),

  /**
   * Get audit event statistics
   */
  stats: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(7) }))
    .query(async ({ input }) => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - input.days);

      const [
        totalEvents,
        eventsInPeriod,
        operationCounts,
        userTypeCounts,
        uniqueUsers,
        uniqueSites,
        dailyCounts,
      ] = await Promise.all([
        db.auditEvent.count(),
        db.auditEvent.count({
          where: { creationTime: { gte: startDate } },
        }),
        db.auditEvent.groupBy({
          by: ['operation'],
          where: { creationTime: { gte: startDate } },
          _count: true,
          orderBy: { _count: { operation: 'desc' } },
          take: 10,
        }),
        db.auditEvent.groupBy({
          by: ['userType'],
          where: { creationTime: { gte: startDate } },
          _count: true,
        }),
        db.auditEvent.groupBy({
          by: ['userId'],
          where: {
            creationTime: { gte: startDate },
            userId: { not: null },
          },
        }),
        db.auditEvent.groupBy({
          by: ['siteUrl'],
          where: {
            creationTime: { gte: startDate },
            siteUrl: { not: null },
          },
        }),
        db.$queryRaw`
          SELECT DATE("creationTime") as date, COUNT(*)::int as count
          FROM audit_events
          WHERE "creationTime" >= ${startDate}
          GROUP BY DATE("creationTime")
          ORDER BY date ASC
        ` as Promise<Array<{ date: Date; count: number }>>,
      ]);

      const userTypeMap: Record<number, string> = {
        0: 'Regular',
        1: 'Guest',
        2: 'Admin',
        3: 'System',
      };

      return {
        summary: {
          totalEvents,
          eventsInPeriod,
          uniqueUsers: uniqueUsers.length,
          uniqueSites: uniqueSites.length,
        },
        operations: operationCounts.map((op) => ({
          operation: op.operation,
          count: op._count,
        })),
        userTypes: userTypeCounts.map((ut) => ({
          type: userTypeMap[ut.userType ?? 0] || 'Unknown',
          userType: ut.userType,
          count: ut._count,
        })),
        dailyTrend: dailyCounts.map((d) => ({
          date: d.date,
          count: d.count,
        })),
        users: uniqueUsers
          .map((u) => u.userId)
          .filter((id): id is string => id !== null)
          .sort(),
      };
    }),

  /**
   * Get unique users list
   */
  getUsers: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(90).default(30) }))
    .query(async ({ input }) => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - input.days);

      const users = await db.auditEvent.groupBy({
        by: ['userId'],
        where: {
          creationTime: { gte: startDate },
          userId: { not: null },
        },
        _count: true,
        orderBy: { _count: { userId: 'desc' } },
      });

      return users
        .filter((u) => u.userId !== null)
        .map((u) => ({
          userId: u.userId as string,
          eventCount: u._count,
        }));
    }),
});
