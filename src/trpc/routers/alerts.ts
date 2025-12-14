import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../init.js';
import { db } from '../../lib/db/prisma.js';
import { TRPCError } from '@trpc/server';

const alertFilterSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  type: z.enum(['ANOMALY', 'COMPLIANCE', 'SECURITY']).optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  status: z.enum(['NEW', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const updateAlertSchema = z.object({
  id: z.string(),
  status: z.enum(['NEW', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']),
});

export const alertsRouter = createTRPCRouter({
  /**
   * List alerts with filters
   */
  list: protectedProcedure
    .input(alertFilterSchema)
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = {};

      // Filter by user's alerts
      if (ctx.user) {
        where.userId = ctx.user.id;
      }

      if (input.type) where.type = input.type;
      if (input.severity) where.severity = input.severity;
      if (input.status) where.status = input.status;

      if (input.startDate || input.endDate) {
        where.createdAt = {
          ...(input.startDate && { gte: new Date(input.startDate) }),
          ...(input.endDate && { lte: new Date(input.endDate) }),
        };
      }

      const [alerts, total] = await Promise.all([
        db.alert.findMany({
          where,
          orderBy: { createdAt: input.sortOrder },
          skip: (input.page - 1) * input.limit,
          take: input.limit,
          include: {
            anomaly: {
              select: {
                id: true,
                anomalyType: true,
                severity: true,
                anomalyScore: true,
              },
            },
          },
        }),
        db.alert.count({ where }),
      ]);

      return {
        alerts,
        total,
        page: input.page,
        limit: input.limit,
        totalPages: Math.ceil(total / input.limit),
      };
    }),

  /**
   * Get single alert by ID
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const alert = await db.alert.findFirst({
        where: {
          id: input.id,
          ...(ctx.user && { userId: ctx.user.id }),
        },
        include: {
          anomaly: {
            include: {
              auditEvent: true,
            },
          },
        },
      });

      if (!alert) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Alert not found',
        });
      }

      return alert;
    }),

  /**
   * Update alert status
   */
  updateStatus: protectedProcedure
    .input(updateAlertSchema)
    .mutation(async ({ ctx, input }) => {
      // Verify alert belongs to user
      const existing = await db.alert.findFirst({
        where: {
          id: input.id,
          ...(ctx.user && { userId: ctx.user.id }),
        },
      });

      if (!existing) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Alert not found',
        });
      }

      const alert = await db.alert.update({
        where: { id: input.id },
        data: { status: input.status },
      });

      return alert;
    }),

  /**
   * Get alert statistics
   */
  stats: protectedProcedure.query(async ({ ctx }) => {
    const where = ctx.user ? { userId: ctx.user.id } : {};

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [total, recentAlerts, bySeverity, byStatus, byType] = await Promise.all([
      db.alert.count({ where }),
      db.alert.count({
        where: { ...where, createdAt: { gte: oneDayAgo } },
      }),
      db.alert.groupBy({
        by: ['severity'],
        where,
        _count: true,
      }),
      db.alert.groupBy({
        by: ['status'],
        where,
        _count: true,
      }),
      db.alert.groupBy({
        by: ['type'],
        where,
        _count: true,
      }),
    ]);

    const unreadCount = await db.alert.count({
      where: { ...where, status: 'NEW' },
    });

    return {
      total,
      recentAlerts,
      unreadCount,
      bySeverity: Object.fromEntries(
        bySeverity.map((s) => [s.severity, s._count])
      ),
      byStatus: Object.fromEntries(
        byStatus.map((s) => [s.status, s._count])
      ),
      byType: Object.fromEntries(
        byType.map((t) => [t.type, t._count])
      ),
    };
  }),

  /**
   * Mark all alerts as read
   */
  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'User not found',
      });
    }

    await db.alert.updateMany({
      where: {
        userId: ctx.user.id,
        status: 'NEW',
      },
      data: { status: 'ACKNOWLEDGED' },
    });

    return { success: true };
  }),
});
