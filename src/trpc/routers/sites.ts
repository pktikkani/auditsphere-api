import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../init.js';
import { db } from '@/lib/db/prisma.js';
import type { Prisma } from '@prisma/client';

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
});
