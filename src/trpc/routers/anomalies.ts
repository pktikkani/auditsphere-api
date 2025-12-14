import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../init.js';
import { db } from '../../lib/db/prisma.js';
import { TRPCError } from '@trpc/server';

const anomalyFilterSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  status: z.enum(['NEW', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE']).optional(),
  anomalyType: z.string().optional(),
  userId: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const updateStatusSchema = z.object({
  id: z.string(),
  status: z.enum(['NEW', 'INVESTIGATING', 'RESOLVED', 'FALSE_POSITIVE']),
  resolution: z.string().max(1000).optional(),
});

export const anomaliesRouter = createTRPCRouter({
  /**
   * List anomalies with filters
   */
  list: protectedProcedure
    .input(anomalyFilterSchema)
    .query(async ({ input }) => {
      const where: Record<string, unknown> = {};

      if (input.anomalyType) where.anomalyType = input.anomalyType;
      if (input.severity) where.severity = input.severity;
      if (input.status) where.status = input.status;

      if (input.startDate || input.endDate) {
        where.createdAt = {
          ...(input.startDate && { gte: new Date(input.startDate) }),
          ...(input.endDate && { lte: new Date(input.endDate) }),
        };
      }

      if (input.userId) {
        where.auditEvent = {
          userId: { contains: input.userId, mode: 'insensitive' },
        };
      }

      const [anomalies, total] = await Promise.all([
        db.anomaly.findMany({
          where,
          orderBy: { createdAt: input.sortOrder },
          skip: (input.page - 1) * input.limit,
          take: input.limit,
          include: {
            auditEvent: {
              select: {
                eventId: true,
                operation: true,
                userId: true,
                userType: true,
                siteUrl: true,
                sourceFileName: true,
                creationTime: true,
                clientIp: true,
                userAgent: true,
              },
            },
          },
        }),
        db.anomaly.count({ where }),
      ]);

      return {
        anomalies,
        total,
        page: input.page,
        limit: input.limit,
        totalPages: Math.ceil(total / input.limit),
      };
    }),

  /**
   * Get single anomaly by ID
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const anomaly = await db.anomaly.findUnique({
        where: { id: input.id },
        include: {
          auditEvent: true,
          alerts: true,
        },
      });

      if (!anomaly) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Anomaly not found',
        });
      }

      return anomaly;
    }),

  /**
   * Update anomaly status
   */
  updateStatus: protectedProcedure
    .input(updateStatusSchema)
    .mutation(async ({ input }) => {
      const anomaly = await db.anomaly.update({
        where: { id: input.id },
        data: {
          status: input.status,
          ...(input.status === 'RESOLVED' && { resolvedAt: new Date() }),
        },
      });

      return anomaly;
    }),

  /**
   * Get anomaly statistics
   */
  stats: protectedProcedure.query(async () => {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [
      total,
      recentAnomalies,
      bySeverity,
      byStatus,
      byType,
    ] = await Promise.all([
      db.anomaly.count(),
      db.anomaly.count({
        where: { createdAt: { gte: oneDayAgo } },
      }),
      db.anomaly.groupBy({
        by: ['severity'],
        _count: true,
      }),
      db.anomaly.groupBy({
        by: ['status'],
        _count: true,
      }),
      db.anomaly.groupBy({
        by: ['anomalyType'],
        _count: true,
        orderBy: { _count: { anomalyType: 'desc' } },
        take: 10,
      }),
    ]);

    const unresolvedCount = await db.anomaly.count({
      where: { status: { in: ['NEW', 'INVESTIGATING'] } },
    });

    return {
      total,
      recentAnomalies,
      bySeverity: Object.fromEntries(
        bySeverity.map((s) => [s.severity, s._count])
      ),
      byStatus: Object.fromEntries(
        byStatus.map((s) => [s.status, s._count])
      ),
      byType: byType.map((t) => ({ type: t.anomalyType, count: t._count })),
      unresolvedCount,
    };
  }),
});
