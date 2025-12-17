/**
 * Access Review Scheduler
 *
 * Handles automatic execution of scheduled reviews:
 * - Checks for due schedules and creates campaigns
 * - Sends reminder notifications
 * - Auto-executes removals after review period ends
 */

import { db } from '../lib/db/prisma.js';
import type { Prisma } from '@prisma/client';

// Run interval in milliseconds (check every 5 minutes)
const CHECK_INTERVAL = 5 * 60 * 1000;

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

/**
 * Check for due scheduled reviews and create campaigns
 */
async function checkDueSchedules(): Promise<void> {
  const now = new Date();

  // Find enabled schedules that are due
  const dueSchedules = await db.scheduledReview.findMany({
    where: {
      enabled: true,
      nextRunAt: {
        lte: now,
      },
    },
    include: {
      createdBy: true,
    },
  });

  for (const schedule of dueSchedules) {
    try {
      console.log(`[AccessReview Scheduler] Running schedule: ${schedule.name}`);

      // Create a new campaign from the schedule
      const campaign = await db.accessReviewCampaign.create({
        data: {
          name: `${schedule.name} - ${now.toLocaleDateString()}`,
          description: `Auto-generated from schedule: ${schedule.name}`,
          scope: schedule.scope as Prisma.InputJsonValue,
          status: 'draft',
          dueDate: new Date(now.getTime() + schedule.reviewPeriodDays * 24 * 60 * 60 * 1000),
          createdById: schedule.createdById,
          scheduledReviewId: schedule.id,
          reminderDays: schedule.reminderDays[0] || 3,
          notifyAdminsOnComplete: schedule.notifyAdmins,
          adminEmails: schedule.adminEmails,
        },
      });

      // Calculate next run date
      const nextRunAt = calculateNextRun(
        schedule.frequency,
        schedule.dayOfWeek ?? undefined,
        schedule.dayOfMonth ?? undefined,
        schedule.time
      );

      // Update schedule
      await db.scheduledReview.update({
        where: { id: schedule.id },
        data: {
          lastRunAt: now,
          nextRunAt,
          lastCampaignId: campaign.id,
        },
      });

      // Create notification
      await db.accessReviewNotification.create({
        data: {
          userId: schedule.createdById,
          campaignId: campaign.id,
          type: 'schedule_triggered',
          title: 'Scheduled Review Started',
          message: `A new access review campaign "${campaign.name}" has been automatically created from your schedule "${schedule.name}".`,
        },
      });

      console.log(`[AccessReview Scheduler] Created campaign: ${campaign.id}`);
    } catch (error) {
      console.error(`[AccessReview Scheduler] Error running schedule ${schedule.id}:`, error);
    }
  }
}

/**
 * Check for campaigns due soon and send reminders
 */
async function checkReminders(): Promise<void> {
  const now = new Date();
  const reminderDays = [7, 3, 1]; // Days before due to send reminders

  for (const days of reminderDays) {
    const targetDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
    const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

    // Find campaigns due in exactly N days
    const campaigns = await db.accessReviewCampaign.findMany({
      where: {
        status: 'in_review',
        dueDate: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    });

    for (const campaign of campaigns) {
      // Check if reminder already sent today
      const existingReminder = await db.accessReviewNotification.findFirst({
        where: {
          campaignId: campaign.id,
          type: 'campaign_due_soon',
          createdAt: {
            gte: new Date(now.setHours(0, 0, 0, 0)),
          },
        },
      });

      if (!existingReminder) {
        await db.accessReviewNotification.create({
          data: {
            userId: campaign.createdById,
            campaignId: campaign.id,
            type: 'campaign_due_soon',
            title: `Review Due in ${days} Day${days > 1 ? 's' : ''}`,
            message: `Access review campaign "${campaign.name}" is due in ${days} day${days > 1 ? 's' : ''}. Please complete your reviews.`,
          },
        });
      }
    }
  }
}

/**
 * Check for overdue campaigns and handle auto-execution
 */
async function checkOverdueCampaigns(): Promise<void> {
  const now = new Date();

  // Find overdue campaigns
  const overdueCampaigns = await db.accessReviewCampaign.findMany({
    where: {
      status: 'in_review',
      dueDate: {
        lt: now,
      },
    },
    include: {
      items: {
        where: {
          decision: null,
        },
        select: { id: true },
      },
    },
  });

  for (const campaign of overdueCampaigns) {
    // Send overdue notification if not already sent
    const existingOverdueNotification = await db.accessReviewNotification.findFirst({
      where: {
        campaignId: campaign.id,
        type: 'campaign_overdue',
      },
    });

    if (!existingOverdueNotification) {
      await db.accessReviewNotification.create({
        data: {
          userId: campaign.createdById,
          campaignId: campaign.id,
          type: 'campaign_overdue',
          title: 'Access Review Overdue',
          message: `Access review campaign "${campaign.name}" is overdue. ${campaign.items.length} items still need review.`,
        },
      });
    }

    // Check if this is from a schedule with autoExecute enabled
    if (campaign.scheduledReviewId) {
      const schedule = await db.scheduledReview.findUnique({
        where: { id: campaign.scheduledReviewId },
      });

      if (schedule?.autoExecute) {
        // Auto-retain all pending items (safe default)
        console.log(`[AccessReview Scheduler] Auto-retaining pending items for campaign: ${campaign.id}`);

        for (const item of campaign.items) {
          await db.accessReviewDecision.create({
            data: {
              itemId: item.id,
              decision: 'retain',
              justification: 'Auto-retained due to review period expiration',
              decidedAt: now,
              reviewerEmail: 'system@auditsphere.app',
            },
          });
        }

        // Update campaign status
        const [retainCount, removeCount] = await Promise.all([
          db.accessReviewDecision.count({
            where: { item: { campaignId: campaign.id }, decision: 'retain' },
          }),
          db.accessReviewDecision.count({
            where: { item: { campaignId: campaign.id }, decision: 'remove' },
          }),
        ]);

        await db.accessReviewCampaign.update({
          where: { id: campaign.id },
          data: {
            status: 'completed',
            completedAt: now,
            reviewedItems: retainCount + removeCount,
            retainedItems: retainCount,
            removedItems: removeCount,
          },
        });

        // Create completion notification
        await db.accessReviewNotification.create({
          data: {
            userId: campaign.createdById,
            campaignId: campaign.id,
            type: 'execution_complete',
            title: 'Access Review Auto-Completed',
            message: `Access review campaign "${campaign.name}" has been auto-completed. Pending items were auto-retained.`,
          },
        });
      }
    }
  }
}

/**
 * Calculate next run date for a schedule
 */
function calculateNextRun(
  frequency: string,
  dayOfWeek?: number,
  dayOfMonth?: number,
  time: string = '09:00'
): Date {
  const now = new Date();
  const [hours, minutes] = time.split(':').map(Number);
  const next = new Date(now);

  next.setHours(hours, minutes, 0, 0);

  switch (frequency) {
    case 'weekly': {
      const targetDay = dayOfWeek ?? 1; // Default to Monday
      const currentDay = next.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil <= 0 || (daysUntil === 0 && next <= now)) {
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
      break;
    }

    case 'quarterly': {
      const quarterMonth = Math.floor(now.getMonth() / 3) * 3 + 3;
      next.setMonth(quarterMonth);
      next.setDate(dayOfMonth ?? 1);
      if (next <= now) {
        next.setMonth(next.getMonth() + 3);
      }
      break;
    }

    case 'yearly': {
      next.setMonth(0);
      next.setDate(dayOfMonth ?? 1);
      if (next <= now) {
        next.setFullYear(next.getFullYear() + 1);
      }
      break;
    }
  }

  return next;
}

/**
 * Main scheduler loop
 */
async function runScheduler(): Promise<void> {
  if (isRunning) {
    console.log('[AccessReview Scheduler] Already running, skipping...');
    return;
  }

  isRunning = true;
  console.log('[AccessReview Scheduler] Running checks...');

  try {
    await checkDueSchedules();
    await checkReminders();
    await checkOverdueCampaigns();
  } catch (error) {
    console.error('[AccessReview Scheduler] Error:', error);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the scheduler
 */
export function startAccessReviewScheduler(): void {
  console.log('[AccessReview Scheduler] Starting...');

  // Run immediately
  void runScheduler();

  // Then run on interval
  intervalId = setInterval(() => {
    void runScheduler();
  }, CHECK_INTERVAL);
}

/**
 * Stop the scheduler
 */
export function stopAccessReviewScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[AccessReview Scheduler] Stopped');
  }
}

export { runScheduler, checkDueSchedules, checkReminders, checkOverdueCampaigns };
