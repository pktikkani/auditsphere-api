import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../init.js';
import { db } from '@/lib/db/prisma.js';
import { TRPCError } from '@trpc/server';

export const microsoftRouter = createTRPCRouter({
  /**
   * Get Microsoft connection status
   */
  status: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      return { connected: false, connections: [] };
    }

    const connections = await db.microsoftConnection.findMany({
      where: {
        userId: ctx.user.id,
        isActive: true,
      },
      select: {
        id: true,
        tenantId: true,
        tenantName: true,
        isActive: true,
        lastSyncAt: true,
        createdAt: true,
      },
    });

    return {
      connected: connections.length > 0,
      connections,
    };
  }),

  /**
   * Get SharePoint sites
   */
  sites: protectedProcedure.query(async () => {
    const sites = await db.sharePointSite.findMany({
      orderBy: { displayName: 'asc' },
      select: {
        id: true,
        graphId: true,
        displayName: true,
        webUrl: true,
        siteCollection: true,
        createdAt: true,
      },
    });

    return sites;
  }),

  /**
   * Disconnect Microsoft account
   */
  disconnect: protectedProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'User not found',
        });
      }

      // Verify connection belongs to user
      const connection = await db.microsoftConnection.findFirst({
        where: {
          id: input.connectionId,
          userId: ctx.user.id,
        },
      });

      if (!connection) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Connection not found',
        });
      }

      // Deactivate connection (soft delete)
      await db.microsoftConnection.update({
        where: { id: input.connectionId },
        data: { isActive: false },
      });

      return { success: true };
    }),

  /**
   * Get connection health
   */
  health: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      return { healthy: false, message: 'Not authenticated' };
    }

    const connection = await db.microsoftConnection.findFirst({
      where: {
        userId: ctx.user.id,
        isActive: true,
      },
    });

    if (!connection) {
      return { healthy: false, message: 'No active connection' };
    }

    // Check if token is expired
    const tokenExpired = connection.tokenExpiresAt && new Date(connection.tokenExpiresAt) < new Date();

    return {
      healthy: !tokenExpired,
      message: tokenExpired ? 'Token expired, please reconnect' : 'Connection healthy',
      lastSync: connection.lastSyncAt,
      tenantName: connection.tenantName,
    };
  }),
});
