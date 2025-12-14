import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../init.js';
import { db } from '../../lib/db/prisma.js';
import { TRPCError } from '@trpc/server';

const runComplianceSchema = z.object({
  standardId: z.enum(['CIS-MS365', 'CUSTOM', 'ALL']).optional(),
  siteUrls: z.array(z.string().url()).optional(),
});

export const complianceRouter = createTRPCRouter({
  /**
   * Run compliance checks
   * Note: Actual compliance checking logic should be implemented separately
   */
  run: protectedProcedure
    .input(runComplianceSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'User not found',
        });
      }

      // Create a compliance run record
      const run = await db.complianceRun.create({
        data: {
          standardId: input.standardId || 'CIS-MS365',
          triggeredBy: 'manual',
          status: 'running',
        },
      });

      // Note: Actual compliance checks would be run here
      // For now, return the run ID for tracking
      return {
        success: true,
        runId: run.id,
        message: 'Compliance run started',
      };
    }),

  /**
   * Get compliance summary
   */
  summary: protectedProcedure.query(async () => {
    const latestRun = await db.complianceRun.findFirst({
      orderBy: { startedAt: 'desc' },
      where: { status: 'completed' },
    });

    if (!latestRun) {
      return {
        total: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        lastRunAt: null,
      };
    }

    return {
      total: latestRun.totalChecks,
      passed: latestRun.passedChecks,
      failed: latestRun.failedChecks,
      passRate: latestRun.totalChecks > 0
        ? Math.round((latestRun.passedChecks / latestRun.totalChecks) * 100)
        : 0,
      lastRunAt: latestRun.startedAt,
    };
  }),

  /**
   * List compliance runs
   */
  runs: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(50).default(10)
    }))
    .query(async ({ input }) => {
      const runs = await db.complianceRun.findMany({
        orderBy: { startedAt: 'desc' },
        take: input.limit,
        select: {
          id: true,
          standardId: true,
          status: true,
          startedAt: true,
          completedAt: true,
          totalChecks: true,
          passedChecks: true,
          failedChecks: true,
          errorChecks: true,
        },
      });

      return runs;
    }),

  /**
   * Get single compliance run details
   */
  runById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const run = await db.complianceRun.findUnique({
        where: { id: input.id },
      });

      if (!run) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Compliance run not found',
        });
      }

      // Get checks for this run
      const checks = await db.complianceCheck.findMany({
        where: {
          createdAt: {
            gte: run.startedAt,
            lte: run.completedAt || new Date(),
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return {
        run,
        checks,
      };
    }),

  /**
   * Get compliance check definitions
   */
  checkDefinitions: protectedProcedure.query(async () => {
    // Return static check definitions
    return [
      {
        code: 'EXT-001',
        name: 'External Sharing Disabled',
        description: 'Verify external sharing is disabled for sensitive sites',
        category: 'Sharing',
        severity: 'HIGH' as const,
        standardId: 'CIS-MS365',
      },
      {
        code: 'EXT-002',
        name: 'Anonymous Links Disabled',
        description: 'Verify anonymous sharing links are disabled',
        category: 'Sharing',
        severity: 'HIGH' as const,
        standardId: 'CIS-MS365',
      },
      {
        code: 'ACC-001',
        name: 'Guest Access Review',
        description: 'Review guest user access to sites',
        category: 'Access',
        severity: 'MEDIUM' as const,
        standardId: 'CIS-MS365',
      },
    ];
  }),

  /**
   * Get latest checks results
   */
  latestChecks: protectedProcedure
    .input(z.object({
      page: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(100).default(50),
      status: z.enum(['PASS', 'FAIL', 'WARNING', 'ERROR', 'SKIPPED']).optional(),
      category: z.string().optional(),
      severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    }))
    .query(async ({ input }) => {
      const where: Record<string, unknown> = {};

      if (input.status) where.status = input.status;
      if (input.category) where.category = input.category;
      if (input.severity) where.severity = input.severity;

      const [checks, total] = await Promise.all([
        db.complianceCheck.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (input.page - 1) * input.limit,
          take: input.limit,
        }),
        db.complianceCheck.count({ where }),
      ]);

      return {
        checks,
        total,
        page: input.page,
        limit: input.limit,
        totalPages: Math.ceil(total / input.limit),
      };
    }),

  /**
   * Clear compliance results
   */
  clear: protectedProcedure.mutation(async () => {
    await db.$transaction([
      db.complianceCheck.deleteMany(),
      db.complianceRun.deleteMany(),
    ]);

    return { success: true };
  }),
});
