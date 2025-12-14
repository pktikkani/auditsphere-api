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
- Audience: Your Microsoft Client ID
- Issuer: Your Microsoft Tenant

## Project Structure

```
auditsphere-api/
├── src/
│   ├── functions/
│   │   └── trpc.ts          # Azure Function handler
│   ├── trpc/
│   │   ├── init.ts          # tRPC initialization & auth
│   │   ├── index.ts         # Exports
│   │   └── routers/         # tRPC routers
│   │       ├── _app.ts      # Root router
│   │       ├── dashboard.ts
│   │       ├── auditEvents.ts
│   │       ├── anomalies.ts
│   │       ├── compliance.ts
│   │       ├── alerts.ts
│   │       ├── reports.ts
│   │       ├── microsoft.ts
│   │       ├── sites.ts
│   │       └── settings.ts
│   └── lib/
│       └── db/
│           └── prisma.ts    # Database client
├── prisma/
│   └── schema.prisma        # Database schema
├── host.json                # Azure Functions config
├── local.settings.json      # Local environment (gitignored)
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
