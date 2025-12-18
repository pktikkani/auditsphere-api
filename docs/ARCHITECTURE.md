# AuditSphere API Architecture

## Overview

AuditSphere API is a standalone tRPC-based API service designed to serve the AuditSphere SPFx web part deployed in SharePoint Online. It provides type-safe API endpoints with runtime validation for SharePoint security monitoring and access review functionality.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Layer                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  SPFx Web Part (SharePoint Online)                                       │
│  - Uses @trpc/client for type-safe API calls                            │
│  - Azure AD authentication via AadHttpClient                            │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼ (HTTPS + Bearer Token)
┌─────────────────────────────────────────────────────────────────────────┐
│                        AuditSphere API                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  Azure Functions (Node.js)                                               │
│  - tRPC Router with Zod validation                                       │
│  - Azure AD token validation                                             │
│  - Scheduled jobs (access review)                                        │
└──────────────────┬──────────────────────────────┬───────────────────────┘
                   │                              │
                   ▼                              ▼
┌──────────────────────────────┐  ┌──────────────────────────────────────┐
│      Neon PostgreSQL         │  │        Microsoft APIs                 │
├──────────────────────────────┤  ├──────────────────────────────────────┤
│  - Users & connections       │  │  Microsoft Graph API                  │
│  - Audit events              │  │  - Sites, Drives, Permissions        │
│  - Access review campaigns   │  │  - Email (Mail.Send)                  │
│  - Compliance data           │  │                                       │
│  - Alerts & anomalies        │  │  Office 365 Management API            │
│                              │  │  - Audit log subscriptions            │
│                              │  │  - SharePoint activity events         │
└──────────────────────────────┘  └──────────────────────────────────────┘
```

## Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Runtime | Azure Functions | Serverless compute |
| Framework | tRPC | Type-safe API layer |
| Validation | Zod | Runtime schema validation |
| Database | Prisma + Neon | ORM with serverless PostgreSQL |
| Auth | Azure AD | Token validation |
| External APIs | Microsoft Graph, O365 Management | SharePoint data access |

## tRPC Architecture

### What is tRPC?

tRPC (TypeScript Remote Procedure Call) provides end-to-end type safety between client and server without code generation or schemas. Types flow directly from the server to the client.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Type Safety Flow                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   Server (auditsphere-api)              Client (SPFx)                   │
│   ┌───────────────────────┐             ┌───────────────────────┐       │
│   │ // Router definition  │             │ // Client usage       │       │
│   │ getCampaign: t        │────────────▶│ const campaign =      │       │
│   │   .input(z.object({   │  TypeScript │   await trpc          │       │
│   │     id: z.string()    │    Types    │     .accessReview     │       │
│   │   }))                 │  (Inferred) │     .getCampaign      │       │
│   │   .output(Campaign)   │             │     .query({ id })    │       │
│   │   .query(...)         │             │                       │       │
│   └───────────────────────┘             │ // campaign is fully  │       │
│                                         │ // typed automatically│       │
│                                         └───────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
```

### tRPC Request Flow

```
Client Request
      │
      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ HTTP Request: POST /api/trpc/accessReview.getCampaign                   │
│ Body: {"json":{"id":"campaign-123"}}                                    │
│ Headers: Authorization: Bearer <azure-ad-token>                         │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Azure Functions Handler                              │
│                     (src/functions/trpc.ts)                             │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Receives HTTP request                                                │
│  2. Extracts path, method, body                                          │
│  3. Passes to tRPC adapter                                               │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     tRPC Context Creation                                │
│                     (src/trpc/init.ts)                                  │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Extract Authorization header                                         │
│  2. Validate Azure AD token (JWKS verification)                         │
│  3. Extract user claims (userId, tenantId, email)                       │
│  4. Create context: { userId, tenantId, userEmail }                     │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Router Execution                                     │
│                     (src/trpc/routers/accessReview.ts)                  │
├─────────────────────────────────────────────────────────────────────────┤
│  1. protectedProcedure middleware checks ctx.userId                     │
│  2. Zod validates input: z.object({ id: z.string() })                   │
│  3. Execute query logic (database/API calls)                            │
│  4. Return typed response                                                │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ HTTP Response: {"result":{"data":{"json":{...campaign data...}}}}       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Procedure Types

tRPC supports two procedure types:

| Type | HTTP Method | Purpose | Example |
|------|-------------|---------|---------|
| **Query** | GET | Read operations | `getCampaign`, `listItems` |
| **Mutation** | POST | Write operations | `createCampaign`, `submitDecision` |

```typescript
// Query - for reading data
getCampaign: protectedProcedure
  .input(z.object({ id: z.string() }))
  .query(async ({ ctx, input }) => {
    return db.campaign.findUnique({ where: { id: input.id } });
  }),

// Mutation - for writing data
createCampaign: protectedProcedure
  .input(z.object({ name: z.string(), siteUrl: z.string() }))
  .mutation(async ({ ctx, input }) => {
    return db.campaign.create({ data: input });
  }),
```

### Router Structure

```
src/trpc/
├── init.ts              # tRPC initialization & context
├── index.ts             # Exports
└── routers/
    ├── _app.ts          # Root router (merges all routers)
    ├── dashboard.ts     # Dashboard statistics
    ├── auditEvents.ts   # Audit event queries
    ├── anomalies.ts     # Anomaly detection
    ├── compliance.ts    # Compliance checks
    ├── alerts.ts        # Alert management
    ├── reports.ts       # Report generation
    ├── microsoft.ts     # Microsoft connection
    ├── sites.ts         # SharePoint sites
    ├── settings.ts      # App settings
    └── accessReview.ts  # Access review (largest router)
```

## Zod Schema Validation

### What is Zod?

Zod is a TypeScript-first schema validation library. It provides:
- Runtime validation of data
- TypeScript type inference from schemas
- Detailed error messages
- Composable and reusable schemas

### Validation Layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Data Validation Boundaries                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────────┐   │
│  │   Client    │────▶│   tRPC      │────▶│   Database / APIs       │   │
│  │   Request   │     │   Router    │     │                         │   │
│  └─────────────┘     └─────────────┘     └─────────────────────────┘   │
│         │                   │                        │                   │
│         ▼                   ▼                        ▼                   │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────────┐   │
│  │ Input Zod   │     │ Business    │     │ External API Zod        │   │
│  │ Validation  │     │ Logic       │     │ Response Validation     │   │
│  │             │     │             │     │                         │   │
│  │ - Required  │     │ - Auth      │     │ - Graph API schemas     │   │
│  │   fields    │     │ - Ownership │     │ - Management API        │   │
│  │ - Types     │     │ - Limits    │     │   schemas               │   │
│  │ - Formats   │     │             │     │ - Graceful fallback     │   │
│  └─────────────┘     └─────────────┘     └─────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### tRPC Input Validation

Every tRPC procedure validates its input using Zod:

```typescript
// src/trpc/routers/accessReview.ts

createCampaign: protectedProcedure
  .input(
    z.object({
      name: z.string().min(1).max(200),
      description: z.string().optional(),
      siteUrl: z.string().url(),
      scope: z.enum(['site', 'library', 'folder']),
      dueDate: z.string().datetime(),
      autoRetainOnExpiry: z.boolean().default(false),
    })
  )
  .mutation(async ({ ctx, input }) => {
    // input is fully typed and validated
    // TypeScript knows: input.name is string, input.scope is 'site' | 'library' | 'folder'
  }),
```

### External API Response Validation

Microsoft API responses are validated at runtime:

```typescript
// src/lib/microsoft/graph-schemas.ts

export const GraphPermissionSchema = z.object({
  id: z.string(),
  roles: z.array(z.string()).optional(),
  grantedTo: GraphIdentitySetSchema.optional(),
  grantedToV2: GraphSharePointIdentitySetSchema.optional(),
  link: GraphSharingLinkSchema.optional(),
  expirationDateTime: z.string().optional(),
}).passthrough();  // Allow additional unknown fields

// Usage in permissions.ts
const data = await response.json();
const validated = parseGraphResponse(
  GraphPermissionsResponseSchema,
  data,
  'Get Permissions'
);
```

### Schema Files

| File | Purpose |
|------|---------|
| `src/lib/microsoft/graph-schemas.ts` | Microsoft Graph API response schemas |
| `src/lib/microsoft/management-api-schemas.ts` | Office 365 Management API schemas |

### Validation Behavior

```typescript
// src/lib/microsoft/graph-schemas.ts

export function parseGraphResponse<T>(
  schema: z.ZodType<T>,
  data: unknown,
  context: string
): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    console.error(`[${context}] Schema validation failed:`, result.error.format());

    // Development: throw error to catch issues early
    if (process.env.NODE_ENV === 'development') {
      throw new Error(`${context} response validation failed`);
    }

    // Production: log and return raw data (graceful degradation)
    return data as T;
  }

  return result.data;
}
```

## Authentication Flow

### Azure AD App Registration

This API is called by the **auditsphere-spfx** web part running in SharePoint Online. Authentication is handled via Azure AD.

**Azure AD App:** Document Intelligence API

| Setting | Value |
|---------|-------|
| Client ID | `eca12ded-8416-41fd-ac0a-ffaccb1ecb04` |
| Application ID URI | `api://eca12ded-8416-41fd-ac0a-ffaccb1ecb04` |
| Exposed Scope | `access_as_user` |

> **Important:** The Application ID URI must use the `api://{client-id}` format. The API validates tokens against this format in `src/trpc/init.ts`.

### Deployment Branches

| Branch | API URL | Purpose |
|--------|---------|---------|
| `main` | `https://auditsphere-api.nubewired.com` | All features |
| `access-review` | `https://auditsphere-api-access.nubewired.com` | Access review only |

### Token Validation

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Authentication Flow                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. SPFx requests token from Azure AD                                   │
│     ┌─────────────┐         ┌─────────────────┐                        │
│     │   SPFx      │────────▶│   Azure AD      │                        │
│     │   Web Part  │◀────────│   (tenant)      │                        │
│     └─────────────┘  Token  └─────────────────┘                        │
│                                                                          │
│     Token claims:                                                        │
│     - aud: "eca12ded-8416-41fd-ac0a-ffaccb1ecb04" (client ID)          │
│     - scp: "access_as_user"                                             │
│     - preferred_username: "user@tenant.com"                             │
│                                                                          │
│  2. SPFx sends token to API                                             │
│     ┌─────────────┐         ┌─────────────────┐                        │
│     │   SPFx      │────────▶│   AuditSphere   │                        │
│     │   Web Part  │ Bearer  │   API           │                        │
│     └─────────────┘  Token  └─────────────────┘                        │
│                                                                          │
│  3. API validates token (src/trpc/init.ts)                              │
│     ┌─────────────────────────────────────────────────────────────┐    │
│     │ a. Fetch JWKS from Azure AD                                  │    │
│     │ b. Verify JWT signature (RS256)                              │    │
│     │ c. Check audience ∈ [CLIENT_ID, api://CLIENT_ID]            │    │
│     │ d. Check issuer matches tenant                               │    │
│     │ e. Extract user email → find/create user in database        │    │
│     └─────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Valid Audiences

The API accepts tokens with either audience format:

```typescript
// src/trpc/init.ts
const validAudiences = [
  process.env.MICROSOFT_CLIENT_ID,                    // eca12ded-8416-41fd-ac0a-ffaccb1ecb04
  `api://${process.env.MICROSOFT_CLIENT_ID}`,         // api://eca12ded-8416-41fd-ac0a-ffaccb1ecb04
];
```

SPFx uses `AadHttpClient.getClient(clientId)` which results in tokens with the raw client ID as the audience.

### Detailed SPFx-to-API Authentication Flow

This diagram shows the complete authentication flow from when the SPFx web part loads in SharePoint to when the API validates the request and returns data.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  SPFx WebPart   │     │     Azure AD     │     │   auditsphere-api   │
│  (SharePoint)   │     │                  │     │     (Railway)       │
└────────┬────────┘     └────────┬─────────┘     └──────────┬──────────┘
         │                       │                          │
         │  1. Request token     │                          │
         │     for resource:     │                          │
         │     eca12ded-8416-... │                          │
         │     scope:            │                          │
         │     access_as_user    │                          │
         │──────────────────────▶│                          │
         │                       │                          │
         │  2. Return JWT        │                          │
         │     aud: eca12ded-... │                          │
         │     scp: access_as_   │                          │
         │          user         │                          │
         │◀──────────────────────│                          │
         │                       │                          │
         │  3. Call API with Authorization: Bearer <token>  │
         │─────────────────────────────────────────────────▶│
         │                       │                          │
         │                       │  4. Fetch JWKS keys      │
         │                       │◀─────────────────────────│
         │                       │                          │
         │                       │  5. Return public keys   │
         │                       │─────────────────────────▶│
         │                       │                          │
         │                       │         6. Validate:     │
         │                       │         - JWT signature  │
         │                       │           (RS256)        │
         │                       │         - audience =     │
         │                       │           eca12ded-...   │
         │                       │         - issuer =       │
         │                       │           tenant ID      │
         │                       │         - not expired    │
         │                       │                          │
         │                       │         7. Extract user: │
         │                       │         - email from     │
         │                       │           preferred_     │
         │                       │           username       │
         │                       │         - id from oid    │
         │                       │                          │
         │                       │         8. Find/create   │
         │                       │            user in DB    │
         │                       │                          │
         │  9. Return data                                  │
         │◀─────────────────────────────────────────────────│
         │                       │                          │
```

**Key Points:**

1. **SPFx Permission Request**: The `webApiPermissionRequests` in `config/package-solution.json` declares that the SPFx solution needs access to the API:
   ```json
   "webApiPermissionRequests": [{
     "resource": "eca12ded-8416-41fd-ac0a-ffaccb1ecb04",
     "scope": "access_as_user"
   }]
   ```

2. **Admin Consent**: When the `.sppkg` is deployed, a SharePoint admin must approve this permission request in the SharePoint Admin Center → API Access.

3. **Token Acquisition**: SPFx uses `AadHttpClient` to silently acquire tokens:
   ```typescript
   const client = await this.context.aadHttpClientFactory.getClient('eca12ded-8416-41fd-ac0a-ffaccb1ecb04');
   const response = await client.get(apiUrl, AadHttpClient.configurations.v1);
   ```

4. **JWKS Caching**: The API caches Azure AD's public keys for 24 hours to avoid repeated JWKS fetches.

5. **User Auto-Creation**: If a valid token is received but the user doesn't exist in the database, they are automatically created with a default `viewer` role.

### Context Creation

```typescript
// src/trpc/init.ts

export async function createContext({ req }: { req: Request }) {
  const authHeader = req.headers.get('authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return { userId: null, tenantId: null, userEmail: null };
  }

  const token = authHeader.substring(7);

  try {
    // Validate with Azure AD JWKS
    const decoded = await validateAzureToken(token);

    return {
      userId: decoded.oid || decoded.sub,  // Object ID or Subject
      tenantId: decoded.tid,                // Tenant ID
      userEmail: decoded.upn || decoded.email,
    };
  } catch (error) {
    return { userId: null, tenantId: null, userEmail: null };
  }
}
```

### Protected Procedures

```typescript
// src/trpc/init.ts

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }
  return next({ ctx });
});
```

## Database Layer

### Prisma with Neon

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Prisma Architecture                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────────────┐   │
│  │   tRPC      │────▶│   Prisma    │────▶│   Neon PostgreSQL       │   │
│  │   Router    │     │   Client    │     │   (Serverless)          │   │
│  └─────────────┘     └─────────────┘     └─────────────────────────┘   │
│                             │                                            │
│                             ▼                                            │
│                      ┌─────────────┐                                    │
│                      │ Type-safe   │                                    │
│                      │ Queries     │                                    │
│                      │             │                                    │
│                      │ db.campaign │                                    │
│                      │   .findMany │                                    │
│                      │   .create   │                                    │
│                      │   .update   │                                    │
│                      └─────────────┘                                    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Models

```prisma
// prisma/schema.prisma

model AccessReviewCampaign {
  id                  String   @id @default(cuid())
  userId              String
  name                String
  siteUrl             String
  scope               String
  status              String   @default("draft")
  dueDate             DateTime
  autoRetainOnExpiry  Boolean  @default(false)
  items               AccessReviewItem[]
  createdAt           DateTime @default(now())
}

model AccessReviewItem {
  id            String   @id @default(cuid())
  campaignId    String
  resourceType  String   // 'file' | 'folder' | 'site'
  resourcePath  String
  permissionId  String
  principalType String   // 'user' | 'group' | 'link'
  principalName String
  accessLevel   String   // 'read' | 'write' | 'owner'
  decision      String?  // 'retain' | 'remove'
  decidedAt     DateTime?
  decidedBy     String?
  campaign      AccessReviewCampaign @relation(...)
}
```

## Microsoft API Integration

### API Clients

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   Microsoft API Client Layer                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     TokenManager                                 │   │
│  │  - Manages OAuth tokens (delegated & app-only)                  │   │
│  │  - Automatic token refresh                                       │   │
│  │  - Caching with expiration                                       │   │
│  └───────────────────────────┬─────────────────────────────────────┘   │
│                              │                                          │
│              ┌───────────────┴───────────────┐                         │
│              ▼                               ▼                          │
│  ┌─────────────────────────┐   ┌─────────────────────────────────┐    │
│  │   PermissionsClient     │   │   ManagementApiClient           │    │
│  │                         │   │                                  │    │
│  │   Graph API v1.0        │   │   O365 Management API            │    │
│  │   - Sites               │   │   - Audit subscriptions          │    │
│  │   - Drives              │   │   - Content blobs                │    │
│  │   - Permissions         │   │   - Audit events                 │    │
│  │   - Users/Groups        │   │                                  │    │
│  └─────────────────────────┘   └─────────────────────────────────┘    │
│              │                               │                          │
│              ▼                               ▼                          │
│  ┌─────────────────────────┐   ┌─────────────────────────────────┐    │
│  │   graph-schemas.ts      │   │   management-api-schemas.ts     │    │
│  │   (Zod validation)      │   │   (Zod validation)              │    │
│  └─────────────────────────┘   └─────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Token Flow

```typescript
// src/lib/microsoft/token-manager.ts

class TokenManager {
  // Delegated token (user context) - for user-specific operations
  async getValidToken(): Promise<ValidToken>

  // App-only token (application context) - for background jobs
  async getAppOnlyGraphToken(): Promise<string>

  // Management API token - for audit log access
  async getManagementApiToken(): Promise<string>
}
```

## Background Jobs

### Access Review Scheduler

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Scheduler Architecture                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Timer Trigger (every 5 minutes)                                        │
│              │                                                           │
│              ▼                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     runScheduler()                               │   │
│  └───────────────────────────┬─────────────────────────────────────┘   │
│                              │                                          │
│              ┌───────────────┼───────────────┐                         │
│              ▼               ▼               ▼                          │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐              │
│  │ checkDue      │  │ checkReminders│  │ checkOverdue  │              │
│  │ Schedules()   │  │ ()            │  │ Campaigns()   │              │
│  │               │  │               │  │               │              │
│  │ Create new    │  │ Send emails   │  │ Auto-retain   │              │
│  │ campaigns     │  │ at 7,3,1 days │  │ if configured │              │
│  │ from schedule │  │ before due    │  │               │              │
│  └───────────────┘  └───────────────┘  └───────────────┘              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Error Handling

### tRPC Error Codes

| Code | HTTP Status | When Used |
|------|-------------|-----------|
| `UNAUTHORIZED` | 401 | No valid token |
| `FORBIDDEN` | 403 | User lacks permission |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `BAD_REQUEST` | 400 | Validation failed |
| `INTERNAL_SERVER_ERROR` | 500 | Server error |

### Error Response Format

```typescript
// tRPC error response
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

## Type Export for Clients

### Sharing Types with SPFx

```typescript
// src/trpc/index.ts

import type { AppRouter } from './routers/_app';

// Export the router type for client consumption
export type { AppRouter };

// Client can import and use:
// import type { AppRouter } from '@auditsphere/api';
// const trpc = createTRPCProxyClient<AppRouter>({ ... });
```

## Development Workflow

### Adding a New Endpoint

1. **Define Zod schema** (if complex input)
```typescript
const CreateReviewSchema = z.object({
  name: z.string().min(1),
  siteUrl: z.string().url(),
});
```

2. **Add procedure to router**
```typescript
createReview: protectedProcedure
  .input(CreateReviewSchema)
  .mutation(async ({ ctx, input }) => {
    // Implementation
  }),
```

3. **Client gets types automatically**
```typescript
// In SPFx - types are inferred!
const result = await trpc.accessReview.createReview.mutate({
  name: "Q4 Review",
  siteUrl: "https://..."
});
```

### Testing Locally

```bash
# Start local development
npm run dev

# API available at
http://localhost:7071/api/trpc/*

# Health check
curl http://localhost:7071/api/health
```

## Security Considerations

1. **Token Validation**: All requests validated against Azure AD JWKS
2. **Input Validation**: Zod schemas prevent injection attacks
3. **Token Encryption**: Stored tokens encrypted with AES-256
4. **CORS**: Restricted to known origins
5. **Rate Limiting**: Prevents abuse (via Azure Functions limits)
6. **Audit Logging**: All operations logged with user context
