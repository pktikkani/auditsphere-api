# AuditSphere API Architecture

## Overview

AuditSphere API is a standalone tRPC-based API service designed to serve the AuditSphere SPFx web part deployed in SharePoint Online. It provides type-safe API endpoints with runtime validation for SharePoint security monitoring functionality.

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
└──────────────────┬──────────────────────────────┬───────────────────────┘
                   │                              │
                   ▼                              ▼
┌──────────────────────────────┐  ┌──────────────────────────────────────┐
│      Neon PostgreSQL         │  │        Microsoft APIs                 │
├──────────────────────────────┤  ├──────────────────────────────────────┤
│  - Users & connections       │  │  Microsoft Graph API                  │
│  - Audit events              │  │  - Sites, Drives, Permissions        │
│  - Compliance data           │  │  - Email (Mail.Send)                  │
│  - Alerts & anomalies        │  │                                       │
│                              │  │  Office 365 Management API            │
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
│   │ getById: t            │────────────▶│ const alert =         │       │
│   │   .input(z.object({   │  TypeScript │   await trpc          │       │
│   │     id: z.string()    │    Types    │     .alerts           │       │
│   │   }))                 │  (Inferred) │     .getById          │       │
│   │   .query(...)         │             │     .query({ id })    │       │
│   └───────────────────────┘             │                       │       │
│                                         │ // alert is fully     │       │
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
│ HTTP Request: POST /api/trpc/alerts.getById                             │
│ Body: {"json":{"id":"alert-123"}}                                       │
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
│                     (src/trpc/routers/alerts.ts)                        │
├─────────────────────────────────────────────────────────────────────────┤
│  1. protectedProcedure middleware checks ctx.userId                     │
│  2. Zod validates input: z.object({ id: z.string() })                   │
│  3. Execute query logic (database/API calls)                            │
│  4. Return typed response                                                │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ HTTP Response: {"result":{"data":{"json":{...alert data...}}}}          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Procedure Types

tRPC supports two procedure types:

| Type | HTTP Method | Purpose | Example |
|------|-------------|---------|---------|
| **Query** | GET | Read operations | `alerts.getById`, `anomalies.list` |
| **Mutation** | POST | Write operations | `alerts.updateStatus`, `compliance.run` |

```typescript
// Query - for reading data
getById: protectedProcedure
  .input(z.object({ id: z.string() }))
  .query(async ({ ctx, input }) => {
    return db.alert.findUnique({ where: { id: input.id } });
  }),

// Mutation - for writing data
updateStatus: protectedProcedure
  .input(z.object({ id: z.string(), status: z.enum(['NEW', 'RESOLVED']) }))
  .mutation(async ({ ctx, input }) => {
    return db.alert.update({ where: { id: input.id }, data: { status: input.status } });
  }),
```

### Router Structure

```
src/trpc/
├── init.ts              # tRPC initialization & context
├── index.ts             # Exports
└── routers/
    ├── _app.ts          # Root router (merges all routers)
    ├── alerts.ts        # Alert management
    ├── anomalies.ts     # Anomaly detection
    ├── auditEvents.ts   # Audit event queries
    ├── compliance.ts    # Compliance checks
    ├── dashboard.ts     # Dashboard statistics
    ├── microsoft.ts     # Microsoft connection
    ├── reports.ts       # Report generation
    ├── settings.ts      # App settings
    ├── sites.ts         # SharePoint sites
    └── user.ts          # User info
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
// src/trpc/routers/alerts.ts

list: protectedProcedure
  .input(
    z.object({
      page: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(100).default(20),
      severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
      status: z.enum(['NEW', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']).optional(),
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
    })
  )
  .query(async ({ ctx, input }) => {
    // input is fully typed and validated
    // TypeScript knows: input.page is number, input.severity is enum | undefined
  }),
```

### External API Response Validation

Microsoft API responses are validated at runtime:

```typescript
// src/lib/microsoft/graph-schemas.ts

export const GraphSiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  webUrl: z.string().url(),
}).passthrough();  // Allow additional unknown fields

// Usage
const data = await response.json();
const validated = parseGraphResponse(
  GraphSiteSchema,
  data,
  'Get Site'
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

### Deployment

| Branch | API URL | Features |
|--------|---------|----------|
| `main` | `https://auditsphere-api.nubewired.com` | Dashboard, Alerts, Anomalies, Compliance, Audit Events |

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
│                      │ db.alert    │                                    │
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

model Alert {
  id          String   @id @default(cuid())
  userId      String
  type        String   // 'ANOMALY' | 'COMPLIANCE' | 'SECURITY'
  severity    String   // 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  status      String   @default("NEW")  // 'NEW' | 'ACKNOWLEDGED' | 'RESOLVED'
  message     String
  createdAt   DateTime @default(now())
}

model Anomaly {
  id            String   @id @default(cuid())
  anomalyType   String
  anomalyScore  Float
  severity      String
  status        String   @default("NEW")
  auditEventId  String
  auditEvent    AuditEvent @relation(...)
  createdAt     DateTime @default(now())
}

model AuditEvent {
  id            String   @id @default(cuid())
  eventId       String   @unique
  operation     String
  userId        String?
  siteUrl       String?
  sourceFileName String?
  creationTime  DateTime
  anomalies     Anomaly[]
}

model ComplianceRun {
  id            String   @id @default(cuid())
  standardId    String
  status        String
  totalChecks   Int      @default(0)
  passedChecks  Int      @default(0)
  failedChecks  Int      @default(0)
  startedAt     DateTime @default(now())
  completedAt   DateTime?
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
│  │   GraphClient           │   │   ManagementApiClient           │    │
│  │                         │   │                                  │    │
│  │   Graph API v1.0        │   │   O365 Management API            │    │
│  │   - Sites               │   │   - Audit subscriptions          │    │
│  │   - Drives              │   │   - Content blobs                │    │
│  │   - Users/Groups        │   │   - Audit events                 │    │
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

## Error Handling

### tRPC Error Codes

| Code | HTTP Status | When Used |
|------|-------------|-----------|
| `UNAUTHORIZED` | 401 | No valid token |
| `FORBIDDEN` | 403 | User lacks permission |
| `NOT_FOUND` | 404 | Resource doesn't exist |
| `BAD_REQUEST` | 400 | Validation failed |
| `PRECONDITION_FAILED` | 412 | Prerequisites not met |
| `INTERNAL_SERVER_ERROR` | 500 | Server error |

### Error Response Format

```typescript
// tRPC error response
{
  "error": {
    "message": "Alert not found",
    "code": "NOT_FOUND",
    "data": {
      "code": "NOT_FOUND",
      "httpStatus": 404,
      "path": "alerts.getById"
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
const ListAlertsSchema = z.object({
  page: z.number().min(1).default(1),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
});
```

2. **Add procedure to router**
```typescript
list: protectedProcedure
  .input(ListAlertsSchema)
  .query(async ({ ctx, input }) => {
    // Implementation
  }),
```

3. **Client gets types automatically**
```typescript
// In SPFx - types are inferred!
const result = await trpc.alerts.list.query({
  page: 1,
  severity: 'HIGH'
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
