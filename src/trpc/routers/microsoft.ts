import { z } from 'zod';
import { createTRPCRouter, protectedProcedure, publicProcedure } from '../init.js';
import { db } from '../../lib/db/prisma.js';
import { TRPCError } from '@trpc/server';
import { PermissionsClient } from '../../lib/microsoft/permissions.js';
import { getAppCredentials } from '../../lib/microsoft/token-manager.js';

export const microsoftRouter = createTRPCRouter({
  /**
   * Check if API can connect to Microsoft using Client Credentials (env vars)
   * This is for SPFx apps that use the API's app-only authentication
   */
  checkConnection: publicProcedure.query(async () => {
    try {
      const credentials = await getAppCredentials();

      // Try to get a token using Client Credentials flow
      const tokenEndpoint = `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`;

      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          grant_type: 'client_credentials',
          scope: 'https://graph.microsoft.com/.default',
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Microsoft connection check failed:', error);
        return {
          connected: false,
          message: 'Failed to authenticate with Microsoft',
          tenantId: credentials.tenantId,
          tenantName: null,
        };
      }

      // Try to get tenant info
      const tokenData = await response.json() as { access_token: string };
      let tenantName: string | null = null;

      try {
        const orgResponse = await fetch('https://graph.microsoft.com/v1.0/organization', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
          },
        });
        if (orgResponse.ok) {
          const orgData = await orgResponse.json() as { value?: Array<{ displayName?: string }> };
          tenantName = orgData.value?.[0]?.displayName || null;
        }
      } catch {
        // Ignore errors getting tenant name
      }

      return {
        connected: true,
        message: 'Connected to Microsoft 365',
        tenantId: credentials.tenantId,
        tenantName,
      };
    } catch (error) {
      console.error('Microsoft connection check error:', error);
      return {
        connected: false,
        message: error instanceof Error ? error.message : 'Microsoft credentials not configured',
        tenantId: null,
        tenantName: null,
      };
    }
  }),

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
   * Get SharePoint sites from Microsoft Graph
   */
  sites: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'User not found',
      });
    }

    try {
      const permissionsClient = new PermissionsClient(ctx.user.id);
      const sites = await permissionsClient.getAllSites();

      return sites.map(site => ({
        id: site.id,
        graphId: site.id,
        displayName: site.displayName,
        name: site.name,
        webUrl: site.webUrl,
        siteCollection: site.siteCollection?.hostname || null,
      }));
    } catch (error) {
      console.error('Error fetching sites:', error);
      return [];
    }
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

  /**
   * Get drives (document libraries) for a site
   */
  drives: protectedProcedure
    .input(z.object({ siteId: z.string() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'User not found' });
      }

      try {
        const permissionsClient = new PermissionsClient(ctx.user.id);
        const drives = await permissionsClient.getSiteDrives(input.siteId);

        return drives.map(drive => ({
          id: drive.id,
          name: drive.name,
          webUrl: drive.webUrl,
          driveType: drive.driveType,
        }));
      } catch (error) {
        console.error('Error fetching drives:', error);
        return [];
      }
    }),

  /**
   * Get folder contents (children)
   */
  folderContents: protectedProcedure
    .input(z.object({
      driveId: z.string(),
      folderId: z.string().default('root'),
    }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'User not found' });
      }

      try {
        const permissionsClient = new PermissionsClient(ctx.user.id);
        const items = await permissionsClient.listDriveItemChildren(input.driveId, input.folderId);

        return items.map(item => ({
          id: item.id,
          name: item.name,
          webUrl: item.webUrl,
          isFolder: !!item.folder,
          childCount: item.folder?.childCount || 0,
          mimeType: item.file?.mimeType || null,
        }));
      } catch (error) {
        console.error('Error fetching folder contents:', error);
        return [];
      }
    }),

  /**
   * Get site details by ID
   */
  site: protectedProcedure
    .input(z.object({ siteId: z.string() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'User not found' });
      }

      try {
        const permissionsClient = new PermissionsClient(ctx.user.id);
        const site = await permissionsClient.getSiteById(input.siteId);

        return {
          id: site.id,
          displayName: site.displayName,
          webUrl: site.webUrl,
        };
      } catch (error) {
        console.error('Error fetching site:', error);
        return null;
      }
    }),
});
