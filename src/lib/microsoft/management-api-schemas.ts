/**
 * Office 365 Management Activity API Zod Schemas
 *
 * These schemas validate responses from the Office 365 Management Activity API.
 * Based on official Microsoft documentation:
 * https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-reference
 *
 * Content Types:
 * - Audit.SharePoint - SharePoint and OneDrive events
 * - Audit.Exchange - Exchange events
 * - Audit.AzureActiveDirectory - Azure AD events
 * - Audit.General - Other workload events
 * - DLP.All - Data Loss Prevention events
 */

import { z } from 'zod';

// ============================================================================
// Subscription Types
// https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-reference#start-a-subscription
// ============================================================================

/**
 * Webhook configuration for subscription notifications
 */
export const ManagementWebhookSchema = z.object({
  status: z.string(), // 'enabled' | 'disabled'
  address: z.string().url(),
  authId: z.string().optional(),
  expiration: z.string().optional(),
}).passthrough();

export type ManagementWebhook = z.infer<typeof ManagementWebhookSchema>;

/**
 * Subscription resource
 * Represents a subscription to a content type
 */
export const ManagementSubscriptionSchema = z.object({
  contentType: z.string(), // e.g., 'Audit.SharePoint'
  status: z.string(), // 'enabled' | 'disabled'
  webhook: ManagementWebhookSchema.optional(),
}).passthrough();

export type ManagementSubscription = z.infer<typeof ManagementSubscriptionSchema>;

/**
 * Subscription list response (array of subscriptions)
 */
export const ManagementSubscriptionsResponseSchema = z.array(ManagementSubscriptionSchema);

export type ManagementSubscriptionsResponse = z.infer<typeof ManagementSubscriptionsResponseSchema>;

// ============================================================================
// Content Blob Types
// https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-reference#list-available-content
// ============================================================================

/**
 * Content blob reference
 * Represents a blob containing audit events
 */
export const ManagementContentBlobSchema = z.object({
  contentType: z.string(), // e.g., 'Audit.SharePoint'
  contentId: z.string(),
  contentUri: z.string().url(),
  contentCreated: z.string(), // ISO 8601 datetime
  contentExpiration: z.string(), // ISO 8601 datetime
}).passthrough();

export type ManagementContentBlob = z.infer<typeof ManagementContentBlobSchema>;

/**
 * Content list response (array of content blobs)
 */
export const ManagementContentListResponseSchema = z.array(ManagementContentBlobSchema);

export type ManagementContentListResponse = z.infer<typeof ManagementContentListResponseSchema>;

// ============================================================================
// Audit Event Types
// https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-schema
// ============================================================================

/**
 * Common properties for all audit events
 * These properties are present in all event types
 */
export const ManagementAuditEventBaseSchema = z.object({
  // Required fields
  Id: z.string().uuid(),
  RecordType: z.number(), // See AuditLogRecordType enum
  CreationTime: z.string(), // ISO 8601 datetime
  Operation: z.string(), // e.g., 'FileAccessed', 'FileModified'
  OrganizationId: z.string().uuid(),
  UserType: z.number(), // See UserType enum (0=Regular, 1=Reserved, 2=Admin, etc.)
  UserKey: z.string(), // PUID or unique identifier
  Workload: z.string(), // e.g., 'SharePoint', 'OneDrive', 'Exchange'
  UserId: z.string(), // UPN or email

  // Optional common fields
  ClientIP: z.string().optional(),
  UserAgent: z.string().optional(),
  ResultStatus: z.string().optional(), // 'Succeeded' | 'PartiallySucceeded' | 'Failed'
  Scope: z.number().optional(), // 0=Online, 1=Onprem
}).passthrough();

export type ManagementAuditEventBase = z.infer<typeof ManagementAuditEventBaseSchema>;

/**
 * SharePoint-specific audit event properties
 * Extends base schema with SharePoint-specific fields
 */
export const ManagementSharePointAuditEventSchema = ManagementAuditEventBaseSchema.extend({
  // SharePoint-specific fields
  ObjectId: z.string().optional(), // URL or path to the item
  ItemType: z.string().optional(), // 'File' | 'Folder' | 'Site' | 'List' | 'Web'
  ListId: z.string().uuid().optional(),
  ListItemId: z.string().optional(),
  ListItemUniqueId: z.string().uuid().optional(),
  SiteUrl: z.string().url().optional(),
  Site: z.string().uuid().optional(), // Site collection ID
  WebId: z.string().uuid().optional(),

  // File-related fields
  SourceFileName: z.string().optional(),
  SourceFileExtension: z.string().optional(),
  SourceRelativeUrl: z.string().optional(),
  DestinationFileName: z.string().optional(),
  DestinationFileExtension: z.string().optional(),
  DestinationRelativeUrl: z.string().optional(),

  // Sharing-related fields
  TargetUserOrGroupName: z.string().optional(),
  TargetUserOrGroupType: z.string().optional(), // 'Member' | 'Guest' | 'Group' | etc.
  SharingType: z.string().optional(),
  EventSource: z.string().optional(), // 'SharePoint' | 'ObjectModel'

  // Additional context
  CustomEvent: z.string().optional(),
  EventData: z.string().optional(),
  ModifiedProperties: z.array(z.object({
    Name: z.string(),
    OldValue: z.string().optional(),
    NewValue: z.string().optional(),
  })).optional(),
}).passthrough();

export type ManagementSharePointAuditEvent = z.infer<typeof ManagementSharePointAuditEventSchema>;

/**
 * Audit events array response (from content blob fetch)
 */
export const ManagementAuditEventsResponseSchema = z.array(ManagementSharePointAuditEventSchema);

export type ManagementAuditEventsResponse = z.infer<typeof ManagementAuditEventsResponseSchema>;

// ============================================================================
// Record Type Enum Reference
// https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-schema#auditlogrecordtype
// ============================================================================

/**
 * AuditLogRecordType values
 * Common record types for SharePoint workload
 */
export const AuditLogRecordType = {
  ExchangeAdmin: 1,
  ExchangeItem: 2,
  ExchangeItemGroup: 3,
  SharePoint: 4,
  SharePointFileOperation: 6,
  AzureActiveDirectory: 8,
  AzureActiveDirectoryAccountLogon: 9,
  DataCenterSecurityCmdlet: 10,
  ComplianceDLPSharePoint: 11,
  SharePointSharingOperation: 14,
  SharePointListOperation: 36,
  SharePointCommentOperation: 37,
  DataGovernance: 49,
  SecurityComplianceCenterEOPCmdlet: 50,
  PowerBIAudit: 83,
  OneDrive: 89,
} as const;

/**
 * UserType values
 */
export const UserType = {
  Regular: 0,
  Reserved: 1,
  Admin: 2,
  DcAdmin: 3,
  System: 4,
  Application: 5,
  ServicePrincipal: 6,
  CustomPolicy: 7,
  SystemPolicy: 8,
} as const;

// ============================================================================
// Error Types
// ============================================================================

/**
 * Management API error response
 */
export const ManagementApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
}).passthrough();

export type ManagementApiError = z.infer<typeof ManagementApiErrorSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safely parse a Management API response with a schema
 * Returns the parsed data or throws a descriptive error
 */
export function parseManagementResponse<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: string = 'Management API'
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
export function tryParseManagementResponse<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: string = 'Management API'
): T | undefined {
  const result = schema.safeParse(data);

  if (!result.success) {
    console.warn(`[${context}] Schema validation failed (non-fatal):`, result.error.format());
    return undefined;
  }

  return result.data;
}
