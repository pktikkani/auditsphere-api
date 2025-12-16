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

## Alerts Router

### `alerts.list`

List alerts with filters and pagination.

**Type:** Query

**Input:**
```typescript
{
  page?: number;           // Default: 1
  limit?: number;          // Default: 20, Max: 100
  type?: 'ANOMALY' | 'COMPLIANCE' | 'SECURITY';
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status?: 'NEW' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';
  startDate?: string;      // ISO 8601 datetime
  endDate?: string;        // ISO 8601 datetime
  sortOrder?: 'asc' | 'desc';  // Default: 'desc'
}
```

**Response:**
```json
{
  "alerts": [...],
  "total": 100,
  "page": 1,
  "limit": 20,
  "totalPages": 5
}
```

---

### `alerts.getById`

Get a single alert by ID.

**Type:** Query

**Input:**
```typescript
{
  id: string;
}
```

---

### `alerts.updateStatus`

Update alert status.

**Type:** Mutation

**Input:**
```typescript
{
  id: string;
  status: 'NEW' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';
}
```

---

### `alerts.stats`

Get alert statistics.

**Type:** Query

**Response:**
```json
{
  "total": 100,
  "recentAlerts": 15,
  "unreadCount": 8,
  "bySeverity": {
    "LOW": 20,
    "MEDIUM": 45,
    "HIGH": 30,
    "CRITICAL": 5
  },
  "byStatus": {
    "NEW": 8,
    "ACKNOWLEDGED": 42,
    "RESOLVED": 50
  },
  "byType": {
    "ANOMALY": 60,
    "COMPLIANCE": 30,
    "SECURITY": 10
  }
}
```

---

### `alerts.markAllRead`

Mark all alerts as read (changes NEW to ACKNOWLEDGED).

**Type:** Mutation

**Response:**
```json
{
  "success": true
}
```

---

## Anomalies Router

### `anomalies.list`

List anomalies with filters.

**Type:** Query

**Input:**
```typescript
{
  page?: number;           // Default: 1
  limit?: number;          // Default: 20, Max: 100
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status?: 'NEW' | 'INVESTIGATING' | 'RESOLVED' | 'FALSE_POSITIVE';
  anomalyType?: string;
  userId?: string;
  startDate?: string;
  endDate?: string;
  sortOrder?: 'asc' | 'desc';
}
```

**Response:**
```json
{
  "anomalies": [...],
  "total": 50,
  "page": 1,
  "limit": 20,
  "totalPages": 3
}
```

---

### `anomalies.getById`

Get a single anomaly by ID with related audit event.

**Type:** Query

**Input:**
```typescript
{
  id: string;
}
```

---

### `anomalies.updateStatus`

Update anomaly status.

**Type:** Mutation

**Input:**
```typescript
{
  id: string;
  status: 'NEW' | 'INVESTIGATING' | 'RESOLVED' | 'FALSE_POSITIVE';
  resolution?: string;    // Max 1000 characters
}
```

---

### `anomalies.stats`

Get anomaly statistics.

**Type:** Query

**Response:**
```json
{
  "total": 50,
  "recentAnomalies": 10,
  "bySeverity": {
    "LOW": 10,
    "MEDIUM": 20,
    "HIGH": 15,
    "CRITICAL": 5
  },
  "byStatus": {...},
  "byType": [
    { "type": "UNUSUAL_ACCESS_PATTERN", "count": 15 },
    { "type": "MASS_DOWNLOAD", "count": 10 }
  ],
  "unresolvedCount": 25
}
```

---

## Audit Events Router

### `auditEvents.list`

List audit events with filters.

**Type:** Query

**Input:**
```typescript
{
  page?: number;
  limit?: number;
  operation?: string;
  userId?: string;
  siteUrl?: string;
  userType?: number;       // 0=Regular, 1=Guest, 2=Admin, 3=System
  startDate?: string;
  endDate?: string;
  sortOrder?: 'asc' | 'desc';
}
```

**Response:**
```json
{
  "events": [...],
  "total": 15000,
  "anomalyCount": 45,
  "page": 1,
  "limit": 20,
  "totalPages": 750
}
```

---

### `auditEvents.getById`

Get a single audit event by ID.

**Type:** Query

**Input:**
```typescript
{
  id: string;
}
```

---

### `auditEvents.stats`

Get audit event statistics for a time period.

**Type:** Query

**Input:**
```typescript
{
  days?: number;    // Default: 7, Max: 90
}
```

**Response:**
```json
{
  "summary": {
    "totalEvents": 50000,
    "eventsInPeriod": 5000,
    "uniqueUsers": 150,
    "uniqueSites": 25
  },
  "operations": [
    { "operation": "FileAccessed", "count": 2000 },
    { "operation": "FileModified", "count": 1500 }
  ],
  "userTypes": [
    { "type": "Regular", "userType": 0, "count": 4500 },
    { "type": "Guest", "userType": 1, "count": 500 }
  ],
  "dailyTrend": [
    { "date": "2025-01-01", "count": 700 }
  ],
  "users": ["user1@company.com", "user2@company.com"]
}
```

---

### `auditEvents.getUsers`

Get list of unique users with event counts.

**Type:** Query

**Input:**
```typescript
{
  days?: number;    // Default: 30, Max: 90
}
```

**Response:**
```json
[
  { "userId": "john@company.com", "eventCount": 500 },
  { "userId": "jane@company.com", "eventCount": 350 }
]
```

---

## Compliance Router

### `compliance.run`

Run compliance checks.

**Type:** Mutation

**Input:**
```typescript
{
  standardId?: 'CIS-MS365' | 'CUSTOM' | 'ALL';
  siteUrls?: string[];     // Array of URLs to check
}
```

**Response:**
```json
{
  "success": true,
  "runId": "run-123",
  "message": "Compliance run started"
}
```

---

### `compliance.summary`

Get compliance summary from latest run.

**Type:** Query

**Response:**
```json
{
  "total": 25,
  "passed": 20,
  "failed": 5,
  "passRate": 80,
  "lastRunAt": "2025-01-15T10:00:00Z"
}
```

---

### `compliance.runs`

List compliance runs.

**Type:** Query

**Input:**
```typescript
{
  limit?: number;    // Default: 10, Max: 50
}
```

---

### `compliance.runById`

Get compliance run details with checks.

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
  "run": {...},
  "checks": [...]
}
```

---

### `compliance.checkDefinitions`

Get all available compliance check definitions.

**Type:** Query

**Response:**
```json
[
  {
    "code": "CIS-1.1",
    "name": "External Sharing Settings",
    "description": "Verify external sharing is appropriately restricted",
    "category": "Sharing",
    "severity": "HIGH",
    "standardId": "CIS-MS365"
  }
]
```

---

### `compliance.latestChecks`

Get latest compliance check results with filters.

**Type:** Query

**Input:**
```typescript
{
  page?: number;
  limit?: number;          // Default: 50, Max: 100
  status?: 'PASS' | 'FAIL' | 'WARNING' | 'ERROR' | 'SKIPPED';
  category?: string;
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}
```

---

### `compliance.clear`

Clear all compliance results.

**Type:** Mutation

**Response:**
```json
{
  "success": true
}
```

---

## Dashboard Router

### `dashboard.overview`

Get complete dashboard overview data.

**Type:** Query

**Input:**
```typescript
{
  days?: number;    // Default: 7, Max: 30
}
```

**Response:**
```json
{
  "events": {
    "total": 50000,
    "inPeriod": 5000,
    "uniqueUsers": 150,
    "uniqueSites": 25,
    "recent": [...]
  },
  "anomalies": {
    "total": 50,
    "inPeriod": 10,
    "unresolved": 25,
    "bySeverity": {...},
    "criticalCount": 8
  },
  "alerts": {
    "total": 100,
    "unread": 8
  },
  "compliance": {
    "score": 87,
    "passed": 22,
    "failed": 3,
    "total": 25,
    "lastRun": "2025-01-15T10:00:00Z"
  },
  "trends": {
    "events": [...],
    "anomalies": [...]
  },
  "period": {
    "start": "2025-01-08T00:00:00Z",
    "end": "2025-01-15T00:00:00Z",
    "days": 7
  }
}
```

---

### `dashboard.quickStats`

Get quick statistics for header/nav display.

**Type:** Query

**Response:**
```json
{
  "unresolvedAnomalies": 25,
  "unreadAlerts": 8
}
```

---

### `dashboard.activityFeed`

Get combined activity feed (events + anomalies).

**Type:** Query

**Input:**
```typescript
{
  limit?: number;    // Default: 20, Max: 50
}
```

**Response:**
```json
[
  {
    "type": "event",
    "id": "evt-123",
    "timestamp": "2025-01-15T10:30:00Z",
    "title": "FileAccessed",
    "subtitle": "john@company.com",
    "details": "report.xlsx"
  },
  {
    "type": "anomaly",
    "id": "anom-456",
    "timestamp": "2025-01-15T10:25:00Z",
    "title": "MASS DOWNLOAD",
    "subtitle": "jane@company.com",
    "details": "HIGH - FileDownloaded",
    "severity": "HIGH"
  }
]
```

---

## Microsoft Router

### `microsoft.status`

Get Microsoft connection status.

**Type:** Query

**Response:**
```json
{
  "connected": true,
  "connections": [
    {
      "id": "conn-123",
      "tenantId": "xxx-xxx-xxx",
      "tenantName": "Contoso",
      "isActive": true,
      "lastSyncAt": "2025-01-15T10:00:00Z",
      "createdAt": "2025-01-01T00:00:00Z"
    }
  ]
}
```

---

### `microsoft.sites`

Get SharePoint sites from Microsoft.

**Type:** Query

**Response:**
```json
[
  {
    "id": "site-guid",
    "graphId": "site-graph-id",
    "displayName": "HR Portal",
    "webUrl": "https://tenant.sharepoint.com/sites/hr",
    "siteCollection": "HR",
    "createdAt": "2025-01-01T00:00:00Z"
  }
]
```

---

### `microsoft.disconnect`

Disconnect Microsoft connection.

**Type:** Mutation

**Input:**
```typescript
{
  connectionId: string;
}
```

**Response:**
```json
{
  "success": true
}
```

---

### `microsoft.health`

Get connection health status.

**Type:** Query

**Response:**
```json
{
  "healthy": true,
  "message": "Connection healthy",
  "lastSync": "2025-01-15T10:00:00Z",
  "tenantName": "Contoso"
}
```

---

## Reports Router

### `reports.list`

List generated reports.

**Type:** Query

**Input:**
```typescript
{
  page?: number;
  limit?: number;          // Default: 20, Max: 50
  type?: 'access_audit' | 'compliance' | 'anomaly' | 'sharing' | 'external_access';
  status?: 'PENDING' | 'GENERATING' | 'COMPLETED' | 'FAILED';
}
```

---

### `reports.getById`

Get a single report by ID.

**Type:** Query

**Input:**
```typescript
{
  id: string;
}
```

---

### `reports.generate`

Generate a new report.

**Type:** Mutation

**Input:**
```typescript
{
  name: string;            // 1-100 characters
  type: 'access_audit' | 'compliance' | 'anomaly' | 'sharing' | 'external_access';
  format?: 'pdf' | 'xlsx' | 'csv';  // Default: 'csv'
  parameters?: {
    startDate?: string;
    endDate?: string;
  };
}
```

---

### `reports.delete`

Delete a report.

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
  "success": true
}
```

---

### `reports.types`

Get available report types.

**Type:** Query

**Response:**
```json
[
  {
    "id": "access_audit",
    "name": "Access Audit Report",
    "description": "Comprehensive report of file and resource access activities"
  },
  {
    "id": "compliance",
    "name": "Compliance Report",
    "description": "Summary of compliance check results and findings"
  },
  {
    "id": "anomaly",
    "name": "Anomaly Report",
    "description": "Detected anomalies and security incidents"
  },
  {
    "id": "sharing",
    "name": "Sharing Report",
    "description": "File and folder sharing activities and permissions"
  },
  {
    "id": "external_access",
    "name": "External Access Report",
    "description": "External user and guest access activities"
  }
]
```

---

## Sites Router

### `sites.list`

List SharePoint sites with pagination and search.

**Type:** Query

**Input:**
```typescript
{
  page?: number;
  limit?: number;          // Default: 20, Max: 100
  search?: string;
}
```

**Response:**
```json
{
  "sites": [
    {
      "id": "site-123",
      "siteId": "graph-site-id",
      "siteUrl": "https://tenant.sharepoint.com/sites/hr",
      "title": "HR Portal",
      "description": "Human Resources",
      "isExternal": false,
      "lastActivityAt": "2025-01-15T10:00:00Z",
      "createdAt": "2025-01-01T00:00:00Z"
    }
  ],
  "total": 25,
  "page": 1,
  "limit": 20,
  "totalPages": 2
}
```

---

### `sites.getById`

Get a single site by ID.

**Type:** Query

**Input:**
```typescript
{
  id: string;
}
```

---

### `sites.stats`

Get site statistics.

**Type:** Query

**Response:**
```json
{
  "total": 25,
  "externalCount": 5,
  "recentlyActive": 18
}
```

---

## Settings Router

### `settings.getCredentials`

Get current credentials status (masked).

**Type:** Query

**Response:**
```json
{
  "hasCustomCredentials": true,
  "useCustomCredentials": true,
  "envConfigured": true,
  "credentials": {
    "tenantId": "xxxx••••••••xxxx",
    "clientId": "xxxx••••••••xxxx",
    "clientSecret": "••••••••••••••••",
    "updatedAt": "2025-01-15T10:00:00Z"
  }
}
```

---

### `settings.saveCredentials`

Save or update Microsoft credentials.

**Type:** Mutation

**Input:**
```typescript
{
  tenantId: string;
  clientId: string;
  clientSecret: string;
  useCustomCredentials?: boolean;  // Default: true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Credentials saved successfully"
}
```

---

### `settings.deleteCredentials`

Delete custom credentials.

**Type:** Mutation

**Response:**
```json
{
  "success": true,
  "message": "Credentials removed"
}
```

---

### `settings.toggleCustomCredentials`

Toggle use of custom credentials.

**Type:** Mutation

**Input:**
```typescript
{
  useCustomCredentials: boolean;
}
```

**Response:**
```json
{
  "success": true,
  "useCustomCredentials": false
}
```

---

## User Router

### `user.me`

Get current user info.

**Type:** Query

**Response:**
```json
{
  "id": "user-123",
  "email": "john@company.com",
  "name": "John Doe",
  "role": "admin",
  "hasMicrosoftConnection": true
}
```

---

## Error Responses

All errors follow tRPC error format:

```json
{
  "error": {
    "message": "Resource not found",
    "code": "NOT_FOUND",
    "data": {
      "code": "NOT_FOUND",
      "httpStatus": 404,
      "path": "alerts.getById"
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
| `PRECONDITION_FAILED` | 412 | Prerequisites not met (e.g., no Microsoft connection) |

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
