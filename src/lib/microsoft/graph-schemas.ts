/**
 * Microsoft Graph API Zod Schemas
 *
 * These schemas validate responses from Microsoft Graph API endpoints.
 * Based on official Microsoft Graph v1.0 documentation:
 * https://learn.microsoft.com/en-us/graph/api/resources/
 *
 * Note: Some fields like 'email' on identity are not officially documented
 * but are commonly returned by the API in practice.
 */

import { z } from 'zod';

// ============================================================================
// Base Identity Types
// https://learn.microsoft.com/en-us/graph/api/resources/identity
// ============================================================================

/**
 * Identity resource - represents a user, device, or application
 * Note: email is not in official docs but commonly returned
 */
export const GraphIdentitySchema = z.object({
  id: z.string().optional(),
  displayName: z.string().optional(),
  email: z.string().optional(), // Not officially documented but commonly present
  tenantId: z.string().optional(),
}).passthrough(); // Allow additional properties

export type GraphIdentity = z.infer<typeof GraphIdentitySchema>;

/**
 * SharePoint Identity - extends Identity with SharePoint-specific properties
 * https://learn.microsoft.com/en-us/graph/api/resources/sharepointidentity
 */
export const GraphSharePointIdentitySchema = GraphIdentitySchema.extend({
  loginName: z.string().optional(),
});

export type GraphSharePointIdentity = z.infer<typeof GraphSharePointIdentitySchema>;

/**
 * Identity Set - collection of identities for an actor
 * https://learn.microsoft.com/en-us/graph/api/resources/identityset
 */
export const GraphIdentitySetSchema = z.object({
  application: GraphIdentitySchema.optional(),
  applicationInstance: GraphIdentitySchema.optional(),
  conversation: GraphIdentitySchema.optional(),
  conversationIdentityType: GraphIdentitySchema.optional(),
  device: GraphIdentitySchema.optional(),
  encrypted: GraphIdentitySchema.optional(),
  onPremises: GraphIdentitySchema.optional(),
  guest: GraphIdentitySchema.optional(),
  phone: GraphIdentitySchema.optional(),
  user: GraphIdentitySchema.optional(),
}).passthrough();

export type GraphIdentitySet = z.infer<typeof GraphIdentitySetSchema>;

/**
 * SharePoint Identity Set - extends IdentitySet for SharePoint
 * https://learn.microsoft.com/en-us/graph/api/resources/sharepointidentityset
 */
export const GraphSharePointIdentitySetSchema = GraphIdentitySetSchema.extend({
  group: GraphIdentitySchema.optional(),
  siteUser: GraphSharePointIdentitySchema.optional(),
  siteGroup: GraphSharePointIdentitySchema.optional(),
});

export type GraphSharePointIdentitySet = z.infer<typeof GraphSharePointIdentitySetSchema>;

// ============================================================================
// Sharing Types
// ============================================================================

/**
 * Sharing Link - details about sharing links
 * https://learn.microsoft.com/en-us/graph/api/resources/sharinglink
 */
export const GraphSharingLinkSchema = z.object({
  application: GraphIdentitySchema.optional(),
  type: z.enum(['view', 'edit', 'embed']).optional(),
  scope: z.enum(['anonymous', 'organization', 'existingAccess', 'users']).optional(),
  webUrl: z.string().optional(),
  webHtml: z.string().optional(),
  preventsDownload: z.boolean().optional(),
}).passthrough();

export type GraphSharingLink = z.infer<typeof GraphSharingLinkSchema>;

/**
 * Sharing Invitation - invitation details for shared items
 * https://learn.microsoft.com/en-us/graph/api/resources/sharinginvitation
 */
export const GraphSharingInvitationSchema = z.object({
  email: z.string().optional(),
  invitedBy: GraphIdentitySetSchema.optional(),
  signInRequired: z.boolean().optional(),
}).passthrough();

export type GraphSharingInvitation = z.infer<typeof GraphSharingInvitationSchema>;

/**
 * Item Reference - reference to another item
 * https://learn.microsoft.com/en-us/graph/api/resources/itemreference
 */
export const GraphItemReferenceSchema = z.object({
  driveId: z.string().optional(),
  driveType: z.enum(['personal', 'business', 'documentLibrary']).optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  shareId: z.string().optional(),
  siteId: z.string().optional(),
  sharepointIds: z.object({
    listId: z.string().optional(),
    listItemId: z.string().optional(),
    listItemUniqueId: z.string().optional(),
    siteId: z.string().optional(),
    siteUrl: z.string().optional(),
    tenantId: z.string().optional(),
    webId: z.string().optional(),
  }).optional(),
}).passthrough();

export type GraphItemReference = z.infer<typeof GraphItemReferenceSchema>;

// ============================================================================
// Permission Types
// https://learn.microsoft.com/en-us/graph/api/resources/permission
// ============================================================================

/**
 * Permission resource - represents a sharing permission
 * https://learn.microsoft.com/en-us/graph/api/resources/permission
 *
 * Note: According to official docs, 'roles' is required, but the API sometimes
 * returns permissions without roles in edge cases, so we keep it optional for safety.
 */
export const GraphPermissionSchema = z.object({
  id: z.string(),
  roles: z.array(z.string()).optional(), // Officially required but can be missing in practice
  shareId: z.string().optional(),
  expirationDateTime: z.string().optional(),
  hasPassword: z.boolean().optional(),

  // Identity information (grantedTo/grantedToV2 are newer)
  grantedTo: GraphIdentitySetSchema.optional(),
  grantedToIdentities: z.array(GraphIdentitySetSchema).optional(),
  grantedToV2: GraphSharePointIdentitySetSchema.optional(),
  grantedToIdentitiesV2: z.array(GraphSharePointIdentitySetSchema).optional(),

  // Permission details
  inheritedFrom: GraphItemReferenceSchema.optional(),
  invitation: GraphSharingInvitationSchema.optional(),
  link: GraphSharingLinkSchema.optional(),
}).passthrough();

export type GraphPermission = z.infer<typeof GraphPermissionSchema>;

/**
 * Permissions list response
 */
export const GraphPermissionsResponseSchema = z.object({
  '@odata.context': z.string().optional(),
  '@odata.nextLink': z.string().optional(),
  value: z.array(GraphPermissionSchema),
});

export type GraphPermissionsResponse = z.infer<typeof GraphPermissionsResponseSchema>;

// ============================================================================
// Drive Item Types
// https://learn.microsoft.com/en-us/graph/api/resources/driveitem
// ============================================================================

/**
 * Folder facet - present when item is a folder
 */
export const GraphFolderFacetSchema = z.object({
  childCount: z.number().optional(),
  view: z.object({
    sortBy: z.string().optional(),
    sortOrder: z.string().optional(),
    viewType: z.string().optional(),
  }).optional(),
}).passthrough();

/**
 * File facet - present when item is a file
 */
export const GraphFileFacetSchema = z.object({
  mimeType: z.string().optional(),
  hashes: z.object({
    crc32Hash: z.string().optional(),
    quickXorHash: z.string().optional(),
    sha1Hash: z.string().optional(),
    sha256Hash: z.string().optional(),
  }).optional(),
  processingMetadata: z.boolean().optional(),
}).passthrough();

/**
 * Shared facet - sharing information
 */
export const GraphSharedFacetSchema = z.object({
  owner: GraphIdentitySetSchema.optional(),
  scope: z.string().optional(),
  sharedBy: GraphIdentitySetSchema.optional(),
  sharedDateTime: z.string().optional(),
}).passthrough();

/**
 * Drive Item resource
 * https://learn.microsoft.com/en-us/graph/api/resources/driveitem
 *
 * Note: children field is omitted to avoid circular reference issues
 * Use listDriveItemChildren() to get children separately.
 * Uses .passthrough() to allow additional facets (image, photo, video, etc.)
 */
export const GraphDriveItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  webUrl: z.string().optional(),
  webDavUrl: z.string().optional(),
  size: z.number().optional(),
  createdDateTime: z.string().optional(),
  lastModifiedDateTime: z.string().optional(),
  eTag: z.string().optional(),
  cTag: z.string().optional(),

  // Identity info
  createdBy: GraphIdentitySetSchema.optional(),
  lastModifiedBy: GraphIdentitySetSchema.optional(),

  // Facets
  file: z.object({ mimeType: z.string().optional() }).optional(),
  folder: z.object({ childCount: z.number().optional() }).optional(),

  // References
  parentReference: z.object({
    driveId: z.string().optional(),
    driveType: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    path: z.string().optional(),
    siteId: z.string().optional(),
  }).optional(),

  // SharePoint compatibility
  sharepointIds: z.object({
    listId: z.string().optional(),
    listItemId: z.string().optional(),
    listItemUniqueId: z.string().optional(),
    siteId: z.string().optional(),
    siteUrl: z.string().optional(),
    tenantId: z.string().optional(),
    webId: z.string().optional(),
  }).optional(),

  description: z.string().optional(),
}).passthrough();

export type GraphDriveItem = z.infer<typeof GraphDriveItemSchema>;

/**
 * Drive Items list response
 */
export const GraphDriveItemsResponseSchema = z.object({
  '@odata.context': z.string().optional(),
  '@odata.nextLink': z.string().optional(),
  value: z.array(GraphDriveItemSchema),
});

export type GraphDriveItemsResponse = z.infer<typeof GraphDriveItemsResponseSchema>;

// ============================================================================
// Drive Types
// https://learn.microsoft.com/en-us/graph/api/resources/drive
// ============================================================================

/**
 * Drive resource
 * https://learn.microsoft.com/en-us/graph/api/resources/drive
 */
export const GraphDriveSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  driveType: z.string().optional(), // personal, business, documentLibrary
  webUrl: z.string().optional(),
  description: z.string().optional(),
  createdDateTime: z.string().optional(),
  lastModifiedDateTime: z.string().optional(),

  // Identity info
  createdBy: GraphIdentitySetSchema.optional(),
  lastModifiedBy: GraphIdentitySetSchema.optional(),
  owner: GraphIdentitySetSchema.optional(),

  // Quota information
  quota: z.object({
    deleted: z.number().optional(),
    remaining: z.number().optional(),
    state: z.string().optional(), // normal, nearing, critical, exceeded
    total: z.number().optional(),
    used: z.number().optional(),
  }).optional(),

  // SharePoint compatibility
  sharepointIds: z.object({
    listId: z.string().optional(),
    listItemId: z.string().optional(),
    listItemUniqueId: z.string().optional(),
    siteId: z.string().optional(),
    siteUrl: z.string().optional(),
    tenantId: z.string().optional(),
    webId: z.string().optional(),
  }).optional(),
}).passthrough();

export type GraphDrive = z.infer<typeof GraphDriveSchema>;

/**
 * Drives list response
 */
export const GraphDrivesResponseSchema = z.object({
  '@odata.context': z.string().optional(),
  '@odata.nextLink': z.string().optional(),
  value: z.array(GraphDriveSchema),
});

export type GraphDrivesResponse = z.infer<typeof GraphDrivesResponseSchema>;

// ============================================================================
// Site Types
// https://learn.microsoft.com/en-us/graph/api/resources/site
// ============================================================================

/**
 * Site Collection facet
 */
export const GraphSiteCollectionSchema = z.object({
  hostname: z.string().optional(),
  dataLocationCode: z.string().optional(),
  root: z.object({}).optional(),
}).passthrough();

/**
 * Site resource
 * https://learn.microsoft.com/en-us/graph/api/resources/site
 */
export const GraphSiteSchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  name: z.string().optional(),
  webUrl: z.string().optional(),
  description: z.string().optional(),
  createdDateTime: z.string().optional(),
  lastModifiedDateTime: z.string().optional(),
  eTag: z.string().optional(),
  isPersonalSite: z.boolean().optional(),

  // Site collection info (for root sites)
  siteCollection: GraphSiteCollectionSchema.optional(),
  root: z.object({}).optional(),

  // SharePoint IDs
  sharepointIds: z.object({
    listId: z.string().optional(),
    listItemId: z.string().optional(),
    listItemUniqueId: z.string().optional(),
    siteId: z.string().optional(),
    siteUrl: z.string().optional(),
    tenantId: z.string().optional(),
    webId: z.string().optional(),
  }).optional(),
}).passthrough();

export type GraphSite = z.infer<typeof GraphSiteSchema>;

/**
 * Sites list response
 */
export const GraphSitesResponseSchema = z.object({
  '@odata.context': z.string().optional(),
  '@odata.nextLink': z.string().optional(),
  value: z.array(GraphSiteSchema),
});

export type GraphSitesResponse = z.infer<typeof GraphSitesResponseSchema>;

// ============================================================================
// Site Permissions (different from drive item permissions)
// https://learn.microsoft.com/en-us/graph/api/resources/permission (for sites)
// ============================================================================

/**
 * Site permission - slightly different structure than drive permissions
 */
export const GraphSitePermissionSchema = z.object({
  id: z.string(),
  roles: z.array(z.string()).optional(),
  grantedTo: z.object({
    user: GraphIdentitySchema.optional(),
    group: GraphIdentitySchema.optional(),
    application: GraphIdentitySchema.optional(),
  }).optional(),
  grantedToIdentities: z.array(z.object({
    user: GraphIdentitySchema.optional(),
    group: GraphIdentitySchema.optional(),
    application: GraphIdentitySchema.optional(),
  })).optional(),
}).passthrough();

export type GraphSitePermission = z.infer<typeof GraphSitePermissionSchema>;

/**
 * Site permissions response
 */
export const GraphSitePermissionsResponseSchema = z.object({
  '@odata.context': z.string().optional(),
  '@odata.nextLink': z.string().optional(),
  value: z.array(GraphSitePermissionSchema),
});

export type GraphSitePermissionsResponse = z.infer<typeof GraphSitePermissionsResponseSchema>;

// ============================================================================
// Error Types
// https://learn.microsoft.com/en-us/graph/errors
// ============================================================================

/**
 * Graph API Error response
 */
export const GraphErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    innerError: z.object({
      date: z.string().optional(),
      'request-id': z.string().optional(),
      'client-request-id': z.string().optional(),
    }).optional(),
  }),
});

export type GraphError = z.infer<typeof GraphErrorSchema>;

// ============================================================================
// Email Types (SendMail API)
// https://learn.microsoft.com/en-us/graph/api/user-sendmail
// ============================================================================

/**
 * Email Address
 */
export const GraphEmailAddressSchema = z.object({
  address: z.string().email(),
  name: z.string().optional(),
});

export type GraphEmailAddress = z.infer<typeof GraphEmailAddressSchema>;

/**
 * Email Recipient
 */
export const GraphRecipientSchema = z.object({
  emailAddress: GraphEmailAddressSchema,
});

export type GraphRecipient = z.infer<typeof GraphRecipientSchema>;

/**
 * Email Body
 */
export const GraphItemBodySchema = z.object({
  contentType: z.enum(['text', 'html', 'Text', 'HTML']),
  content: z.string(),
});

export type GraphItemBody = z.infer<typeof GraphItemBodySchema>;

/**
 * File Attachment for emails
 */
export const GraphFileAttachmentSchema = z.object({
  '@odata.type': z.literal('#microsoft.graph.fileAttachment'),
  name: z.string(),
  contentType: z.string(),
  contentBytes: z.string(), // Base64 encoded
});

export type GraphFileAttachment = z.infer<typeof GraphFileAttachmentSchema>;

/**
 * Email Message
 */
export const GraphMessageSchema = z.object({
  subject: z.string(),
  body: GraphItemBodySchema,
  toRecipients: z.array(GraphRecipientSchema),
  ccRecipients: z.array(GraphRecipientSchema).optional(),
  bccRecipients: z.array(GraphRecipientSchema).optional(),
  attachments: z.array(GraphFileAttachmentSchema).optional(),
});

export type GraphMessage = z.infer<typeof GraphMessageSchema>;

/**
 * SendMail Request Body
 */
export const GraphSendMailRequestSchema = z.object({
  message: GraphMessageSchema,
  saveToSentItems: z.boolean().optional().default(true),
});

export type GraphSendMailRequest = z.infer<typeof GraphSendMailRequestSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safely parse a Graph API response with a schema
 * Returns the parsed data or throws a descriptive error
 */
export function parseGraphResponse<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: string = 'Graph API'
): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    console.error(`[${context}] Schema validation failed:`, result.error.format());
    // In development, you might want to throw
    // In production, we'll log and try to return the data anyway
    if (process.env.NODE_ENV === 'development') {
      throw new Error(`${context} response validation failed: ${result.error.message}`);
    }
    // Return data as-is in production (with type assertion)
    return data as T;
  }

  return result.data;
}

/**
 * Safely parse with fallback - returns undefined on failure
 */
export function tryParseGraphResponse<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: string = 'Graph API'
): T | undefined {
  const result = schema.safeParse(data);

  if (!result.success) {
    console.warn(`[${context}] Schema validation failed (non-fatal):`, result.error.format());
    return undefined;
  }

  return result.data;
}
