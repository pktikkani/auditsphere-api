# AuditSphere API

Azure Functions-based tRPC API for AuditSphere - SharePoint Security & Compliance Monitoring.

## Overview

This is a standalone API service that provides tRPC endpoints for the AuditSphere platform. It can be deployed to Azure Functions for serverless operation.

## Prerequisites

- Node.js 18+
- Azure Functions Core Tools v4
- PostgreSQL database (Neon recommended)
- Azure subscription (for deployment)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Generate Prisma Client

```bash
npm run db:generate
```

### 3. Configure Environment

Copy and edit the local settings:

```bash
cp local.settings.json.example local.settings.json
```

Edit `local.settings.json` with your values:

```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "DATABASE_URL": "postgresql://...",
    "MICROSOFT_TENANT_ID": "your-tenant-id",
    "MICROSOFT_CLIENT_ID": "your-client-id",
    "MICROSOFT_CLIENT_SECRET": "your-client-secret",
    "ENCRYPTION_KEY": "your-encryption-key"
  },
  "Host": {
    "CORS": "*",
    "CORSCredentials": false
  }
}
```

### 4. Run Locally

```bash
npm run dev
```

The API will be available at `http://localhost:7071/api/trpc/*`

## API Endpoints

### tRPC Endpoints

All tRPC procedures are available at `/api/trpc/{procedure}`:

| Router | Procedures |
|--------|------------|
| `dashboard` | `overview`, `quickStats`, `activityFeed` |
| `auditEvents` | `list`, `getById`, `stats`, `getUsers` |
| `anomalies` | `list`, `getById`, `updateStatus`, `stats` |
| `compliance` | `run`, `summary`, `runs`, `runById`, `latestChecks`, `clear` |
| `alerts` | `list`, `getById`, `updateStatus`, `stats`, `markAllRead` |
| `reports` | `list`, `getById`, `generate`, `delete`, `types` |
| `microsoft` | `status`, `sites`, `disconnect`, `health` |
| `sites` | `list`, `getById`, `stats` |
| `settings` | `getCredentials`, `saveCredentials`, `deleteCredentials`, `toggleCustomCredentials` |
| `accessReview` | See [Access Review API](#access-review-api) below |

### Access Review API

The Access Review router provides comprehensive SharePoint access review functionality:

#### Campaigns
| Procedure | Type | Description |
|-----------|------|-------------|
| `listCampaigns` | Query | List campaigns with pagination and status filter |
| `getCampaign` | Query | Get a single campaign by ID |
| `createCampaign` | Mutation | Create a new access review campaign |
| `updateCampaign` | Mutation | Update campaign details |
| `deleteCampaign` | Mutation | Delete a campaign |
| `startCampaign` | Mutation | Start collecting permissions and begin review |
| `completeCampaign` | Mutation | Mark campaign as completed |
| `getCampaignStats` | Query | Get campaign statistics and breakdown |
| `getCampaignReport` | Query | Get detailed campaign report with all items |
| `sendCampaignReport` | Mutation | Send report via email with PDF attachment |

#### Review Items & Decisions
| Procedure | Type | Description |
|-----------|------|-------------|
| `listItems` | Query | List review items with filters |
| `getItem` | Query | Get a single review item |
| `submitDecision` | Mutation | Submit retain/remove decision for an item |
| `bulkDecisions` | Mutation | Submit multiple decisions at once |
| `bulkRetainAll` | Mutation | Retain all pending items in a campaign |
| `executeCampaign` | Mutation | Execute removal decisions via Microsoft Graph |

#### Scheduled Reviews
| Procedure | Type | Description |
|-----------|------|-------------|
| `listSchedules` | Query | List all scheduled reviews |
| `createSchedule` | Mutation | Create a new scheduled review |
| `updateSchedule` | Mutation | Update schedule settings |
| `deleteSchedule` | Mutation | Delete a schedule |
| `runSchedule` | Mutation | Manually run a schedule to create campaign |

#### Designated Owners
| Procedure | Type | Description |
|-----------|------|-------------|
| `listDesignatedOwners` | Query | List designated site owners |
| `getDesignatedOwner` | Query | Get a designated owner by ID |
| `createDesignatedOwner` | Mutation | Assign a designated owner to a site |
| `updateDesignatedOwner` | Mutation | Update owner details |
| `deleteDesignatedOwner` | Mutation | Remove a designated owner |
| `getOwnersForSite` | Query | Get all owners for a specific site |

#### Notifications
| Procedure | Type | Description |
|-----------|------|-------------|
| `listNotifications` | Query | List notifications with filters |
| `createNotification` | Mutation | Create a notification |
| `markNotificationRead` | Mutation | Mark a notification as read |
| `markAllNotificationsRead` | Mutation | Mark all notifications as read |
| `deleteNotification` | Mutation | Delete a notification |

#### Scheduler
| Procedure | Type | Description |
|-----------|------|-------------|
| `triggerScheduler` | Mutation | Manually trigger the scheduler |

The scheduler runs automatically every 5 minutes and handles:
- Creating campaigns from due schedules
- Sending reminder notifications (7, 3, 1 days before due)
- Processing overdue campaigns (auto-retain if configured)

**Trigger Options:**
- `all` (default) - Run full scheduler
- `due_schedules` - Only check and create campaigns from due schedules
- `reminders` - Only send reminder notifications
- `overdue` - Only process overdue campaigns

### Health Check

```bash
curl http://localhost:7071/api/health
```

## Authentication

The API validates Azure AD tokens from the Authorization header:

```
Authorization: Bearer <azure-ad-token>
```

Tokens are validated against:
- Audience: Your Microsoft Client ID (or `api://{client-id}`)
- Issuer: Your Microsoft Tenant

### Getting an Access Token via cURL

You can obtain an Azure AD token using the Resource Owner Password Credentials (ROPC) flow:

```bash
# Get Azure AD token
curl -X POST "https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id={CLIENT_ID}" \
  -d "scope=api://{CLIENT_ID}/.default" \
  -d "username={YOUR_EMAIL}" \
  -d "password={YOUR_PASSWORD}" \
  -d "grant_type=password"
```

This returns JSON with an `access_token` field.

**Note:** ROPC requires "Allow public client flows" to be enabled in Azure Portal:
Azure Portal → App Registrations → Your App → Authentication → Allow public client flows → Yes

### Example: Trigger Scheduler via cURL

```bash
# Step 1: Get token
TOKEN=$(curl -s -X POST "https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id={CLIENT_ID}" \
  -d "scope=api://{CLIENT_ID}/.default" \
  -d "username={YOUR_EMAIL}" \
  -d "password={YOUR_PASSWORD}" \
  -d "grant_type=password" | jq -r '.access_token')

# Step 2: Call the API
curl -X POST "https://auditsphere-api-access.nubewired.com/trpc/accessReview.triggerScheduler" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"json":{}}'

# Or trigger a specific action
curl -X POST "https://auditsphere-api-access.nubewired.com/trpc/accessReview.triggerScheduler" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"json":{"action":"due_schedules"}}'
```

### Shell Script for API Calls

Create a file `trigger-scheduler.sh`:

```bash
#!/bin/bash

# Configuration
TENANT_ID="your-tenant-id"
CLIENT_ID="your-client-id"
USERNAME="your-email@domain.com"
PASSWORD="your-password"
API_URL="https://auditsphere-api-access.nubewired.com"

# Get token
echo "Getting access token..."
TOKEN=$(curl -s -X POST "https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=$CLIENT_ID" \
  -d "scope=api://$CLIENT_ID/.default" \
  -d "username=$USERNAME" \
  -d "password=$PASSWORD" \
  -d "grant_type=password" | jq -r '.access_token')

if [ "$TOKEN" == "null" ] || [ -z "$TOKEN" ]; then
  echo "Failed to get access token"
  exit 1
fi

echo "Token obtained successfully"

# Trigger scheduler
echo "Triggering scheduler..."
curl -X POST "$API_URL/trpc/accessReview.triggerScheduler" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"json":{"action":"'"${1:-all}"'"}}'

echo ""
echo "Done!"
```

Usage:
```bash
chmod +x trigger-scheduler.sh
./trigger-scheduler.sh          # Run full scheduler
./trigger-scheduler.sh reminders # Only check reminders
```

## Microsoft API Schema Validation

External Microsoft API responses are validated at runtime using Zod schemas to ensure type safety at the boundary between this application and Microsoft services.

### Microsoft Graph API

Schemas for SharePoint permissions, sites, drives, and email operations.

| Schema | Description |
|--------|-------------|
| `GraphPermissionSchema` | Drive item and site permissions |
| `GraphDriveItemSchema` | Files and folders in OneDrive/SharePoint |
| `GraphDriveSchema` | Document libraries and drives |
| `GraphSiteSchema` | SharePoint sites and site collections |
| `GraphIdentitySetSchema` | User/group/app identities |
| `GraphSharingLinkSchema` | Anonymous and organizational sharing links |
| `GraphSendMailRequestSchema` | Email message structure |

**File:** `src/lib/microsoft/graph-schemas.ts`

### Office 365 Management Activity API

Schemas for audit log subscriptions and events.

| Schema | Description |
|--------|-------------|
| `ManagementSubscriptionSchema` | Audit log subscriptions with webhook config |
| `ManagementContentBlobSchema` | Content blob references for fetching events |
| `ManagementSharePointAuditEventSchema` | SharePoint audit events (file access, sharing, etc.) |

**File:** `src/lib/microsoft/management-api-schemas.ts`

### Usage

```typescript
import { parseGraphResponse, GraphPermissionSchema } from './graph-schemas.js';
import { parseManagementResponse, ManagementAuditEventsResponseSchema } from './management-api-schemas.js';

// Validate Graph API response
const permissions = parseGraphResponse(GraphPermissionSchema, apiResponse, 'Get Permissions');

// Validate Management API response
const events = parseManagementResponse(ManagementAuditEventsResponseSchema, apiResponse, 'Fetch Events');
```

In development mode, validation failures throw errors. In production, failures are logged and the raw data is returned to avoid breaking changes from Microsoft API updates.

## Project Structure

```
auditsphere-api/
├── src/
│   ├── functions/
│   │   └── trpc.ts              # Azure Function handler
│   ├── trpc/
│   │   ├── init.ts              # tRPC initialization & auth
│   │   ├── index.ts             # Exports
│   │   └── routers/             # tRPC routers
│   │       ├── _app.ts          # Root router
│   │       ├── dashboard.ts
│   │       ├── auditEvents.ts
│   │       ├── anomalies.ts
│   │       ├── compliance.ts
│   │       ├── alerts.ts
│   │       ├── reports.ts
│   │       ├── microsoft.ts
│   │       ├── sites.ts
│   │       ├── settings.ts
│   │       └── accessReview.ts  # Access Review API
│   ├── jobs/
│   │   └── access-review-scheduler.ts  # Background scheduler
│   └── lib/
│       ├── db/
│       │   └── prisma.ts        # Database client
│       ├── microsoft/
│       │   ├── email.ts                  # Microsoft Graph email client
│       │   ├── graph-schemas.ts          # Zod schemas for Graph API
│       │   ├── management-api.ts         # Office 365 Management API client
│       │   ├── management-api-schemas.ts # Zod schemas for Management API
│       │   ├── permissions.ts            # SharePoint permissions client
│       │   └── token-manager.ts          # OAuth token management
│       └── access-review/
│           └── pdf-report.tsx   # PDF report generation
├── prisma/
│   └── schema.prisma            # Database schema
├── openapi.yaml                 # OpenAPI 3.0 specification
├── host.json                    # Azure Functions config
├── local.settings.json          # Local environment (gitignored)
├── package.json
└── tsconfig.json
```

## Deployment

### Option 1: GitHub Actions (Recommended)

The repository includes a GitHub Actions workflow for automatic deployment.

**Setup:**

1. Create an Azure Function App in Azure Portal:
   - Runtime: Node.js 20
   - OS: Linux
   - Plan: Consumption (serverless) or Premium

2. Get your Publish Profile:
   - Go to your Function App in Azure Portal
   - Click "Get publish profile" and download

3. Add GitHub Secrets:
   - Go to your repo → Settings → Secrets → Actions
   - Add `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` with the publish profile content

4. Configure Azure App Settings:
   - `DATABASE_URL` - PostgreSQL connection string
   - `MICROSOFT_TENANT_ID` - Azure AD tenant ID
   - `MICROSOFT_CLIENT_ID` - App registration client ID
   - `MICROSOFT_CLIENT_SECRET` - App registration secret
   - `ENCRYPTION_KEY` - Generate with `openssl rand -base64 32`

5. Update workflow:
   - Edit `.github/workflows/deploy.yml`
   - Change `AZURE_FUNCTIONAPP_NAME` to your Function App name

6. Push to `main` branch to trigger deployment.

### Option 2: Manual Deployment

```bash
# Build the project
npm run build

# Deploy using Azure Functions Core Tools
func azure functionapp publish <your-function-app-name>
```

### Option 3: VS Code

1. Install Azure Functions extension
2. Sign in to Azure
3. Right-click on the project → Deploy to Function App

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Build and start locally |
| `npm run build` | Compile TypeScript |
| `npm run start` | Start Azure Functions |
| `npm run db:generate` | Generate Prisma client |
| `npm run db:push` | Push schema to database |
| `npm run db:studio` | Open Prisma Studio |

## Related Projects

- [AuditSphere](https://github.com/your-org/auditsphere) - Main web application
- [AuditSphere SPFx](https://github.com/your-org/auditsphere-spfx) - SharePoint web part
- [AuditSphere ML](https://github.com/your-org/auditsphere-ml) - Machine learning service
