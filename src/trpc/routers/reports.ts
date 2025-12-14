import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../init.js';
import { db } from '../../lib/db/prisma.js';
import { TRPCError } from '@trpc/server';
import type { Prisma } from '@prisma/client';

const generateReportSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['access_audit', 'compliance', 'anomaly', 'sharing', 'external_access']),
  format: z.enum(['pdf', 'xlsx', 'csv']).default('csv'),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Generate CSV report data based on type with optional date filtering
 */
async function generateReportData(
  userId: string,
  type: string,
  startDate?: Date,
  endDate?: Date
): Promise<string> {
  let csvData = '';

  // Build date filter for queries
  const dateFilter = (startDate || endDate) ? {
    creationTime: {
      ...(startDate && { gte: startDate }),
      ...(endDate && { lte: endDate }),
    },
  } : {};

  switch (type) {
    case 'access_audit': {
      const user = await db.user.findUnique({
        where: { id: userId },
        include: { microsoftConnections: { where: { status: 'active' }, take: 1 } },
      });
      const tenantId = user?.microsoftConnections?.[0]?.tenantId;

      const events = await db.auditEvent.findMany({
        where: {
          ...(tenantId ? { tenantId } : {}),
          ...dateFilter,
        },
        orderBy: { creationTime: 'desc' },
        take: 1000,
      });

      csvData = 'Event ID,Operation,User,Site URL,File Name,Client IP,Time\n';
      for (const event of events) {
        csvData += `"${event.eventId}","${event.operation}","${event.userKey || event.userId || ''}","${event.siteUrl || ''}","${event.sourceFileName || ''}","${event.clientIp || ''}","${event.creationTime.toISOString()}"\n`;
      }
      break;
    }

    case 'compliance': {
      const latestRun = await db.complianceRun.findFirst({
        orderBy: { startedAt: 'desc' },
        where: (startDate || endDate) ? {
          startedAt: {
            ...(startDate && { gte: startDate }),
            ...(endDate && { lte: endDate }),
          },
        } : undefined,
      });

      if (latestRun && latestRun.results) {
        const results = latestRun.results as Array<{
          checkCode: string;
          status: string;
          details?: string;
          remediation?: string;
        }>;

        const checkDefs = await db.complianceCheck.findMany();
        const checkMap = new Map(checkDefs.map(c => [c.checkCode, c]));

        csvData = 'Check Code,Name,Category,Status,Severity,Details,Remediation\n';
        for (const result of results) {
          const def = checkMap.get(result.checkCode);
          csvData += `"${result.checkCode}","${def?.name || result.checkCode}","${def?.category || ''}","${result.status}","${def?.severity || ''}","${(result.details || '').replace(/"/g, '""')}","${(result.remediation || '').replace(/"/g, '""')}"\n`;
        }
      } else {
        csvData = 'No compliance data available. Run a compliance scan first.\n';
      }
      break;
    }

    case 'anomaly': {
      const anomalyDateFilter = (startDate || endDate) ? {
        createdAt: {
          ...(startDate && { gte: startDate }),
          ...(endDate && { lte: endDate }),
        },
      } : {};

      const anomalies = await db.anomaly.findMany({
        where: anomalyDateFilter,
        orderBy: { createdAt: 'desc' },
        take: 500,
        include: { auditEvent: true },
      });

      csvData = 'ID,Score,Type,Confidence,Status,Event Operation,Event User,Event Time,Created At\n';
      for (const anomaly of anomalies) {
        csvData += `"${anomaly.id}","${anomaly.anomalyScore}","${anomaly.anomalyType || ''}","${anomaly.confidence}","${anomaly.status}","${anomaly.auditEvent?.operation || ''}","${anomaly.auditEvent?.userKey || anomaly.auditEvent?.userId || ''}","${anomaly.auditEvent?.creationTime?.toISOString() || ''}","${anomaly.createdAt.toISOString()}"\n`;
      }
      break;
    }

    case 'sharing': {
      const sharingOps = ['SharingSet', 'SharingInvitationCreated', 'AnonymousLinkCreated', 'SecureLinkCreated', 'CompanySharingEnabled'];
      const sharingEvents = await db.auditEvent.findMany({
        where: {
          operation: { in: sharingOps },
          ...dateFilter,
        },
        orderBy: { creationTime: 'desc' },
        take: 500,
      });

      csvData = 'Event ID,Operation,User,Site URL,File Name,Time\n';
      for (const event of sharingEvents) {
        csvData += `"${event.eventId}","${event.operation}","${event.userKey || event.userId || ''}","${event.siteUrl || ''}","${event.sourceFileName || ''}","${event.creationTime.toISOString()}"\n`;
      }
      break;
    }

    case 'external_access': {
      const externalEvents = await db.auditEvent.findMany({
        where: {
          OR: [
            { userType: 1 },
            { userKey: { contains: '#EXT#' } },
          ],
          ...dateFilter,
        },
        orderBy: { creationTime: 'desc' },
        take: 500,
      });

      csvData = 'Event ID,Operation,External User,Site URL,File Name,Client IP,Time\n';
      for (const event of externalEvents) {
        csvData += `"${event.eventId}","${event.operation}","${event.userKey || event.userId || ''}","${event.siteUrl || ''}","${event.sourceFileName || ''}","${event.clientIp || ''}","${event.creationTime.toISOString()}"\n`;
      }
      break;
    }

    default:
      csvData = 'Unknown report type\n';
  }

  return csvData;
}

const listReportsSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(50).default(20),
  type: z.enum(['access_audit', 'compliance', 'anomaly', 'sharing', 'external_access']).optional(),
  status: z.enum(['PENDING', 'GENERATING', 'COMPLETED', 'FAILED']).optional(),
});

export const reportsRouter = createTRPCRouter({
  /**
   * List reports
   */
  list: protectedProcedure
    .input(listReportsSchema)
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = {};

      if (ctx.user) {
        where.userId = ctx.user.id;
      }
      if (input.type) where.type = input.type;
      if (input.status) where.status = input.status;

      const [reports, total] = await Promise.all([
        db.report.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (input.page - 1) * input.limit,
          take: input.limit,
        }),
        db.report.count({ where }),
      ]);

      return {
        reports,
        total,
        page: input.page,
        limit: input.limit,
        totalPages: Math.ceil(total / input.limit),
      };
    }),

  /**
   * Get single report by ID
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const report = await db.report.findFirst({
        where: {
          id: input.id,
          ...(ctx.user && { userId: ctx.user.id }),
        },
      });

      if (!report) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Report not found',
        });
      }

      return report;
    }),

  /**
   * Generate a new report
   */
  generate: protectedProcedure
    .input(generateReportSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'User not found',
        });
      }

      // Create report record with generating status
      const report = await db.report.create({
        data: {
          name: input.name,
          type: input.type,
          format: 'csv',
          status: 'generating',
          parameters: (input.parameters || {}) as Prisma.JsonObject,
          userId: ctx.user.id,
        },
      });

      // Generate report data synchronously
      try {
        // Extract date parameters
        const params = input.parameters as { startDate?: string; endDate?: string } | undefined;
        const startDate = params?.startDate ? new Date(params.startDate) : undefined;
        // Set endDate to end of day (23:59:59.999)
        let endDate: Date | undefined;
        if (params?.endDate) {
          endDate = new Date(params.endDate);
          endDate.setHours(23, 59, 59, 999);
        }

        const csvData = await generateReportData(ctx.user.id, input.type, startDate, endDate);

        // Store as base64 in fileUrl
        const base64Data = Buffer.from(csvData).toString('base64');

        const updatedReport = await db.report.update({
          where: { id: report.id },
          data: {
            status: 'completed',
            generatedAt: new Date(),
            fileSize: csvData.length,
            fileUrl: base64Data,
          },
        });

        return updatedReport;
      } catch (err) {
        console.error('Report generation failed:', err);
        await db.report.update({
          where: { id: report.id },
          data: {
            status: 'failed',
            errorMessage: err instanceof Error ? err.message : 'Unknown error',
          },
        });

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to generate report',
        });
      }
    }),

  /**
   * Delete a report
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify report belongs to user
      const existing = await db.report.findFirst({
        where: {
          id: input.id,
          ...(ctx.user && { userId: ctx.user.id }),
        },
      });

      if (!existing) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Report not found',
        });
      }

      await db.report.delete({
        where: { id: input.id },
      });

      return { success: true };
    }),

  /**
   * Get report types
   */
  types: protectedProcedure.query(async () => {
    return [
      {
        id: 'access_audit',
        name: 'Access Audit Report',
        description: 'Comprehensive report of file and resource access activities',
      },
      {
        id: 'compliance',
        name: 'Compliance Report',
        description: 'Summary of compliance check results and findings',
      },
      {
        id: 'anomaly',
        name: 'Anomaly Report',
        description: 'Detected anomalies and security incidents',
      },
      {
        id: 'sharing',
        name: 'Sharing Report',
        description: 'File and folder sharing activities and permissions',
      },
      {
        id: 'external_access',
        name: 'External Access Report',
        description: 'External user and guest access activities',
      },
    ];
  }),
});
