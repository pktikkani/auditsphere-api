# API Reference

## Overview

AuditSphere API uses tRPC for type-safe remote procedure calls. All endpoints are available at `/api/trpc/{router}.{procedure}`.

## Authentication

All protected endpoints require an Azure AD Bearer token:

```
Authorization: Bearer <azure-ad-token>
```

### Getting a Token (ROPC Flow)

```bash
curl -X POST "https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id={CLIENT_ID}" \
  -d "scope=api://{CLIENT_ID}/.default" \
  -d "username={EMAIL}" \
  -d "password={PASSWORD}" \
  -d "grant_type=password"
```

---

## tRPC Request Format

### Query (GET)

```bash
curl "https://api.example.com/api/trpc/{router}.{procedure}?input={encoded-json}"
```

### Mutation (POST)

```bash
curl -X POST "https://api.example.com/api/trpc/{router}.{procedure}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"json":{...input...}}'
```

---

## Access Review Router

### Campaigns

#### `accessReview.listCampaigns`

List campaigns with pagination and filtering.

**Type:** Query

**Input:**
```typescript
{
  page?: number;      // Default: 1
  limit?: number;     // Default: 20
  status?: 'draft' | 'active' | 'completed' | 'cancelled';
}
```

**Response:**
```json
{
  "campaigns": [
    {
      "id": "clx123...",
      "name": "Q4 Access Review",
      "description": "Quarterly review",
      "siteUrl": "https://tenant.sharepoint.com/sites/hr",
      "scope": "site",
      "status": "active",
      "dueDate": "2025-01-31T00:00:00Z",
      "createdAt": "2025-01-01T10:00:00Z",
      "_count": { "items": 150 }
    }
  ],
  "total": 5,
  "page": 1,
  "limit": 20
}
```

---

#### `accessReview.getCampaign`

Get a single campaign by ID.

**Type:** Query

**Input:**
```typescript
{
  id: string;
}
```

**Response:**
```json
{
  "id": "clx123...",
  "name": "Q4 Access Review",
  "description": "Quarterly review",
  "siteUrl": "https://tenant.sharepoint.com/sites/hr",
  "scope": "site",
  "status": "active",
  "dueDate": "2025-01-31T00:00:00Z",
  "autoRetainOnExpiry": false,
  "createdAt": "2025-01-01T10:00:00Z",
  "startedAt": "2025-01-01T10:05:00Z",
  "completedAt": null
}
```

---

#### `accessReview.createCampaign`

Create a new access review campaign.

**Type:** Mutation

**Input:**
```typescript
{
  name: string;              // 1-200 characters
  description?: string;
  siteUrl: string;           // Valid SharePoint URL
  scope: 'site' | 'library' | 'folder';
  dueDate: string;           // ISO 8601 datetime
  autoRetainOnExpiry?: boolean;
}
```

**Example Request:**
```bash
curl -X POST "https://api.example.com/api/trpc/accessReview.createCampaign" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "json": {
      "name": "Q4 Access Review",
      "siteUrl": "https://tenant.sharepoint.com/sites/hr",
      "scope": "site",
      "dueDate": "2025-01-31T00:00:00Z"
    }
  }'
```

**Response:**
```json
{
  "id": "clx123...",
  "name": "Q4 Access Review",
  "status": "draft"
}
```

---

#### `accessReview.startCampaign`

Start a campaign - collects permissions and creates review items.

**Type:** Mutation

**Input:**
```typescript
{
  id: string;
}
```

**Response:**
```json
{
  "success": true,
  "itemsCreated": 150,
  "message": "Campaign started with 150 items to review"
}
```

---

#### `accessReview.completeCampaign`

Mark a campaign as completed.

**Type:** Mutation

**Input:**
```typescript
{
  id: string;
}
```

---

#### `accessReview.getCampaignStats`

Get detailed statistics for a campaign.

**Type:** Query

**Input:**
```typescript
{
  id: string;
}
```

**Response:**
```json
{
  "total": 150,
  "pending": 50,
  "retained": 80,
  "removed": 20,
  "byPrincipalType": {
    "user": 100,
    "group": 30,
    "link": 20
  },
  "byAccessLevel": {
    "read": 80,
    "write": 50,
    "owner": 20
  }
}
```

---

### Review Items

#### `accessReview.listItems`

List review items for a campaign.

**Type:** Query

**Input:**
```typescript
{
  campaignId: string;
  page?: number;
  limit?: number;
  decision?: 'pending' | 'retain' | 'remove';
  principalType?: 'user' | 'group' | 'link';
  search?: string;
}
```

**Response:**
```json
{
  "items": [
    {
      "id": "item123...",
      "resourceType": "file",
      "resourcePath": "/sites/hr/Shared Documents/salaries.xlsx",
      "permissionId": "perm456",
      "principalType": "user",
      "principalName": "john@company.com",
      "principalEmail": "john@company.com",
      "accessLevel": "write",
      "decision": null,
      "decidedAt": null,
      "decidedBy": null
    }
  ],
  "total": 150,
  "page": 1,
  "limit": 50
}
```

---

#### `accessReview.submitDecision`

Submit a decision for a single item.

**Type:** Mutation

**Input:**
```typescript
{
  itemId: string;
  decision: 'retain' | 'remove';
  comment?: string;
}
```

**Response:**
```json
{
  "success": true,
  "item": {
    "id": "item123...",
    "decision": "remove",
    "decidedAt": "2025-01-15T10:30:00Z",
    "decidedBy": "reviewer@company.com"
  }
}
```

---

#### `accessReview.bulkDecisions`

Submit decisions for multiple items.

**Type:** Mutation

**Input:**
```typescript
{
  decisions: Array<{
    itemId: string;
    decision: 'retain' | 'remove';
  }>;
}
```

**Response:**
```json
{
  "success": true,
  "processed": 10,
  "retained": 7,
  "removed": 3
}
```

---

#### `accessReview.executeCampaign`

Execute removal decisions via Microsoft Graph.

**Type:** Mutation

**Input:**
```typescript
{
  id: string;
}
```

**Response:**
```json
{
  "success": true,
  "executed": 20,
  "failed": 2,
  "errors": [
    { "itemId": "item789", "error": "Permission already removed" }
  ]
}
```

---

### Scheduled Reviews

#### `accessReview.listSchedules`

List all scheduled reviews.

**Type:** Query

**Response:**
```json
{
  "schedules": [
    {
      "id": "sched123...",
      "name": "Monthly HR Review",
      "siteUrl": "https://tenant.sharepoint.com/sites/hr",
      "scope": "site",
      "frequency": "monthly",
      "dayOfMonth": 1,
      "reviewPeriodDays": 14,
      "isActive": true,
      "nextRunAt": "2025-02-01T00:00:00Z",
      "lastRunAt": "2025-01-01T00:00:00Z"
    }
  ]
}
```

---

#### `accessReview.createSchedule`

Create a new scheduled review.

**Type:** Mutation

**Input:**
```typescript
{
  name: string;
  siteUrl: string;
  scope: 'site' | 'library' | 'folder';
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly';
  dayOfWeek?: number;       // 0-6 for weekly
  dayOfMonth?: number;      // 1-28 for monthly
  reviewPeriodDays: number; // Days to complete review
  autoRetainOnExpiry?: boolean;
  notifyOwners?: boolean;
}
```

---

#### `accessReview.runSchedule`

Manually trigger a schedule to create a campaign.

**Type:** Mutation

**Input:**
```typescript
{
  id: string;
}
```

---

### Designated Owners

#### `accessReview.listDesignatedOwners`

List designated site owners.

**Type:** Query

**Input:**
```typescript
{
  page?: number;
  limit?: number;
  siteUrl?: string;
}
```

**Response:**
```json
{
  "owners": [
    {
      "id": "owner123...",
      "siteUrl": "https://tenant.sharepoint.com/sites/hr",
      "ownerEmail": "hr-manager@company.com",
      "ownerName": "HR Manager",
      "assignedAt": "2025-01-01T00:00:00Z"
    }
  ],
  "total": 10
}
```

---

#### `accessReview.createDesignatedOwner`

Assign a designated owner to a site.

**Type:** Mutation

**Input:**
```typescript
{
  siteUrl: string;
  ownerEmail: string;
  ownerName?: string;
}
```

---

### Notifications

#### `accessReview.listNotifications`

List notifications for the current user.

**Type:** Query

**Input:**
```typescript
{
  unreadOnly?: boolean;
  limit?: number;
}
```

**Response:**
```json
{
  "notifications": [
    {
      "id": "notif123...",
      "type": "reminder",
      "title": "Review Due Soon",
      "message": "Q4 Access Review is due in 3 days",
      "campaignId": "clx123...",
      "isRead": false,
      "createdAt": "2025-01-28T00:00:00Z"
    }
  ],
  "unreadCount": 5
}
```

---

#### `accessReview.markNotificationRead`

Mark a notification as read.

**Type:** Mutation

**Input:**
```typescript
{
  id: string;
}
```

---

### Scheduler

#### `accessReview.triggerScheduler`

Manually trigger the scheduler.

**Type:** Mutation

**Input:**
```typescript
{
  action?: 'all' | 'due_schedules' | 'reminders' | 'overdue';
}
```

**Response:**
```json
{
  "success": true,
  "message": "Full scheduler run completed"
}
```

---

## Dashboard Router

#### `dashboard.overview`

Get dashboard overview statistics.

**Type:** Query

**Response:**
```json
{
  "totalEvents": 15000,
  "anomaliesDetected": 45,
  "complianceScore": 87.5,
  "activeAlerts": 12,
  "activeCampaigns": 3,
  "pendingReviews": 150
}
```

---

#### `dashboard.quickStats`

Get quick statistics for cards.

**Type:** Query

**Input:**
```typescript
{
  period?: '24h' | '7d' | '30d';
}
```

---

## Microsoft Router

#### `microsoft.status`

Get Microsoft connection status.

**Type:** Query

**Response:**
```json
{
  "connected": true,
  "connection": {
    "tenantId": "xxx-xxx-xxx",
    "tenantName": "Contoso",
    "status": "active",
    "tokenExpiresAt": "2025-01-15T12:00:00Z"
  }
}
```

---

#### `microsoft.sites`

List connected SharePoint sites.

**Type:** Query

**Response:**
```json
{
  "sites": [
    {
      "id": "site-guid",
      "name": "HR Portal",
      "webUrl": "https://tenant.sharepoint.com/sites/hr",
      "displayName": "Human Resources"
    }
  ]
}
```

---

#### `microsoft.disconnect`

Disconnect Microsoft integration.

**Type:** Mutation

---

## Reports Router

#### `reports.list`

List generated reports.

**Type:** Query

**Input:**
```typescript
{
  page?: number;
  limit?: number;
  type?: string;
}
```

---

#### `reports.generate`

Generate a new report.

**Type:** Mutation

**Input:**
```typescript
{
  name: string;
  type: 'access_audit' | 'compliance' | 'anomaly' | 'sharing' | 'external_access';
  format: 'csv' | 'pdf';
  parameters?: {
    startDate?: string;
    endDate?: string;
    siteUrl?: string;
  };
}
```

---

## Error Responses

All errors follow tRPC error format:

```json
{
  "error": {
    "message": "Campaign not found",
    "code": "NOT_FOUND",
    "data": {
      "code": "NOT_FOUND",
      "httpStatus": 404,
      "path": "accessReview.getCampaign"
    }
  }
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | No valid token provided |
| `FORBIDDEN` | 403 | User lacks permission |
| `NOT_FOUND` | 404 | Resource not found |
| `BAD_REQUEST` | 400 | Invalid input (Zod validation failed) |
| `INTERNAL_SERVER_ERROR` | 500 | Server error |
| `CONFLICT` | 409 | Resource conflict (e.g., duplicate) |

### Zod Validation Errors

When input validation fails:

```json
{
  "error": {
    "message": "[\n  {\n    \"code\": \"too_small\",\n    \"minimum\": 1,\n    \"type\": \"string\",\n    \"inclusive\": true,\n    \"path\": [\"name\"],\n    \"message\": \"String must contain at least 1 character(s)\"\n  }\n]",
    "code": "BAD_REQUEST"
  }
}
```
