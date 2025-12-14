import { TokenManager } from './token-manager.js';
import { db } from '../db/prisma.js';

const MANAGEMENT_BASE_URL = 'https://manage.office.com/api/v1.0';

export interface AuditEvent {
  Id: string;
  RecordType: number;
  CreationTime: string;
  Operation: string;
  OrganizationId: string;
  UserType: number;
  UserKey: string;
  Workload: string;
  UserId: string;
  ClientIP?: string;
  UserAgent?: string;
  ObjectId?: string;
  ItemType?: string;
  ListId?: string;
  ListItemId?: string;
  SiteUrl?: string;
  SourceFileName?: string;
  TargetUserOrGroupName?: string;
  TargetUserOrGroupType?: string;
  SharingType?: string;
  EventSource?: string;
  SourceFileExtension?: string;
}

export interface ContentBlob {
  contentType: string;
  contentId: string;
  contentUri: string;
  contentCreated: string;
  contentExpiration: string;
}

export interface Subscription {
  contentType: string;
  status: string;
  webhook?: {
    status: string;
    address: string;
    authId?: string;
    expiration?: string;
  };
}

export class ManagementApiClient {
  private tokenManager: TokenManager;
  private tenantId: string;

  constructor(userId: string, tenantId: string) {
    this.tokenManager = new TokenManager(userId, tenantId);
    this.tenantId = tenantId;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    // Use Management API-specific token (client credentials flow)
    const accessToken = await this.tokenManager.getManagementApiToken();

    const response = await fetch(
      `${MANAGEMENT_BASE_URL}/${this.tenantId}/activity/feed${endpoint}`,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Management API error: ${response.status} - ${error}`);
    }

    // Handle empty responses
    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    return JSON.parse(text);
  }

  /**
   * Start a subscription for SharePoint audit events
   */
  async startSubscription(
    webhookUrl?: string,
    authId?: string
  ): Promise<Subscription> {
    const body = webhookUrl
      ? {
          webhook: {
            address: webhookUrl,
            authId: authId || 'auditsphere',
            expiration: '',
          },
        }
      : undefined;

    return this.request<Subscription>(
      '/subscriptions/start?contentType=Audit.SharePoint',
      {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      }
    );
  }

  /**
   * Stop a subscription
   */
  async stopSubscription(): Promise<void> {
    await this.request<void>(
      '/subscriptions/stop?contentType=Audit.SharePoint',
      { method: 'POST' }
    );
  }

  /**
   * List current subscriptions
   */
  async listSubscriptions(): Promise<Subscription[]> {
    return this.request<Subscription[]>('/subscriptions/list');
  }

  /**
   * List available content blobs
   */
  async listContent(
    startTime?: Date,
    endTime?: Date
  ): Promise<ContentBlob[]> {
    let query = '?contentType=Audit.SharePoint';

    if (startTime && endTime) {
      query += `&startTime=${startTime.toISOString()}&endTime=${endTime.toISOString()}`;
    }

    return this.request<ContentBlob[]>(`/subscriptions/content${query}`);
  }

  /**
   * Fetch actual audit events from a content URI
   */
  async fetchContent(contentUri: string): Promise<AuditEvent[]> {
    const accessToken = await this.tokenManager.getManagementApiToken();

    const response = await fetch(contentUri, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch content: ${response.status} - ${error}`);
    }

    return await response.json() as AuditEvent[];
  }

  /**
   * Fetch all audit events for a time range
   */
  async fetchAuditEvents(
    startTime?: Date,
    endTime?: Date
  ): Promise<AuditEvent[]> {
    const contentBlobs = await this.listContent(startTime, endTime);
    const allEvents: AuditEvent[] = [];

    for (const blob of contentBlobs) {
      try {
        const events = await this.fetchContent(blob.contentUri);
        allEvents.push(...events);
      } catch (error) {
        console.error(`Failed to fetch content blob ${blob.contentId}:`, error);
      }
    }

    return allEvents;
  }
}

/**
 * Get or create a Management API client for a user
 */
export async function getManagementApiClient(userId: string): Promise<ManagementApiClient | null> {
  try {
    const connection = await db.microsoftConnection.findFirst({
      where: {
        userId,
        status: 'active',
      },
    });

    if (!connection) {
      return null;
    }

    return new ManagementApiClient(userId, connection.tenantId);
  } catch {
    return null;
  }
}
