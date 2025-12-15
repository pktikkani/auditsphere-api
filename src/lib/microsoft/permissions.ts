import { TokenManager } from './token-manager.js';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

// Types for permission data
export interface DriveItem {
  id: string;
  name: string;
  webUrl: string;
  folder?: { childCount: number };
  file?: { mimeType: string };
  parentReference?: {
    driveId: string;
    path: string;
  };
  permissions?: Permission[];
}

export interface Permission {
  id: string;
  roles: string[];
  shareId?: string;
  expirationDateTime?: string;
  hasPassword?: boolean;
  grantedToV2?: {
    user?: { displayName: string; email: string; id: string };
    group?: { displayName: string; email: string; id: string };
    siteUser?: { displayName: string; email: string; loginName: string };
  };
  grantedTo?: {
    user?: { displayName: string; email: string; id: string };
  };
  grantedToIdentitiesV2?: Array<{
    user?: { displayName: string; email: string; id: string };
    group?: { displayName: string; email: string; id: string };
  }>;
  link?: {
    type: string; // view, edit, embed
    scope: string; // anonymous, organization, users
    webUrl: string;
    preventsDownload?: boolean;
  };
  invitation?: {
    email: string;
    invitedBy?: { user: { displayName: string; email: string } };
  };
  inheritedFrom?: {
    id: string;
    path: string;
  };
}

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

/**
 * Parse a Graph API permission object into our normalized format
 */
function parsePermission(perm: Permission): PermissionInfo {
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
    sharingLinkType = perm.link.scope;

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
  // Check grantedToV2 (newer format)
  else if (perm.grantedToV2) {
    if (perm.grantedToV2.user) {
      grantedTo = perm.grantedToV2.user.email || perm.grantedToV2.user.displayName;
      grantedToId = perm.grantedToV2.user.id;
      grantedToType = 'user';
      permissionType = 'user';
    } else if (perm.grantedToV2.group) {
      grantedTo = perm.grantedToV2.group.displayName || perm.grantedToV2.group.email;
      grantedToId = perm.grantedToV2.group.id;
      grantedToType = 'group';
      permissionType = 'group';
    } else if (perm.grantedToV2.siteUser) {
      grantedTo = perm.grantedToV2.siteUser.email || perm.grantedToV2.siteUser.displayName;
      grantedToType = 'user';
      permissionType = 'user';
    }
  }
  // Check grantedTo (older format)
  else if (perm.grantedTo?.user) {
    grantedTo = perm.grantedTo.user.email || perm.grantedTo.user.displayName;
    grantedToId = perm.grantedTo.user.id;
    grantedToType = 'user';
    permissionType = 'user';
  }
  // Check grantedToIdentitiesV2 (for multiple grantees)
  else if (perm.grantedToIdentitiesV2?.length) {
    const identity = perm.grantedToIdentitiesV2[0];
    if (identity.user) {
      grantedTo = identity.user.email || identity.user.displayName;
      grantedToId = identity.user.id;
      grantedToType = 'user';
      permissionType = 'user';
    } else if (identity.group) {
      grantedTo = identity.group.displayName || identity.group.email;
      grantedToId = identity.group.id;
      grantedToType = 'group';
      permissionType = 'group';
    }
  }
  // Check invitation
  else if (perm.invitation) {
    grantedTo = perm.invitation.email;
    grantedToType = 'user';
    permissionType = 'user';
  }

  // Check if inherited
  if (perm.inheritedFrom) {
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
 * Permissions Client for managing SharePoint/OneDrive permissions
 */
export class PermissionsClient {
  private tokenManager: TokenManager;

  constructor(userId: string, tenantId?: string) {
    this.tokenManager = new TokenManager(userId, tenantId);
  }

  /**
   * Make a Graph API request using app-only token
   */
  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const accessToken = await this.tokenManager.getAppOnlyGraphToken();

    const url = endpoint.startsWith('http') ? endpoint : `${GRAPH_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
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

    if (!response.ok && response.status !== 204) {
      const error = await response.text();
      throw new Error(`Graph API DELETE error: ${response.status} - ${error}`);
    }
  }

  /**
   * Get a site by ID
   */
  async getSiteById(siteId: string): Promise<{
    id: string;
    displayName: string;
    webUrl: string;
  }> {
    return this.request(`/sites/${siteId}`);
  }

  /**
   * Get a site by its SharePoint URL
   */
  async getSiteByUrl(siteUrl: string): Promise<{
    id: string;
    displayName: string;
    webUrl: string;
  } | null> {
    try {
      const url = new URL(siteUrl);
      const hostname = url.hostname;
      const relativePath = url.pathname;
      const endpoint = `/sites/${hostname}:${relativePath}`;
      return await this.request(endpoint);
    } catch (error) {
      console.error(`Failed to get site by URL ${siteUrl}:`, error);
      return null;
    }
  }

  /**
   * Get all SharePoint sites in the tenant
   */
  async getAllSites(): Promise<Array<{
    id: string;
    displayName: string;
    name: string;
    webUrl: string;
    siteCollection?: { hostname: string };
  }>> {
    type SiteResult = {
      value: Array<{
        id: string;
        displayName: string;
        name: string;
        webUrl: string;
        siteCollection?: { hostname: string };
      }>;
      '@odata.nextLink'?: string;
    };

    const allSites: SiteResult['value'] = [];
    let nextLink: string | null = '/sites?$top=100&$select=id,displayName,name,webUrl,siteCollection';

    while (nextLink) {
      const result: SiteResult = await this.request(nextLink);
      allSites.push(...result.value);

      if (result['@odata.nextLink']) {
        nextLink = result['@odata.nextLink'];
      } else {
        nextLink = null;
      }
    }

    return allSites;
  }

  /**
   * Get site permissions
   */
  async getSitePermissions(siteId: string): Promise<{
    value: Array<{
      id: string;
      roles: string[];
      grantedTo?: {
        user?: { displayName: string; email: string };
        group?: { displayName: string };
        application?: { displayName: string };
      };
      grantedToIdentities?: Array<{
        user?: { displayName: string; email: string };
      }>;
    }>;
  }> {
    return this.request(`/sites/${siteId}/permissions`);
  }

  /**
   * Get all drives (document libraries) for a site
   */
  async getSiteDrives(siteId: string): Promise<Array<{
    id: string;
    name: string;
    webUrl: string;
    driveType: string;
  }>> {
    const result = await this.request<{
      value: Array<{
        id: string;
        name: string;
        webUrl: string;
        driveType: string;
      }>;
    }>(`/sites/${siteId}/drives`);
    return result.value;
  }

  /**
   * Get permissions on a drive's root folder
   */
  async getDriveRootPermissions(driveId: string): Promise<Permission[]> {
    const result = await this.request<{ value: Permission[] }>(
      `/drives/${driveId}/root/permissions`
    );
    return result.value;
  }

  /**
   * Get permissions on a specific drive item
   */
  async getDriveItemPermissions(driveId: string, itemId: string): Promise<Permission[]> {
    const result = await this.request<{ value: Permission[] }>(
      `/drives/${driveId}/items/${itemId}/permissions`
    );
    return result.value;
  }

  /**
   * List children of a drive folder
   */
  async listDriveItemChildren(
    driveId: string,
    itemId: string = 'root',
    expandPermissions: boolean = false
  ): Promise<DriveItem[]> {
    const expand = expandPermissions ? '?$expand=permissions' : '';
    const result = await this.request<{ value: DriveItem[] }>(
      `/drives/${driveId}/items/${itemId}/children${expand}`
    );
    return result.value;
  }

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
    const siteUrl = site.webUrl;

    const processItem = async (
      item: DriveItem,
      depth: number,
      parentPath: string
    ): Promise<void> => {
      if (depth > maxDepth) return;

      const itemPath = `${parentPath}/${item.name}`;

      try {
        const permissions = await this.getDriveItemPermissions(driveId, item.id);

        // Filter for direct permissions
        const directPermissions = permissions.filter(p => {
          if (!p.inheritedFrom || Object.keys(p.inheritedFrom).length === 0) return true;
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

    const rootItems = await this.listDriveItemChildren(driveId, 'root');
    for (const item of rootItems) {
      await processItem(item, 1, '');
    }

    return results;
  }

  /**
   * Collect all permissions for a site
   */
  async collectSitePermissions(siteId: string): Promise<ResourcePermission[]> {
    const results: ResourcePermission[] = [];
    const site = await this.getSiteById(siteId);
    const siteUrl = site.webUrl;

    // Get site-level permissions
    try {
      const sitePermissions = await this.getSitePermissions(siteId);
      for (const perm of sitePermissions.value) {
        let grantedTo = '';
        let grantedToType: 'user' | 'group' | 'everyone' | 'anonymous' = 'user';

        if (perm.grantedTo?.user) {
          grantedTo = perm.grantedTo.user.email || perm.grantedTo.user.displayName;
        } else if (perm.grantedTo?.group) {
          grantedTo = perm.grantedTo.group.displayName;
          grantedToType = 'group';
        } else if (perm.grantedTo?.application) {
          grantedTo = perm.grantedTo.application.displayName;
        } else if (perm.grantedToIdentities?.length) {
          const identity = perm.grantedToIdentities[0];
          grantedTo = identity.user?.email || identity.user?.displayName || 'Unknown';
        }

        results.push({
          resourceType: 'site',
          resourceId: siteId,
          resourceName: site.displayName,
          resourcePath: siteUrl,
          siteUrl,
          permission: {
            permissionId: perm.id,
            permissionType: grantedToType === 'group' ? 'group' : 'user',
            grantedTo,
            grantedToId: null,
            grantedToType,
            accessLevel: perm.roles.includes('owner') ? 'owner' : perm.roles.includes('write') ? 'write' : 'read',
            permissionOrigin: 'direct',
            sharingLinkType: null,
            expiresAt: null,
          },
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
            if (permInfo.permissionOrigin === 'direct') {
              results.push({
                resourceType: 'drive',
                resourceId: drive.id,
                resourceName: drive.name,
                resourcePath: drive.webUrl,
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

  /**
   * Delete a permission from a drive item
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
   */
  async deleteSitePermission(siteId: string, permissionId: string): Promise<void> {
    await this.requestDelete(`/sites/${siteId}/permissions/${permissionId}`);
  }
}

export async function getPermissionsClient(userId: string): Promise<PermissionsClient | null> {
  try {
    return new PermissionsClient(userId);
  } catch {
    return null;
  }
}
