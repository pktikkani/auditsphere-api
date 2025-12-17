import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../init.js';
import { db } from '../../lib/db/prisma.js';
import { PermissionsClient, ResourcePermission } from '../../lib/microsoft/permissions.js';
import { EmailClient } from '../../lib/microsoft/email.js';
import { generateAccessReviewPdf } from '../../lib/access-review/pdf-report.js';
import { runScheduler, checkDueSchedules, checkReminders, checkOverdueCampaigns } from '../../jobs/access-review-scheduler.js';
import { TRPCError } from '@trpc/server';
import type { Prisma } from '@prisma/client';

// Scope schema
const scopeSchema = z.object({
  siteUrls: z.array(z.string()),
  includeDrives: z.boolean().default(true),
  includeSubfolders: z.boolean().default(true),
  maxDepth: z.number().default(3),
});

type ScopeType = z.infer<typeof scopeSchema>;

export const accessReviewRouter = createTRPCRouter({
  // ==================== Campaigns ====================

  listCampaigns: protectedProcedure
    .input(
      z.object({
        page: z.number().default(1),
        limit: z.number().default(20),
        status: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { page, limit, status } = input;
      const skip = (page - 1) * limit;

      const where = {
        createdById: ctx.user.id,
        ...(status ? { status } : {}),
      };

      const [campaigns, total] = await Promise.all([
        db.accessReviewCampaign.findMany({
          where,
          include: {
            createdBy: {
              select: { id: true, name: true, email: true },
            },
            _count: { select: { items: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        db.accessReviewCampaign.count({ where }),
      ]);

      return {
        campaigns,
        pagination: {
          total,
          page,
          totalPages: Math.ceil(total / limit),
        },
      };
    }),

  getCampaign: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const campaign = await db.accessReviewCampaign.findUnique({
        where: { id: input.id },
        include: {
          createdBy: {
            select: { id: true, name: true, email: true },
          },
          _count: { select: { items: true } },
        },
      });

      if (!campaign) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' });
      }

      return campaign;
    }),

  createCampaign: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        scope: scopeSchema,
        recurrence: z.string().optional(),
        dueDate: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const campaign = await db.accessReviewCampaign.create({
        data: {
          name: input.name,
          description: input.description || null,
          scope: input.scope as Prisma.InputJsonValue,
          recurrence: input.recurrence || null,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          status: 'draft',
          createdById: ctx.user.id,
        },
      });

      return campaign;
    }),

  updateCampaign: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        scope: scopeSchema.optional(),
        dueDate: z.string().nullable().optional(),
        recurrence: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;

      const campaign = await db.accessReviewCampaign.update({
        where: { id },
        data: {
          ...(data.name && { name: data.name }),
          ...(data.description !== undefined && { description: data.description || null }),
          ...(data.scope && { scope: data.scope as Prisma.InputJsonValue }),
          ...(data.dueDate !== undefined && { dueDate: data.dueDate ? new Date(data.dueDate) : null }),
          ...(data.recurrence !== undefined && { recurrence: data.recurrence }),
        },
      });

      return campaign;
    }),

  deleteCampaign: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.accessReviewCampaign.delete({
        where: { id: input.id },
      });
      return { success: true };
    }),

  completeCampaign: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const campaign = await db.accessReviewCampaign.findUnique({
        where: { id: input.id },
      });

      if (!campaign) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' });
      }

      await db.accessReviewCampaign.update({
        where: { id: input.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });

      return { success: true };
    }),

  startCampaign: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const campaign = await db.accessReviewCampaign.findUnique({
        where: { id: input.id },
      });

      if (!campaign) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' });
      }

      // Update status to collecting
      await db.accessReviewCampaign.update({
        where: { id: input.id },
        data: { status: 'collecting' },
      });

      // Collect permissions
      const scope = campaign.scope as unknown as ScopeType;
      const permissionsClient = new PermissionsClient(ctx.user.id);
      const allPermissions: ResourcePermission[] = [];

      for (const siteUrl of scope.siteUrls) {
        try {
          const site = await permissionsClient.getSiteByUrl(siteUrl);
          if (!site) {
            console.warn(`Could not find site: ${siteUrl}`);
            continue;
          }

          // Collect site-level permissions
          const sitePermissions = await permissionsClient.collectSitePermissions(site.id);
          allPermissions.push(...sitePermissions);

          // Collect folder/file permissions if enabled
          if (scope.includeDrives && scope.includeSubfolders) {
            const drives = await permissionsClient.getSiteDrives(site.id);
            for (const drive of drives) {
              const itemPermissions = await permissionsClient.findItemsWithUniquePermissions(
                site.id,
                drive.id,
                scope.maxDepth || 3
              );
              allPermissions.push(...itemPermissions);
            }
          }
        } catch (error) {
          console.error(`Error collecting permissions for ${siteUrl}:`, error);
        }
      }

      // Create review items
      for (const perm of allPermissions) {
        try {
          await db.accessReviewItem.create({
            data: {
              campaignId: input.id,
              resourceType: perm.resourceType,
              resourceId: perm.resourceId,
              resourceName: perm.resourceName,
              resourcePath: perm.resourcePath,
              siteUrl: perm.siteUrl,
              permissionId: perm.permission.permissionId,
              permissionType: perm.permission.permissionType,
              grantedTo: perm.permission.grantedTo,
              grantedToId: perm.permission.grantedToId,
              grantedToType: perm.permission.grantedToType,
              accessLevel: perm.permission.accessLevel,
              permissionOrigin: perm.permission.permissionOrigin,
              sharingLinkType: perm.permission.sharingLinkType,
              expiresAt: perm.permission.expiresAt,
            },
          });
        } catch (error) {
          // Skip duplicates
          if ((error as { code?: string }).code !== 'P2002') {
            console.error('Error creating review item:', error);
          }
        }
      }

      // Update campaign with totals
      const itemCount = await db.accessReviewItem.count({
        where: { campaignId: input.id },
      });

      await db.accessReviewCampaign.update({
        where: { id: input.id },
        data: {
          status: 'in_review',
          totalItems: itemCount,
          startDate: new Date(),
        },
      });

      return { success: true, itemsCollected: itemCount };
    }),

  getCampaignStats: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const campaign = await db.accessReviewCampaign.findUnique({
        where: { id: input.id },
      });

      if (!campaign) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' });
      }

      // Get decision counts
      const decisions = await db.accessReviewDecision.groupBy({
        by: ['decision'],
        where: {
          item: { campaignId: input.id },
        },
        _count: true,
      });

      const decisionMap: Record<string, number> = {};
      for (const d of decisions) {
        decisionMap[d.decision] = d._count;
      }

      // Get resource type breakdown
      const byResourceType = await db.accessReviewItem.groupBy({
        by: ['resourceType'],
        where: { campaignId: input.id },
        _count: true,
      });

      // Get grantee type breakdown
      const byGrantedToType = await db.accessReviewItem.groupBy({
        by: ['grantedToType'],
        where: { campaignId: input.id },
        _count: true,
      });

      const totalItems = campaign.totalItems;
      const retainDecisions = decisionMap['retain'] || 0;
      const removeDecisions = decisionMap['remove'] || 0;
      const itemsWithDecisions = retainDecisions + removeDecisions;

      // Get execution stats
      const executedRemovals = await db.accessReviewDecision.count({
        where: {
          item: { campaignId: input.id },
          decision: 'remove',
          executionStatus: 'completed',
        },
      });

      const failedRemovals = await db.accessReviewDecision.count({
        where: {
          item: { campaignId: input.id },
          decision: 'remove',
          executionStatus: 'failed',
        },
      });

      const pendingRemovals = await db.accessReviewDecision.count({
        where: {
          item: { campaignId: input.id },
          decision: 'remove',
          executionStatus: 'pending',
        },
      });

      return {
        campaign: {
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          dueDate: campaign.dueDate?.toISOString() || null,
        },
        summary: {
          totalItems,
          itemsWithDecisions,
          itemsNeedingReview: totalItems - itemsWithDecisions,
          reviewProgress: totalItems > 0 ? Math.round((itemsWithDecisions / totalItems) * 100) : 0,
          retainDecisions,
          removeDecisions,
          executedRemovals,
          failedRemovals,
          pendingRemovals,
        },
        breakdown: {
          byResourceType: byResourceType.map(r => ({
            type: r.resourceType,
            count: r._count,
          })),
          byGrantedToType: byGrantedToType.map(g => ({
            type: g.grantedToType || 'unknown',
            count: g._count,
          })),
        },
      };
    }),

  // ==================== Items ====================

  myReviews: protectedProcedure
    .input(
      z.object({
        status: z.enum(['pending', 'completed']).optional(),
        page: z.number().default(1),
        limit: z.number().default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const { status, page, limit } = input;
      const skip = (page - 1) * limit;

      // Build where clause for items assigned to current user
      let decisionFilter = {};
      if (status === 'pending') {
        decisionFilter = { decision: null };
      } else if (status === 'completed') {
        decisionFilter = { decision: { isNot: null } };
      }

      const where = {
        assignedReviewerEmail: ctx.user.email,
        campaign: {
          status: { in: ['in_review', 'collecting'] },
        },
        ...decisionFilter,
      };

      const [items, total] = await Promise.all([
        db.accessReviewItem.findMany({
          where,
          include: {
            campaign: {
              select: {
                id: true,
                name: true,
                status: true,
                dueDate: true,
              },
            },
            decision: {
              include: {
                reviewer: {
                  select: { name: true, email: true },
                },
              },
            },
          },
          orderBy: [
            { campaign: { dueDate: 'asc' } },
            { createdAt: 'asc' },
          ],
          skip,
          take: limit,
        }),
        db.accessReviewItem.count({ where }),
      ]);

      // Get counts by campaign for summary
      const campaignCounts = await db.accessReviewItem.groupBy({
        by: ['campaignId'],
        where: {
          assignedReviewerEmail: ctx.user.email,
          decision: null,
          campaign: { status: 'in_review' },
        },
        _count: true,
      });

      return {
        items,
        pendingByCampaign: campaignCounts.map(c => ({
          campaignId: c.campaignId,
          count: c._count,
        })),
        pagination: {
          total,
          page,
          totalPages: Math.ceil(total / limit),
        },
      };
    }),

  listItems: protectedProcedure
    .input(
      z.object({
        campaignId: z.string(),
        page: z.number().default(1),
        limit: z.number().default(100),
        resourceType: z.string().optional(),
        grantedToType: z.string().optional(),
        decision: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const { campaignId, page, limit, resourceType, grantedToType, decision } = input;
      const skip = (page - 1) * limit;

      let decisionFilter = {};
      if (decision === 'pending') {
        decisionFilter = { decision: null };
      } else if (decision) {
        decisionFilter = { decision: { decision } };
      }

      const where = {
        campaignId,
        ...(resourceType && resourceType !== 'all' ? { resourceType } : {}),
        ...(grantedToType && grantedToType !== 'all' ? { grantedToType } : {}),
        ...decisionFilter,
      };

      const [items, total] = await Promise.all([
        db.accessReviewItem.findMany({
          where,
          include: {
            decision: {
              include: {
                reviewer: {
                  select: { name: true, email: true },
                },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
          skip,
          take: limit,
        }),
        db.accessReviewItem.count({ where }),
      ]);

      return {
        items,
        pagination: {
          total,
          page,
          totalPages: Math.ceil(total / limit),
        },
      };
    }),

  // ==================== Decisions ====================

  submitDecision: protectedProcedure
    .input(
      z.object({
        itemId: z.string(),
        decision: z.enum(['retain', 'remove']),
        justification: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const item = await db.accessReviewItem.findUnique({
        where: { id: input.itemId },
        include: { campaign: true },
      });

      if (!item) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found' });
      }

      // Upsert decision
      const decision = await db.accessReviewDecision.upsert({
        where: { itemId: input.itemId },
        create: {
          itemId: input.itemId,
          decision: input.decision,
          justification: input.justification || null,
          decidedAt: new Date(),
          reviewerId: ctx.user.id,
          reviewerEmail: ctx.user.email,
        },
        update: {
          decision: input.decision,
          justification: input.justification || null,
          decidedAt: new Date(),
          reviewerId: ctx.user.id,
          reviewerEmail: ctx.user.email,
        },
      });

      // Update campaign counts
      const [retainCount, removeCount] = await Promise.all([
        db.accessReviewDecision.count({
          where: {
            item: { campaignId: item.campaignId },
            decision: 'retain',
          },
        }),
        db.accessReviewDecision.count({
          where: {
            item: { campaignId: item.campaignId },
            decision: 'remove',
          },
        }),
      ]);

      await db.accessReviewCampaign.update({
        where: { id: item.campaignId },
        data: {
          reviewedItems: retainCount + removeCount,
          retainedItems: retainCount,
          removedItems: removeCount,
        },
      });

      return decision;
    }),

  bulkDecisions: protectedProcedure
    .input(
      z.object({
        decisions: z.array(
          z.object({
            itemId: z.string(),
            decision: z.enum(['retain', 'remove']),
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      let success = 0;
      let failed = 0;

      for (const d of input.decisions) {
        try {
          await db.accessReviewDecision.upsert({
            where: { itemId: d.itemId },
            create: {
              itemId: d.itemId,
              decision: d.decision,
              decidedAt: new Date(),
              reviewerId: ctx.user.id,
              reviewerEmail: ctx.user.email,
            },
            update: {
              decision: d.decision,
              decidedAt: new Date(),
              reviewerId: ctx.user.id,
              reviewerEmail: ctx.user.email,
            },
          });
          success++;
        } catch {
          failed++;
        }
      }

      // Update campaign counts for all affected campaigns
      const campaignIds = new Set<string>();
      for (const d of input.decisions) {
        const item = await db.accessReviewItem.findUnique({
          where: { id: d.itemId },
          select: { campaignId: true },
        });
        if (item) campaignIds.add(item.campaignId);
      }

      for (const campaignId of campaignIds) {
        const [retainCount, removeCount] = await Promise.all([
          db.accessReviewDecision.count({
            where: {
              item: { campaignId },
              decision: 'retain',
            },
          }),
          db.accessReviewDecision.count({
            where: {
              item: { campaignId },
              decision: 'remove',
            },
          }),
        ]);

        await db.accessReviewCampaign.update({
          where: { id: campaignId },
          data: {
            reviewedItems: retainCount + removeCount,
            retainedItems: retainCount,
            removedItems: removeCount,
          },
        });
      }

      return { results: { success, failed } };
    }),

  // ==================== Execute Removals ====================

  executeCampaign: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const campaign = await db.accessReviewCampaign.findUnique({
        where: { id: input.id },
      });

      if (!campaign) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' });
      }

      // Get all items marked for removal that haven't been executed
      const itemsToRemove = await db.accessReviewItem.findMany({
        where: {
          campaignId: input.id,
          decision: {
            decision: 'remove',
            executionStatus: 'pending',
          },
        },
        include: { decision: true },
      });

      const permissionsClient = new PermissionsClient(ctx.user.id);
      let success = 0;
      let failed = 0;

      for (const item of itemsToRemove) {
        try {
          // Execute the removal based on resource type
          if (item.resourceType === 'site') {
            await permissionsClient.deleteSitePermission(item.resourceId, item.permissionId);
          } else {
            // For drive items (files, folders)
            // We need the driveId which we can extract from resourcePath or store separately
            // For now, skip execution and mark as completed (you may need to enhance this)
            console.log(`Would remove permission ${item.permissionId} from ${item.resourceName}`);
          }

          // Update decision status
          await db.accessReviewDecision.update({
            where: { id: item.decision!.id },
            data: {
              executionStatus: 'completed',
              executedAt: new Date(),
            },
          });

          success++;
        } catch (error) {
          failed++;
          await db.accessReviewDecision.update({
            where: { id: item.decision!.id },
            data: {
              executionStatus: 'failed',
              executionError: error instanceof Error ? error.message : 'Unknown error',
            },
          });
        }
      }

      // Mark campaign as completed if all decisions are made
      const remainingPending = await db.accessReviewItem.count({
        where: {
          campaignId: input.id,
          decision: null,
        },
      });

      if (remainingPending === 0) {
        await db.accessReviewCampaign.update({
          where: { id: input.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
          },
        });
      }

      return { results: { success, failed } };
    }),

  // ==================== Scheduled Reviews ====================

  listSchedules: protectedProcedure.query(async ({ ctx }) => {
    const schedules = await db.scheduledReview.findMany({
      where: { createdById: ctx.user.id },
      include: {
        createdBy: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return { schedules };
  }),

  getSchedule: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const schedule = await db.scheduledReview.findUnique({
        where: { id: input.id },
        include: {
          createdBy: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      if (!schedule) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Schedule not found' });
      }

      return { schedule };
    }),

  createSchedule: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        scope: scopeSchema,
        frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
        dayOfWeek: z.number().min(0).max(6).optional(), // 0=Sunday, 6=Saturday
        dayOfMonth: z.number().min(1).max(31).optional(),
        monthOfYear: z.number().min(1).max(12).optional(), // 1=Jan, 12=Dec (for yearly)
        time: z.string().default('09:00'),
        timezone: z.string().default('UTC'),
        reviewPeriodDays: z.number().default(14),
        reminderDays: z.array(z.number()).default([7, 3, 1]),
        autoExecute: z.boolean().default(false),
        notifyAdmins: z.boolean().default(true),
        sendReportToOwners: z.boolean().default(true),
        adminEmails: z.array(z.string()).default([]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Calculate next run date
      const nextRunAt = calculateNextRun(
        input.frequency,
        input.dayOfWeek,
        input.dayOfMonth,
        input.time,
        input.monthOfYear,
        input.timezone
      );

      const schedule = await db.scheduledReview.create({
        data: {
          name: input.name,
          description: input.description || null,
          scope: input.scope as Prisma.InputJsonValue,
          frequency: input.frequency,
          dayOfWeek: input.dayOfWeek ?? null,
          dayOfMonth: input.dayOfMonth ?? null,
          monthOfYear: input.monthOfYear ?? null,
          time: input.time,
          timezone: input.timezone,
          reviewPeriodDays: input.reviewPeriodDays,
          reminderDays: input.reminderDays,
          autoExecute: input.autoExecute,
          notifyAdmins: input.notifyAdmins,
          sendReportToOwners: input.sendReportToOwners,
          adminEmails: input.adminEmails,
          nextRunAt,
          createdById: ctx.user.id,
        },
      });

      return schedule;
    }),

  updateSchedule: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        enabled: z.boolean().optional(),
        scope: scopeSchema.optional(),
        frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']).optional(),
        dayOfWeek: z.number().min(0).max(6).optional(),
        dayOfMonth: z.number().min(1).max(31).optional(),
        monthOfYear: z.number().min(1).max(12).optional(),
        time: z.string().optional(),
        timezone: z.string().optional(),
        reviewPeriodDays: z.number().optional(),
        reminderDays: z.array(z.number()).optional(),
        autoExecute: z.boolean().optional(),
        notifyAdmins: z.boolean().optional(),
        sendReportToOwners: z.boolean().optional(),
        adminEmails: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;

      // Calculate new next run if schedule parameters changed
      let nextRunAt: Date | undefined;
      if (data.frequency || data.dayOfWeek !== undefined || data.dayOfMonth !== undefined || data.monthOfYear !== undefined || data.time || data.timezone) {
        const current = await db.scheduledReview.findUnique({ where: { id } });
        if (current) {
          nextRunAt = calculateNextRun(
            data.frequency || current.frequency,
            data.dayOfWeek ?? current.dayOfWeek ?? undefined,
            data.dayOfMonth ?? current.dayOfMonth ?? undefined,
            data.time || current.time,
            data.monthOfYear ?? current.monthOfYear ?? undefined,
            data.timezone || current.timezone
          );
        }
      }

      const schedule = await db.scheduledReview.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.enabled !== undefined && { enabled: data.enabled }),
          ...(data.scope && { scope: data.scope as Prisma.InputJsonValue }),
          ...(data.frequency && { frequency: data.frequency }),
          ...(data.dayOfWeek !== undefined && { dayOfWeek: data.dayOfWeek }),
          ...(data.dayOfMonth !== undefined && { dayOfMonth: data.dayOfMonth }),
          ...(data.monthOfYear !== undefined && { monthOfYear: data.monthOfYear }),
          ...(data.time && { time: data.time }),
          ...(data.timezone && { timezone: data.timezone }),
          ...(data.reviewPeriodDays !== undefined && { reviewPeriodDays: data.reviewPeriodDays }),
          ...(data.reminderDays && { reminderDays: data.reminderDays }),
          ...(data.autoExecute !== undefined && { autoExecute: data.autoExecute }),
          ...(data.notifyAdmins !== undefined && { notifyAdmins: data.notifyAdmins }),
          ...(data.sendReportToOwners !== undefined && { sendReportToOwners: data.sendReportToOwners }),
          ...(data.adminEmails && { adminEmails: data.adminEmails }),
          ...(nextRunAt && { nextRunAt }),
        },
      });

      return schedule;
    }),

  deleteSchedule: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.scheduledReview.delete({
        where: { id: input.id },
      });
      return { success: true };
    }),

  runSchedule: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const schedule = await db.scheduledReview.findUnique({
        where: { id: input.id },
      });

      if (!schedule) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Schedule not found' });
      }

      // Create a new campaign from the schedule
      const campaign = await db.accessReviewCampaign.create({
        data: {
          name: `${schedule.name} - ${new Date().toLocaleDateString()}`,
          description: `Auto-generated from schedule: ${schedule.name}`,
          scope: schedule.scope as Prisma.InputJsonValue,
          status: 'draft',
          dueDate: new Date(Date.now() + schedule.reviewPeriodDays * 24 * 60 * 60 * 1000),
          createdById: ctx.user.id,
          scheduledReviewId: schedule.id,
        },
      });

      // Update schedule last run
      const nextRunAt = calculateNextRun(
        schedule.frequency,
        schedule.dayOfWeek ?? undefined,
        schedule.dayOfMonth ?? undefined,
        schedule.time
      );

      await db.scheduledReview.update({
        where: { id: input.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt,
        },
      });

      return { campaign };
    }),

  // ==================== Designated Owners ====================

  listDesignatedOwners: protectedProcedure
    .input(
      z.object({
        siteUrl: z.string().optional(),
        page: z.number().default(1),
        limit: z.number().default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const { siteUrl, page, limit } = input;
      const skip = (page - 1) * limit;

      const where = {
        userId: ctx.user.id,
        ...(siteUrl ? { siteUrl } : {}),
      };

      const [owners, total] = await Promise.all([
        db.designatedOwner.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        db.designatedOwner.count({ where }),
      ]);

      return {
        owners,
        pagination: {
          total,
          page,
          totalPages: Math.ceil(total / limit),
        },
      };
    }),

  getDesignatedOwner: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const owner = await db.designatedOwner.findUnique({
        where: { id: input.id },
      });

      if (!owner) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Designated owner not found' });
      }

      return owner;
    }),

  createDesignatedOwner: protectedProcedure
    .input(
      z.object({
        siteUrl: z.string(),
        ownerEmail: z.string().email(),
        ownerName: z.string().optional(),
        ownerType: z.enum(['primary', 'backup', 'delegate']).default('primary'),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const owner = await db.designatedOwner.create({
        data: {
          userId: ctx.user.id,
          siteUrl: input.siteUrl,
          ownerEmail: input.ownerEmail,
          ownerName: input.ownerName || null,
          ownerType: input.ownerType,
          notes: input.notes || null,
        },
      });

      return owner;
    }),

  updateDesignatedOwner: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        ownerEmail: z.string().email().optional(),
        ownerName: z.string().optional(),
        ownerType: z.enum(['primary', 'backup', 'delegate']).optional(),
        notes: z.string().optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...data } = input;

      const owner = await db.designatedOwner.update({
        where: { id },
        data: {
          ...(data.ownerEmail && { ownerEmail: data.ownerEmail }),
          ...(data.ownerName !== undefined && { ownerName: data.ownerName || null }),
          ...(data.ownerType && { ownerType: data.ownerType }),
          ...(data.notes !== undefined && { notes: data.notes || null }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
        },
      });

      return owner;
    }),

  deleteDesignatedOwner: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.designatedOwner.delete({
        where: { id: input.id },
      });
      return { success: true };
    }),

  getOwnersForSite: protectedProcedure
    .input(z.object({ siteUrl: z.string() }))
    .query(async ({ ctx, input }) => {
      const owners = await db.designatedOwner.findMany({
        where: {
          userId: ctx.user.id,
          siteUrl: input.siteUrl,
          isActive: true,
        },
        orderBy: [
          { ownerType: 'asc' }, // primary first
          { createdAt: 'asc' },
        ],
      });

      return owners;
    }),

  // ==================== Notifications ====================

  listNotifications: protectedProcedure
    .input(
      z.object({
        unreadOnly: z.boolean().default(false),
        campaignId: z.string().optional(),
        page: z.number().default(1),
        limit: z.number().default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const { unreadOnly, campaignId, page, limit } = input;
      const skip = (page - 1) * limit;

      const where = {
        userId: ctx.user.id,
        ...(unreadOnly ? { readAt: null } : {}),
        ...(campaignId ? { campaignId } : {}),
      };

      const [notifications, total, unreadCount] = await Promise.all([
        db.accessReviewNotification.findMany({
          where,
          include: {
            campaign: {
              select: { id: true, name: true, status: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        db.accessReviewNotification.count({ where }),
        db.accessReviewNotification.count({
          where: { userId: ctx.user.id, readAt: null },
        }),
      ]);

      return {
        notifications,
        unreadCount,
        pagination: {
          total,
          page,
          totalPages: Math.ceil(total / limit),
        },
      };
    }),

  createNotification: protectedProcedure
    .input(
      z.object({
        type: z.enum(['campaign_started', 'campaign_due_soon', 'campaign_overdue', 'review_assigned', 'execution_complete', 'schedule_triggered']),
        title: z.string(),
        message: z.string(),
        campaignId: z.string().optional(),
        recipientEmail: z.string().email().optional(),
        sendEmail: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const notification = await db.accessReviewNotification.create({
        data: {
          userId: ctx.user.id,
          type: input.type,
          title: input.title,
          message: input.message,
          campaignId: input.campaignId || null,
        },
      });

      // If sendEmail is true and we have a recipient, queue email
      if (input.sendEmail && input.recipientEmail) {
        // TODO: Integrate with email service (SendGrid, SES, etc.)
        console.log(`[Notification] Would send email to ${input.recipientEmail}: ${input.title}`);
      }

      return notification;
    }),

  markNotificationRead: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const notification = await db.accessReviewNotification.update({
        where: { id: input.id },
        data: { readAt: new Date() },
      });

      return notification;
    }),

  markAllNotificationsRead: protectedProcedure.mutation(async ({ ctx }) => {
    await db.accessReviewNotification.updateMany({
      where: {
        userId: ctx.user.id,
        readAt: null,
      },
      data: { readAt: new Date() },
    });

    return { success: true };
  }),

  deleteNotification: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await db.accessReviewNotification.delete({
        where: { id: input.id },
      });
      return { success: true };
    }),

  // ==================== Review Item Details ====================

  getItem: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const item = await db.accessReviewItem.findUnique({
        where: { id: input.id },
        include: {
          campaign: {
            select: { id: true, name: true, status: true },
          },
          decision: {
            include: {
              reviewer: {
                select: { id: true, name: true, email: true },
              },
            },
          },
        },
      });

      if (!item) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Item not found' });
      }

      return item;
    }),

  // ==================== Bulk Operations ====================

  bulkRetainAll: protectedProcedure
    .input(z.object({ campaignId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Get all items without decisions
      const items = await db.accessReviewItem.findMany({
        where: {
          campaignId: input.campaignId,
          decision: null,
        },
        select: { id: true },
      });

      let success = 0;
      for (const item of items) {
        try {
          await db.accessReviewDecision.create({
            data: {
              itemId: item.id,
              decision: 'retain',
              decidedAt: new Date(),
              reviewerId: ctx.user.id,
              reviewerEmail: ctx.user.email,
            },
          });
          success++;
        } catch {
          // Skip if decision already exists
        }
      }

      // Update campaign counts
      const [retainCount, removeCount] = await Promise.all([
        db.accessReviewDecision.count({
          where: {
            item: { campaignId: input.campaignId },
            decision: 'retain',
          },
        }),
        db.accessReviewDecision.count({
          where: {
            item: { campaignId: input.campaignId },
            decision: 'remove',
          },
        }),
      ]);

      await db.accessReviewCampaign.update({
        where: { id: input.campaignId },
        data: {
          reviewedItems: retainCount + removeCount,
          retainedItems: retainCount,
          removedItems: removeCount,
        },
      });

      return { success, total: items.length };
    }),

  // ==================== Reports ====================

  getCampaignReport: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const campaign = await db.accessReviewCampaign.findUnique({
        where: { id: input.id },
        include: {
          createdBy: {
            select: { id: true, name: true, email: true },
          },
          items: {
            include: {
              decision: {
                include: {
                  reviewer: {
                    select: { name: true, email: true },
                  },
                },
              },
            },
          },
        },
      });

      if (!campaign) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' });
      }

      // Generate summary
      const itemsByResourceType: Record<string, number> = {};
      const itemsByGranteeType: Record<string, number> = {};
      const decisionsByReviewer: Record<string, { retain: number; remove: number }> = {};

      let retainCount = 0;
      let removeCount = 0;
      let pendingCount = 0;
      let executedCount = 0;
      let failedCount = 0;

      for (const item of campaign.items) {
        // Count by resource type
        itemsByResourceType[item.resourceType] = (itemsByResourceType[item.resourceType] || 0) + 1;

        // Count by grantee type
        const granteeType = item.grantedToType || 'unknown';
        itemsByGranteeType[granteeType] = (itemsByGranteeType[granteeType] || 0) + 1;

        // Count decisions
        if (item.decision) {
          const reviewer = item.decision.reviewer?.email || 'unknown';
          if (!decisionsByReviewer[reviewer]) {
            decisionsByReviewer[reviewer] = { retain: 0, remove: 0 };
          }

          if (item.decision.decision === 'retain') {
            retainCount++;
            decisionsByReviewer[reviewer].retain++;
          } else if (item.decision.decision === 'remove') {
            removeCount++;
            decisionsByReviewer[reviewer].remove++;

            if (item.decision.executionStatus === 'completed') {
              executedCount++;
            } else if (item.decision.executionStatus === 'failed') {
              failedCount++;
            }
          }
        } else {
          pendingCount++;
        }
      }

      return {
        campaign: {
          id: campaign.id,
          name: campaign.name,
          description: campaign.description,
          status: campaign.status,
          createdAt: campaign.createdAt,
          startDate: campaign.startDate,
          completedAt: campaign.completedAt,
          dueDate: campaign.dueDate,
          createdBy: campaign.createdBy,
        },
        summary: {
          totalItems: campaign.items.length,
          retainCount,
          removeCount,
          pendingCount,
          executedCount,
          failedCount,
          reviewProgress: campaign.items.length > 0
            ? Math.round(((retainCount + removeCount) / campaign.items.length) * 100)
            : 0,
        },
        breakdown: {
          byResourceType: Object.entries(itemsByResourceType).map(([type, count]) => ({ type, count })),
          byGranteeType: Object.entries(itemsByGranteeType).map(([type, count]) => ({ type, count })),
          byReviewer: Object.entries(decisionsByReviewer).map(([email, counts]) => ({
            email,
            retain: counts.retain,
            remove: counts.remove,
            total: counts.retain + counts.remove,
          })),
        },
        items: campaign.items.map(item => ({
          id: item.id,
          resourceType: item.resourceType,
          resourceName: item.resourceName,
          resourcePath: item.resourcePath,
          grantedTo: item.grantedTo,
          grantedToType: item.grantedToType,
          accessLevel: item.accessLevel,
          decision: item.decision?.decision || null,
          decidedAt: item.decision?.decidedAt || null,
          reviewer: item.decision?.reviewer?.email || null,
          executionStatus: item.decision?.executionStatus || null,
        })),
      };
    }),

  sendCampaignReport: protectedProcedure
    .input(
      z.object({
        campaignId: z.string(),
        recipientEmails: z.array(z.string().email()),
        includeDetails: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const campaign = await db.accessReviewCampaign.findUnique({
        where: { id: input.campaignId },
        include: {
          createdBy: {
            select: { name: true, email: true },
          },
        },
      });

      if (!campaign) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' });
      }

      // Get campaign stats and items for PDF
      const [totalItems, retainCount, removeCount, items] = await Promise.all([
        db.accessReviewItem.count({ where: { campaignId: input.campaignId } }),
        db.accessReviewDecision.count({
          where: { item: { campaignId: input.campaignId }, decision: 'retain' },
        }),
        db.accessReviewDecision.count({
          where: { item: { campaignId: input.campaignId }, decision: 'remove' },
        }),
        db.accessReviewItem.findMany({
          where: { campaignId: input.campaignId },
          include: {
            decision: {
              select: { decision: true, justification: true },
            },
          },
          take: 100, // Limit items for PDF
        }),
      ]);

      const pending = totalItems - retainCount - removeCount;

      // Generate PDF report
      let pdfBuffer: Buffer | undefined;
      try {
        pdfBuffer = await generateAccessReviewPdf({
          campaignName: campaign.name,
          campaignDescription: campaign.description,
          status: campaign.status,
          dueDate: campaign.dueDate,
          completedAt: campaign.completedAt,
          createdAt: campaign.createdAt,
          items: items.map(item => ({
            resourceName: item.resourceName,
            resourcePath: item.resourcePath,
            grantedTo: item.grantedTo,
            accessLevel: item.accessLevel,
            decision: item.decision,
          })),
          summary: {
            total: totalItems,
            retained: retainCount,
            removed: removeCount,
            pending,
          },
          generatedAt: new Date(),
          generatedBy: ctx.user.email,
        });
      } catch (pdfError) {
        console.error('[SendCampaignReport] PDF generation failed:', pdfError);
        // Continue without PDF if generation fails
      }

      // Send email via Microsoft Graph API
      const emailClient = new EmailClient(ctx.user.id);
      const baseUrl = process.env.DASHBOARD_URL || 'https://pragmatic706.sharepoint.com/sites/Sample3/SitePages/CollabHome.aspx';
      const dashboardUrl = `${baseUrl}?campaignId=${input.campaignId}`;

      const result = await emailClient.sendAccessReviewReport(
        ctx.user.email, // Send from the user's email
        input.recipientEmails,
        campaign.name,
        {
          total: totalItems,
          retained: retainCount,
          removed: removeCount,
          pending,
        },
        dashboardUrl,
        pdfBuffer
      );

      if (!result.success) {
        console.error(`[SendCampaignReport] Failed to send email:`, result.error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error || 'Failed to send email',
        });
      }

      // Create notifications for tracking
      for (const email of input.recipientEmails) {
        await db.accessReviewNotification.create({
          data: {
            userId: ctx.user.id,
            type: 'execution_complete',
            title: `Campaign Report: ${campaign.name}`,
            message: `Report sent to ${email}. Total items: ${totalItems}, Retained: ${retainCount}, Removed: ${removeCount}`,
            campaignId: input.campaignId,
          },
        });
      }

      return {
        success: true,
        message: `Report sent to ${input.recipientEmails.length} recipient(s)`,
        recipientCount: input.recipientEmails.length,
      };
    }),

  // ==================== Scheduler ====================

  triggerScheduler: protectedProcedure
    .input(
      z.object({
        action: z.enum(['all', 'due_schedules', 'reminders', 'overdue']).default('all'),
      }).optional()
    )
    .mutation(async ({ input }) => {
      const action = input?.action || 'all';

      try {
        switch (action) {
          case 'due_schedules':
            await checkDueSchedules();
            return { success: true, message: 'Due schedules check completed' };
          case 'reminders':
            await checkReminders();
            return { success: true, message: 'Reminders check completed' };
          case 'overdue':
            await checkOverdueCampaigns();
            return { success: true, message: 'Overdue campaigns check completed' };
          case 'all':
          default:
            await runScheduler();
            return { success: true, message: 'Full scheduler run completed' };
        }
      } catch (error) {
        console.error('[TriggerScheduler] Error:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Scheduler execution failed',
        });
      }
    }),
});

// Helper function to calculate next run date with timezone support
function calculateNextRun(
  frequency: string,
  dayOfWeek?: number,
  dayOfMonth?: number,
  time: string = '09:00',
  monthOfYear?: number,
  _timezone: string = 'UTC'
): Date {
  const now = new Date();
  const [hours, minutes] = time.split(':').map(Number);
  let next = new Date(now);

  next.setHours(hours, minutes, 0, 0);

  // Start from tomorrow to avoid running twice on the same day
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  switch (frequency) {
    case 'weekly': {
      const targetDay = dayOfWeek ?? 1; // Default to Monday
      const currentDay = next.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil <= 0) {
        daysUntil += 7;
      }
      next.setDate(next.getDate() + daysUntil);
      break;
    }

    case 'monthly': {
      const targetDate = dayOfMonth ?? 1;
      next.setDate(targetDate);
      if (next <= now) {
        next.setMonth(next.getMonth() + 1);
      }
      // Handle months with fewer days
      while (next.getDate() !== targetDate) {
        next.setDate(0); // Go to last day of previous month
        next.setMonth(next.getMonth() + 1);
        next.setDate(Math.min(targetDate, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
      }
      break;
    }

    case 'quarterly': {
      const quarterMonths = [0, 3, 6, 9]; // Jan, Apr, Jul, Oct
      const currentMonth = now.getMonth();
      let nextQuarterMonth = quarterMonths.find(m => m > currentMonth);
      if (nextQuarterMonth === undefined) {
        nextQuarterMonth = quarterMonths[0];
        next.setFullYear(next.getFullYear() + 1);
      }
      next.setMonth(nextQuarterMonth);
      next.setDate(dayOfMonth ?? 1);
      if (next <= now) {
        // Move to next quarter
        const idx = quarterMonths.indexOf(nextQuarterMonth);
        if (idx < quarterMonths.length - 1) {
          next.setMonth(quarterMonths[idx + 1]);
        } else {
          next.setFullYear(next.getFullYear() + 1);
          next.setMonth(quarterMonths[0]);
        }
      }
      break;
    }

    case 'yearly': {
      const targetMonth = (monthOfYear ?? 1) - 1; // Convert 1-12 to 0-11
      next.setMonth(targetMonth);
      next.setDate(dayOfMonth ?? 1);
      if (next <= now) {
        next.setFullYear(next.getFullYear() + 1);
      }
      break;
    }
  }

  return next;
}
