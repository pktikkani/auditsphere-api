import { z } from 'zod';
import { TokenManager } from './token-manager.js';
import {
  GraphPermission,
  GraphPermissionsResponseSchema,
  GraphDriveItem,
  GraphDriveItemsResponseSchema,
  GraphDrive,
  GraphDrivesResponseSchema,
  GraphSite,
  GraphSitesResponseSchema,
  GraphSitePermission,
  GraphSitePermissionsResponseSchema,
  parseGraphResponse,
} from './graph-schemas.js';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

// ============================================================================
// Normalized Types for Internal Use
// ============================================================================

export interface PermissionInfo {
  permissionId: string;
  permissionType: 'user' | 'group' | 'everyone' | 'anonymous' | 'shareLink';
  grantedTo: string;
  grantedToId: string | null;
  grantedToType: 'user' | 'group' | 'everyone' | 'anonymous';
  accessLevel: string;
  permissionOrigin: 'direct' | 'inherited' | 'sharingLink';
  sharingLinkType: string | null;
  expiresAt: Date | null;
}

export interface ResourcePermission {
  resourceType: 'site' | 'drive' | 'folder' | 'file';
  resourceId: string;
  resourceName: string;
  resourcePath: string;
  siteUrl: string;
  permission: PermissionInfo;
}

// Re-export Graph types for external use
export type { GraphDriveItem as DriveItem, GraphPermission as Permission };

// ============================================================================
// Permission Parsing
// ============================================================================

/**
 * Parse a Graph API permission object into our normalized format
 */
function parsePermission(perm: GraphPermission): PermissionInfo {
  let grantedTo = '';
  let grantedToId: string | null = null;
  let grantedToType: 'user' | 'group' | 'everyone' | 'anonymous' = 'user';
  let permissionType: 'user' | 'group' | 'everyone' | 'anonymous' | 'shareLink' = 'user';
  let permissionOrigin: 'direct' | 'inherited' | 'sharingLink' = 'direct';
  let sharingLinkType: string | null = null;

  // Check for sharing link
  if (perm.link) {
    permissionType = 'shareLink';
    permissionOrigin = 'sharingLink';
    sharingLinkType = perm.link.scope || null;

    if (perm.link.scope === 'anonymous') {
      grantedTo = 'Anyone with the link';
      grantedToType = 'anonymous';
    } else if (perm.link.scope === 'organization') {
      grantedTo = 'People in organization with the link';
      grantedToType = 'everyone';
    } else {
      grantedTo = 'Specific people';
      grantedToType = 'user';
    }
  }
  // Check grantedToV2 (newer format - preferred)
  else if (perm.grantedToV2) {
    if (perm.grantedToV2.user) {
      grantedTo = perm.grantedToV2.user.email || perm.grantedToV2.user.displayName || '';
      grantedToId = perm.grantedToV2.user.id || null;
      grantedToType = 'user';
      permissionType = 'user';
    } else if (perm.grantedToV2.group) {
      grantedTo = perm.grantedToV2.group.displayName || perm.grantedToV2.group.email || '';
      grantedToId = perm.grantedToV2.group.id || null;
      grantedToType = 'group';
      permissionType = 'group';
    } else if (perm.grantedToV2.siteUser) {
      grantedTo = perm.grantedToV2.siteUser.loginName || perm.grantedToV2.siteUser.displayName || '';
      grantedToId = perm.grantedToV2.siteUser.id || null;
      grantedToType = 'user';
      permissionType = 'user';
    } else if (perm.grantedToV2.siteGroup) {
      grantedTo = perm.grantedToV2.siteGroup.displayName || perm.grantedToV2.siteGroup.loginName || '';
      grantedToId = perm.grantedToV2.siteGroup.id || null;
      grantedToType = 'group';
      permissionType = 'group';
    }
  }
  // Check grantedTo (deprecated but still returned)
  else if (perm.grantedTo?.user) {
    grantedTo = perm.grantedTo.user.email || perm.grantedTo.user.displayName || '';
    grantedToId = perm.grantedTo.user.id || null;
    grantedToType = 'user';
    permissionType = 'user';
  }
  // Check grantedToIdentitiesV2 (for multiple grantees)
  else if (perm.grantedToIdentitiesV2?.length) {
    const identity = perm.grantedToIdentitiesV2[0];
    if (identity.user) {
      grantedTo = identity.user.email || identity.user.displayName || '';
      grantedToId = identity.user.id || null;
      grantedToType = 'user';
      permissionType = 'user';
    } else if (identity.group) {
      grantedTo = identity.group.displayName || identity.group.email || '';
      grantedToId = identity.group.id || null;
      grantedToType = 'group';
      permissionType = 'group';
    }
  }
  // Check grantedToIdentities (deprecated)
  else if (perm.grantedToIdentities?.length) {
    const identity = perm.grantedToIdentities[0];
    if (identity.user) {
      grantedTo = identity.user.email || identity.user.displayName || '';
      grantedToId = identity.user.id || null;
      grantedToType = 'user';
      permissionType = 'user';
    }
  }
  // Check invitation
  else if (perm.invitation) {
    grantedTo = perm.invitation.email || '';
    grantedToType = 'user';
    permissionType = 'user';
  }

  // Check if inherited
  if (perm.inheritedFrom && Object.keys(perm.inheritedFrom).length > 0) {
    permissionOrigin = 'inherited';
  }

  // Parse access level from roles
  const roles = perm.roles || [];
  let accessLevel = 'read';
  if (roles.includes('owner')) {
    accessLevel = 'owner';
  } else if (roles.includes('write') || roles.includes('sp.full control')) {
    accessLevel = 'write';
  } else if (roles.includes('read') || roles.includes('sp.view only')) {
    accessLevel = 'read';
  }

  return {
    permissionId: perm.id,
    permissionType,
    grantedTo: grantedTo || 'Unknown',
    grantedToId,
    grantedToType,
    accessLevel,
    permissionOrigin,
    sharingLinkType,
    expiresAt: perm.expirationDateTime ? new Date(perm.expirationDateTime) : null,
  };
}

/**
 * Parse site permission (different structure than drive item permissions)
 */
function parseSitePermission(perm: GraphSitePermission): PermissionInfo {
  let grantedTo = '';
  let grantedToId: string | null = null;
  let grantedToType: 'user' | 'group' | 'everyone' | 'anonymous' = 'user';
  let permissionType: 'user' | 'group' | 'everyone' | 'anonymous' | 'shareLink' = 'user';

  if (perm.grantedTo?.user) {
    grantedTo = perm.grantedTo.user.email || perm.grantedTo.user.displayName || '';
    grantedToId = perm.grantedTo.user.id || null;
    grantedToType = 'user';
    permissionType = 'user';
  } else if (perm.grantedTo?.group) {
    grantedTo = perm.grantedTo.group.displayName || '';
    grantedToId = perm.grantedTo.group.id || null;
    grantedToType = 'group';
    permissionType = 'group';
  } else if (perm.grantedTo?.application) {
    grantedTo = perm.grantedTo.application.displayName || '';
    grantedToId = perm.grantedTo.application.id || null;
  } else if (perm.grantedToIdentities?.length) {
    const identity = perm.grantedToIdentities[0];
    if (identity.user) {
      grantedTo = identity.user.email || identity.user.displayName || '';
      grantedToId = identity.user.id || null;
    } else if (identity.group) {
      grantedTo = identity.group.displayName || '';
      grantedToId = identity.group.id || null;
      grantedToType = 'group';
      permissionType = 'group';
    } else if (identity.application) {
      grantedTo = identity.application.displayName || '';
      grantedToId = identity.application.id || null;
    }
  }

  const roles = perm.roles || [];
  let accessLevel = 'read';
  if (roles.includes('owner') || roles.includes('fullcontrol')) {
    accessLevel = 'owner';
  } else if (roles.includes('write')) {
    accessLevel = 'write';
  }

  return {
    permissionId: perm.id,
    permissionType,
    grantedTo: grantedTo || 'Unknown',
    grantedToId,
    grantedToType,
    accessLevel,
    permissionOrigin: 'direct',
    sharingLinkType: null,
    expiresAt: null,
  };
}

// ============================================================================
// Permissions Client
// ============================================================================

/**
 * Permissions Client for managing SharePoint/OneDrive permissions
 */
export class PermissionsClient {
  private tokenManager: TokenManager;

  constructor(userId: string, tenantId?: string) {
    this.tokenManager = new TokenManager(userId, tenantId);
  }

  /**
   * Make a Graph API GET request with schema validation
   */
  private async request<T>(
    endpoint: string,
    schema: z.ZodType<T>,
    context: string
  ): Promise<T> {
    const accessToken = await this.tokenManager.getAppOnlyGraphToken();

    const url = endpoint.startsWith('http') ? endpoint : `${GRAPH_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Graph API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return parseGraphResponse(schema, data, context);
  }

  /**
   * Make a raw Graph API request without validation (for simple responses)
   */
  private async requestRaw<T>(endpoint: string): Promise<T> {
    const accessToken = await this.tokenManager.getAppOnlyGraphToken();

    const url = endpoint.startsWith('http') ? endpoint : `${GRAPH_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Graph API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Make a DELETE request
   */
  private async requestDelete(endpoint: string): Promise<void> {
    const accessToken = await this.tokenManager.getAppOnlyGraphToken();

    const response = await fetch(`${GRAPH_BASE_URL}${endpoint}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    // 204 No Content is success for DELETE
    if (!response.ok && response.status !== 204) {
      const error = await response.text();
      throw new Error(`Graph API DELETE error: ${response.status} - ${error}`);
    }
  }

  // ==========================================================================
  // Site Operations
  // ==========================================================================

  /**
   * Get a site by ID
   * https://learn.microsoft.com/en-us/graph/api/site-get
   */
  async getSiteById(siteId: string): Promise<GraphSite> {
    // Single site response uses the same schema structure
    const SingleSiteSchema = z.object({
      id: z.string(),
      displayName: z.string().optional(),
      name: z.string().optional(),
      webUrl: z.string().optional(),
      createdDateTime: z.string().optional(),
      lastModifiedDateTime: z.string().optional(),
      isPersonalSite: z.boolean().optional(),
      siteCollection: z.object({
        hostname: z.string().optional(),
        dataLocationCode: z.string().optional(),
        root: z.object({}).optional(),
      }).optional(),
      root: z.object({}).optional(),
    }).passthrough();

    return this.request(
      `/sites/${siteId}`,
      SingleSiteSchema,
      'getSiteById'
    );
  }

  /**
   * Get a site by its SharePoint URL
   * https://learn.microsoft.com/en-us/graph/api/site-getbypath
   */
  async getSiteByUrl(siteUrl: string): Promise<GraphSite | null> {
    try {
      const url = new URL(siteUrl);
      const hostname = url.hostname;
      const relativePath = url.pathname;
      const endpoint = `/sites/${hostname}:${relativePath}`;

      const SingleSiteSchema = z.object({
        id: z.string(),
        displayName: z.string().optional(),
        name: z.string().optional(),
        webUrl: z.string().optional(),
        createdDateTime: z.string().optional(),
        lastModifiedDateTime: z.string().optional(),
        isPersonalSite: z.boolean().optional(),
      }).passthrough();

      return await this.request(endpoint, SingleSiteSchema, 'getSiteByUrl');
    } catch (error) {
      console.error(`Failed to get site by URL ${siteUrl}:`, error);
      return null;
    }
  }

  /**
   * Get all SharePoint sites in the tenant
   * https://learn.microsoft.com/en-us/graph/api/site-list
   */
  async getAllSites(): Promise<GraphSite[]> {
    const allSites: GraphSite[] = [];
    let nextLink: string | null = '/sites?$top=100&$select=id,displayName,name,webUrl,siteCollection,isPersonalSite';

    while (nextLink) {
      const result: z.infer<typeof GraphSitesResponseSchema> = await this.request(
        nextLink,
        GraphSitesResponseSchema,
        'getAllSites'
      );
      allSites.push(...result.value);

      nextLink = result['@odata.nextLink'] || null;
    }

    return allSites;
  }

  /**
   * Get site permissions
   * https://learn.microsoft.com/en-us/graph/api/site-list-permissions
   */
  async getSitePermissions(siteId: string): Promise<GraphSitePermission[]> {
    const result = await this.request(
      `/sites/${siteId}/permissions`,
      GraphSitePermissionsResponseSchema,
      'getSitePermissions'
    );
    return result.value;
  }

  // ==========================================================================
  // Drive Operations
  // ==========================================================================

  /**
   * Get all drives (document libraries) for a site
   * https://learn.microsoft.com/en-us/graph/api/site-list-drives
   */
  async getSiteDrives(siteId: string): Promise<GraphDrive[]> {
    const result = await this.request(
      `/sites/${siteId}/drives`,
      GraphDrivesResponseSchema,
      'getSiteDrives'
    );
    return result.value;
  }

  /**
   * Get permissions on a drive's root folder
   * https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions
   */
  async getDriveRootPermissions(driveId: string): Promise<GraphPermission[]> {
    const result = await this.request(
      `/drives/${driveId}/root/permissions`,
      GraphPermissionsResponseSchema,
      'getDriveRootPermissions'
    );
    return result.value;
  }

  /**
   * Get permissions on a specific drive item
   * https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions
   */
  async getDriveItemPermissions(driveId: string, itemId: string): Promise<GraphPermission[]> {
    const result = await this.request(
      `/drives/${driveId}/items/${itemId}/permissions`,
      GraphPermissionsResponseSchema,
      'getDriveItemPermissions'
    );
    return result.value;
  }

  /**
   * List children of a drive folder
   * https://learn.microsoft.com/en-us/graph/api/driveitem-list-children
   */
  async listDriveItemChildren(
    driveId: string,
    itemId: string = 'root',
    expandPermissions: boolean = false
  ): Promise<GraphDriveItem[]> {
    const expand = expandPermissions ? '?$expand=permissions' : '';
    const result = await this.request(
      `/drives/${driveId}/items/${itemId}/children${expand}`,
      GraphDriveItemsResponseSchema,
      'listDriveItemChildren'
    );
    return result.value;
  }

  // ==========================================================================
  // Permission Collection
  // ==========================================================================

  /**
   * Find all items with unique (non-inherited) permissions
   */
  async findItemsWithUniquePermissions(
    siteId: string,
    driveId: string,
    maxDepth: number = 3
  ): Promise<ResourcePermission[]> {
    const results: ResourcePermission[] = [];
    const site = await this.getSiteById(siteId);
    const siteUrl = site.webUrl || '';

    const processItem = async (
      item: GraphDriveItem,
      depth: number,
      parentPath: string
    ): Promise<void> => {
      if (depth > maxDepth) return;

      const itemPath = `${parentPath}/${item.name}`;

      try {
        const permissions = await this.getDriveItemPermissions(driveId, item.id);

        // Filter for direct permissions (not inherited)
        const directPermissions = permissions.filter(p => {
          // Include if no inheritedFrom or inheritedFrom is empty
          if (!p.inheritedFrom || Object.keys(p.inheritedFrom).length === 0) return true;
          // Always include sharing links
          if (p.link) return true;
          return false;
        });

        for (const perm of directPermissions) {
          const permInfo = parsePermission(perm);
          results.push({
            resourceType: item.folder ? 'folder' : 'file',
            resourceId: item.id,
            resourceName: item.name,
            resourcePath: item.webUrl || itemPath,
            siteUrl,
            permission: permInfo,
          });
        }
      } catch (err) {
        console.error(`Error getting permissions for ${item.name}:`, err);
      }

      // Recursively process children if this is a folder
      if (item.folder && depth < maxDepth) {
        try {
          const children = await this.listDriveItemChildren(driveId, item.id);
          for (const child of children) {
            await processItem(child, depth + 1, itemPath);
          }
        } catch {
          // Skip if we can't access children
        }
      }
    };

    // Start from root
    const rootItems = await this.listDriveItemChildren(driveId, 'root');
    for (const item of rootItems) {
      await processItem(item, 1, '');
    }

    return results;
  }

  /**
   * Collect all permissions for a site (site-level + drive-level)
   */
  async collectSitePermissions(siteId: string): Promise<ResourcePermission[]> {
    const results: ResourcePermission[] = [];
    const site = await this.getSiteById(siteId);
    const siteUrl = site.webUrl || '';

    // Get site-level permissions
    try {
      const sitePermissions = await this.getSitePermissions(siteId);
      for (const perm of sitePermissions) {
        const permInfo = parseSitePermission(perm);
        results.push({
          resourceType: 'site',
          resourceId: siteId,
          resourceName: site.displayName || site.name || 'Site',
          resourcePath: siteUrl,
          siteUrl,
          permission: permInfo,
        });
      }
    } catch (err) {
      console.error('Error fetching site permissions:', err);
    }

    // Get drive-level permissions
    try {
      const drives = await this.getSiteDrives(siteId);
      for (const drive of drives) {
        try {
          const drivePerms = await this.getDriveRootPermissions(drive.id);
          for (const perm of drivePerms) {
            const permInfo = parsePermission(perm);
            // Only include direct permissions
            if (permInfo.permissionOrigin === 'direct') {
              results.push({
                resourceType: 'drive',
                resourceId: drive.id,
                resourceName: drive.name || 'Document Library',
                resourcePath: drive.webUrl || '',
                siteUrl,
                permission: permInfo,
              });
            }
          }
        } catch {
          // Skip if we can't access drive permissions
        }
      }
    } catch (err) {
      console.error('Error fetching drive permissions:', err);
    }

    return results;
  }

  // ==========================================================================
  // Permission Deletion
  // ==========================================================================

  /**
   * Delete a permission from a drive item
   * https://learn.microsoft.com/en-us/graph/api/permission-delete
   */
  async deleteDriveItemPermission(
    driveId: string,
    itemId: string,
    permissionId: string
  ): Promise<void> {
    await this.requestDelete(`/drives/${driveId}/items/${itemId}/permissions/${permissionId}`);
  }

  /**
   * Delete a site permission
   * https://learn.microsoft.com/en-us/graph/api/site-delete-permission
   */
  async deleteSitePermission(siteId: string, permissionId: string): Promise<void> {
    await this.requestDelete(`/sites/${siteId}/permissions/${permissionId}`);
  }
}

/**
 * Factory function to create a PermissionsClient
 */
export async function getPermissionsClient(userId: string): Promise<PermissionsClient | null> {
  try {
    return new PermissionsClient(userId);
  } catch {
    return null;
  }
}
