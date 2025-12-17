import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../init.js';
import { db } from '@/lib/db/prisma.js';
import type { Prisma } from '@prisma/client';
import { getAppCredentials } from '@/lib/microsoft/token-manager.js';

export const sitesRouter = createTRPCRouter({
  /**
   * List SharePoint sites with pagination and search
   */
  list: protectedProcedure
    .input(
      z.object({
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(20),
        search: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const { page, limit, search } = input;

      const where: Prisma.SharePointSiteWhereInput = search
        ? {
            OR: [
              { webUrl: { contains: search, mode: 'insensitive' } },
              { displayName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {};

      const [sites, total] = await Promise.all([
        db.sharePointSite.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        db.sharePointSite.count({ where }),
      ]);

      // Transform to match frontend expectations
      const transformedSites = sites.map((site) => ({
        id: site.id,
        siteId: site.graphId,
        siteUrl: site.webUrl,
        title: site.displayName,
        description: site.siteCollection,
        isExternal: site.externalSharingEnabled || false,
        lastActivityAt: site.updatedAt,
        createdAt: site.createdAt,
      }));

      return {
        sites: transformedSites,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    }),

  /**
   * Get a single site by ID
   */
  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const site = await db.sharePointSite.findUnique({
        where: { id: input.id },
      });

      if (!site) {
        return null;
      }

      return {
        id: site.id,
        siteId: site.graphId,
        siteUrl: site.webUrl,
        title: site.displayName,
        description: site.siteCollection,
        isExternal: site.externalSharingEnabled || false,
        lastActivityAt: site.updatedAt,
        createdAt: site.createdAt,
      };
    }),

  /**
   * Get site statistics
   */
  stats: protectedProcedure.query(async () => {
    const [total, externalCount, recentlyActive] = await Promise.all([
      db.sharePointSite.count(),
      db.sharePointSite.count({ where: { externalSharingEnabled: true } }),
      db.sharePointSite.count({
        where: {
          updatedAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
          },
        },
      }),
    ]);

    return {
      total,
      externalCount,
      recentlyActive,
    };
  }),

  /**
   * Sync SharePoint sites from Microsoft Graph using app credentials
   */
  sync: protectedProcedure.mutation(async () => {
    console.log('[Sites Sync] Starting sync...');

    try {
      // Get app credentials
      const credentials = await getAppCredentials();

      // Get app-only token
      const tokenEndpoint = `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`;

      const tokenResponse = await fetch(tokenEndpoint, {
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

      if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        console.error('[Sites Sync] Failed to get token:', error);
        throw new Error('Failed to authenticate with Microsoft');
      }

      const tokenData = (await tokenResponse.json()) as { access_token: string };
      const accessToken = tokenData.access_token;

      // Fetch all sites from Microsoft Graph
      let allSites: Array<{
        id: string;
        displayName: string;
        name: string;
        webUrl: string;
        siteCollection?: { hostname: string };
      }> = [];
      let nextLink: string | null = 'https://graph.microsoft.com/v1.0/sites?$top=100';

      while (nextLink) {
        const sitesResponse = await fetch(nextLink, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!sitesResponse.ok) {
          const error = await sitesResponse.text();
          console.error('[Sites Sync] Failed to fetch sites:', error);
          throw new Error('Failed to fetch sites from Microsoft Graph');
        }

        const sitesData = (await sitesResponse.json()) as {
          value: typeof allSites;
          '@odata.nextLink'?: string;
        };

        allSites = allSites.concat(sitesData.value);
        nextLink = sitesData['@odata.nextLink'] || null;
      }

      console.log(`[Sites Sync] Fetched ${allSites.length} sites from Graph`);

      // Upsert sites into database
      let created = 0;
      let updated = 0;

      for (const site of allSites) {
        // Extract display name with fallbacks
        const displayName = site.displayName || site.name || extractSiteNameFromUrl(site.webUrl) || 'Unnamed Site';

        const existing = await db.sharePointSite.findUnique({
          where: { graphId: site.id },
        });

        if (existing) {
          await db.sharePointSite.update({
            where: { graphId: site.id },
            data: {
              displayName,
              webUrl: site.webUrl,
              siteCollection: site.siteCollection?.hostname || null,
              updatedAt: new Date(),
            },
          });
          updated++;
        } else {
          await db.sharePointSite.create({
            data: {
              graphId: site.id,
              displayName,
              webUrl: site.webUrl,
              siteCollection: site.siteCollection?.hostname || null,
            },
          });
          created++;
        }
      }

      console.log(`[Sites Sync] Completed: ${created} created, ${updated} updated`);

      return {
        success: true,
        message: `Synced ${allSites.length} sites (${created} new, ${updated} updated)`,
        total: allSites.length,
        created,
        updated,
      };
    } catch (error) {
      console.error('[Sites Sync] Failed:', error);
      throw error;
    }
  }),
});

/**
 * Extract site name from URL as fallback when displayName is missing
 */
function extractSiteNameFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);

    // Try to get the last meaningful part of the path
    // e.g., /sites/MySite -> MySite, /teams/MyTeam -> MyTeam
    if (pathParts.length >= 2) {
      return pathParts[pathParts.length - 1];
    }

    // If just root, use hostname
    if (pathParts.length === 0 || (pathParts.length === 1 && pathParts[0] === 'search')) {
      return urlObj.hostname.split('.')[0];
    }

    return pathParts[0] || null;
  } catch {
    return null;
  }
}
