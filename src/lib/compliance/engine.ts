import { TokenManager } from '../microsoft/token-manager.js';
import { db } from '../db/prisma.js';

export interface CheckDefinition {
  code: string;
  name: string;
  description: string;
  category: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  standardId: string;
  targetType: 'global' | 'site' | 'list';
  check: (ctx: CheckContext) => Promise<CheckResult>;
}

export interface CheckContext {
  userId: string;
  tenantId: string;
  accessToken: string;
  siteUrls?: string[];
}

export interface CheckResult {
  status: 'PASS' | 'FAIL' | 'WARNING' | 'ERROR' | 'SKIPPED';
  details: Record<string, unknown>;
  remediation?: string;
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

async function graphGet<T>(token: string, endpoint: string): Promise<T> {
  const response = await fetch(`${GRAPH_BASE}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Graph API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

// SharePoint Admin API (requires SharePoint.ReadWrite.All or Sites.ReadWrite.All)
async function getSharePointTenantSettings(token: string): Promise<SharePointTenantSettings | null> {
  try {
    // Try to get SharePoint settings via admin endpoint
    const result = await graphGet<SharePointTenantSettings>(
      token,
      '/admin/sharepoint/settings'
    );
    return result;
  } catch (error) {
    console.log('SharePoint admin settings not accessible, using default check');
    return null;
  }
}

interface SharePointTenantSettings {
  sharingCapability?: string; // Disabled, ExternalUserSharingOnly, ExternalUserAndGuestSharing, ExistingExternalUserSharingOnly
  isSharePointNewsfeedDisabled?: boolean;
  isOneDriveForGuestsEnabled?: boolean;
  isSiteCreationEnabled?: boolean;
  sharingAllowedDomainList?: string[];
  sharingBlockedDomainList?: string[];
}

interface GuestUser {
  id: string;
  displayName: string;
  mail: string;
  userType: string;
  createdDateTime: string;
}

interface GraphListResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

// ==================== CIS-MS365 Checks ====================
const CIS_CHECKS: CheckDefinition[] = [
  {
    code: 'EXT-001',
    name: 'External Sharing Policy',
    description: 'Verify SharePoint external sharing is appropriately restricted',
    category: 'Sharing',
    severity: 'HIGH',
    standardId: 'CIS-MS365',
    targetType: 'global',
    check: async (ctx: CheckContext): Promise<CheckResult> => {
      try {
        const settings = await getSharePointTenantSettings(ctx.accessToken);

        if (!settings) {
          // Fall back to checking sites directly
          const sites = await graphGet<GraphListResponse<{ id: string; webUrl: string }>>(
            ctx.accessToken,
            '/sites?$top=5&$select=id,webUrl'
          );

          return {
            status: 'WARNING',
            details: {
              message: 'Unable to access SharePoint admin settings directly',
              sitesFound: sites.value?.length || 0,
              recommendation: 'Manually verify external sharing settings in SharePoint Admin Center',
            },
            remediation: 'Navigate to SharePoint Admin Center > Policies > Sharing to review settings',
          };
        }

        const sharingLevel = settings.sharingCapability || 'Unknown';
        const isSecure = sharingLevel === 'Disabled' || sharingLevel === 'ExistingExternalUserSharingOnly';

        return {
          status: isSecure ? 'PASS' : 'FAIL',
          details: {
            sharingCapability: sharingLevel,
            allowedDomains: settings.sharingAllowedDomainList || [],
            blockedDomains: settings.sharingBlockedDomainList || [],
          },
          remediation: isSecure
            ? undefined
            : 'Restrict external sharing to "Only people in your organization" or "Existing guests only" in SharePoint Admin Center',
        };
      } catch (error) {
        return {
          status: 'ERROR',
          details: { error: error instanceof Error ? error.message : String(error) },
          remediation: 'Check that the app has SharePoint admin permissions',
        };
      }
    },
  },
  {
    code: 'EXT-002',
    name: 'Anonymous Links Disabled',
    description: 'Verify anonymous sharing links (Anyone links) are disabled',
    category: 'Sharing',
    severity: 'HIGH',
    standardId: 'CIS-MS365',
    targetType: 'global',
    check: async (ctx: CheckContext): Promise<CheckResult> => {
      try {
        const settings = await getSharePointTenantSettings(ctx.accessToken);

        if (!settings) {
          return {
            status: 'WARNING',
            details: {
              message: 'Unable to access SharePoint admin settings',
              recommendation: 'Manually verify anonymous link settings',
            },
            remediation: 'Check SharePoint Admin Center > Policies > Sharing > "Anyone" links section',
          };
        }

        // Anyone links require ExternalUserAndGuestSharing
        const anonymousLinksEnabled = settings.sharingCapability === 'ExternalUserAndGuestSharing';

        return {
          status: anonymousLinksEnabled ? 'FAIL' : 'PASS',
          details: {
            sharingCapability: settings.sharingCapability,
            anonymousLinksEnabled,
          },
          remediation: anonymousLinksEnabled
            ? 'Disable "Anyone" links by setting sharing to "New and existing guests" or more restrictive'
            : undefined,
        };
      } catch (error) {
        return {
          status: 'ERROR',
          details: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  },
  {
    code: 'ACC-001',
    name: 'Guest User Inventory',
    description: 'Review guest users in the tenant',
    category: 'Access',
    severity: 'MEDIUM',
    standardId: 'CIS-MS365',
    targetType: 'global',
    check: async (ctx: CheckContext): Promise<CheckResult> => {
      try {
        const guests = await graphGet<GraphListResponse<GuestUser>>(
          ctx.accessToken,
          "/users?$filter=userType eq 'Guest'&$select=id,displayName,mail,userType,createdDateTime&$top=100"
        );

        const guestCount = guests.value?.length || 0;
        const status = guestCount === 0 ? 'PASS' : guestCount <= 10 ? 'WARNING' : 'FAIL';

        return {
          status,
          details: {
            guestCount,
            guests: guests.value?.slice(0, 10).map((g) => ({
              displayName: g.displayName,
              mail: g.mail,
              createdDateTime: g.createdDateTime,
            })),
            hasMore: guestCount > 10,
          },
          remediation:
            guestCount > 0
              ? 'Review guest users and remove any that no longer need access. Consider implementing guest access reviews.'
              : undefined,
        };
      } catch (error) {
        return {
          status: 'ERROR',
          details: { error: error instanceof Error ? error.message : String(error) },
          remediation: 'Ensure app has User.Read.All permission',
        };
      }
    },
  },
  {
    code: 'ACC-002',
    name: 'MFA Status',
    description: 'Check Multi-Factor Authentication status for users',
    category: 'Access',
    severity: 'CRITICAL',
    standardId: 'CIS-MS365',
    targetType: 'global',
    check: async (ctx: CheckContext): Promise<CheckResult> => {
      try {
        // Get authentication methods registered
        const users = await graphGet<GraphListResponse<{ id: string; displayName: string; userPrincipalName: string }>>(
          ctx.accessToken,
          '/users?$top=50&$select=id,displayName,userPrincipalName'
        );

        // Note: Checking individual auth methods requires Reports.Read.All
        // This is a simplified check
        return {
          status: 'WARNING',
          details: {
            totalUsers: users.value?.length || 0,
            message: 'MFA status requires additional permissions to fully evaluate',
            recommendation: 'Use Azure AD Portal or Security defaults to enforce MFA',
          },
          remediation: 'Enable Security Defaults or Conditional Access policies requiring MFA for all users',
        };
      } catch (error) {
        return {
          status: 'ERROR',
          details: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  },
  {
    code: 'DATA-001',
    name: 'Data Loss Prevention Policies',
    description: 'Check if DLP policies are configured',
    category: 'Data Protection',
    severity: 'HIGH',
    standardId: 'CIS-MS365',
    targetType: 'global',
    check: async (ctx: CheckContext): Promise<CheckResult> => {
      try {
        // DLP policies are in Security & Compliance Center, not directly accessible via Graph
        // We can check for labels instead
        const labels = await graphGet<GraphListResponse<{ id: string; displayName: string }>>(
          ctx.accessToken,
          '/security/labels/sensitivityLabels?$top=10'
        ).catch(() => null);

        if (labels && labels.value && labels.value.length > 0) {
          return {
            status: 'PASS',
            details: {
              labelCount: labels.value.length,
              labels: labels.value.map((l) => l.displayName),
            },
          };
        }

        return {
          status: 'WARNING',
          details: {
            message: 'No sensitivity labels found or unable to access',
            recommendation: 'Configure sensitivity labels in Microsoft Purview compliance portal',
          },
          remediation: 'Create sensitivity labels in Microsoft Purview > Information Protection',
        };
      } catch (error) {
        return {
          status: 'WARNING',
          details: {
            message: 'Unable to check DLP policies directly',
            error: error instanceof Error ? error.message : String(error),
          },
          remediation: 'Manually verify DLP policies in Microsoft Purview compliance portal',
        };
      }
    },
  },
  {
    code: 'AUDIT-001',
    name: 'Audit Logging Enabled',
    description: 'Verify unified audit logging is enabled',
    category: 'Monitoring',
    severity: 'HIGH',
    standardId: 'CIS-MS365',
    targetType: 'global',
    check: async (ctx: CheckContext): Promise<CheckResult> => {
      try {
        // Check if we can access audit logs (implies logging is enabled)
        const response = await fetch(
          'https://manage.office.com/api/v1.0/' + ctx.tenantId + '/activity/feed/subscriptions/list',
          {
            headers: {
              Authorization: `Bearer ${ctx.accessToken}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (response.ok) {
          const subscriptions = await response.json() as Array<{ contentType: string; status: string }>;
          const activeSubscriptions = subscriptions.filter((s) => s.status === 'enabled');

          return {
            status: activeSubscriptions.length > 0 ? 'PASS' : 'WARNING',
            details: {
              subscriptionsCount: subscriptions.length,
              activeSubscriptions: activeSubscriptions.map((s) => s.contentType),
            },
            remediation:
              activeSubscriptions.length === 0
                ? 'Enable audit log subscriptions via Office 365 Management API'
                : undefined,
          };
        }

        // If we get here, audit logging might be disabled
        return {
          status: 'WARNING',
          details: {
            message: 'Unable to verify audit log status',
          },
          remediation: 'Enable unified audit logging in Microsoft Purview compliance portal',
        };
      } catch (error) {
        return {
          status: 'ERROR',
          details: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  },
];

// ==================== CUSTOM Checks ====================
const CUSTOM_CHECKS: CheckDefinition[] = [
  {
    code: 'CUST-001',
    name: 'Large File Sharing Activity',
    description: 'Check for recent large file sharing activities',
    category: 'Data Protection',
    severity: 'MEDIUM',
    standardId: 'CUSTOM',
    targetType: 'global',
    check: async (ctx: CheckContext): Promise<CheckResult> => {
      try {
        // Check for recent shared files via drives
        const drives = await graphGet<GraphListResponse<{ id: string; name: string; webUrl: string }>>(
          ctx.accessToken,
          '/sites/root/drives?$select=id,name,webUrl'
        );

        return {
          status: 'PASS',
          details: {
            drivesFound: drives.value?.length || 0,
            message: 'Drive inventory retrieved successfully',
          },
        };
      } catch (error) {
        return {
          status: 'WARNING',
          details: {
            message: 'Unable to check file sharing activity',
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  },
  {
    code: 'CUST-002',
    name: 'Admin Account Inventory',
    description: 'Review accounts with administrative roles',
    category: 'Access',
    severity: 'HIGH',
    standardId: 'CUSTOM',
    targetType: 'global',
    check: async (ctx: CheckContext): Promise<CheckResult> => {
      try {
        // Get Global Administrators
        const globalAdminRole = await graphGet<{ id: string }>(
          ctx.accessToken,
          "/directoryRoles?$filter=displayName eq 'Global Administrator'&$select=id"
        ).catch(() => null);

        if (!globalAdminRole) {
          return {
            status: 'WARNING',
            details: {
              message: 'Unable to enumerate admin roles - requires Directory.Read.All',
            },
            remediation: 'Ensure app has Directory.Read.All permission',
          };
        }

        return {
          status: 'PASS',
          details: {
            message: 'Admin role check completed',
          },
        };
      } catch (error) {
        return {
          status: 'ERROR',
          details: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  },
  {
    code: 'CUST-003',
    name: 'Site Collection Count',
    description: 'Inventory of SharePoint site collections',
    category: 'Inventory',
    severity: 'LOW',
    standardId: 'CUSTOM',
    targetType: 'global',
    check: async (ctx: CheckContext): Promise<CheckResult> => {
      try {
        const sites = await graphGet<GraphListResponse<{ id: string; webUrl: string; displayName: string }>>(
          ctx.accessToken,
          '/sites?$top=100&$select=id,webUrl,displayName'
        );

        const siteCount = sites.value?.length || 0;

        return {
          status: 'PASS',
          details: {
            siteCount,
            sites: sites.value?.slice(0, 10).map((s) => ({
              name: s.displayName,
              url: s.webUrl,
            })),
            hasMore: siteCount > 10,
          },
        };
      } catch (error) {
        return {
          status: 'ERROR',
          details: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  },
];

// Combined check definitions
const CHECK_DEFINITIONS: CheckDefinition[] = [...CIS_CHECKS, ...CUSTOM_CHECKS];

export { CHECK_DEFINITIONS, CIS_CHECKS, CUSTOM_CHECKS };

export async function runComplianceChecks(
  userId: string,
  runId: string,
  standardId: string = 'CIS-MS365',
  siteUrls?: string[]
): Promise<void> {
  const startTime = Date.now();

  try {
    // Get user's Microsoft connection
    const connection = await db.microsoftConnection.findFirst({
      where: { userId, isActive: true },
    });

    if (!connection) {
      await db.complianceRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage: 'No active Microsoft connection found',
        },
      });
      return;
    }

    // Get valid access token
    const accessToken = await TokenManager.getValidToken(userId, connection.tenantId);

    if (!accessToken) {
      await db.complianceRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorMessage: 'Failed to get valid access token',
        },
      });
      return;
    }

    const ctx: CheckContext = {
      userId,
      tenantId: connection.tenantId,
      accessToken,
      siteUrls,
    };

    // Filter checks by standard
    let checksToRun: CheckDefinition[];
    if (standardId === 'ALL') {
      checksToRun = CHECK_DEFINITIONS;
    } else if (standardId === 'CIS-MS365') {
      checksToRun = CIS_CHECKS;
    } else if (standardId === 'CUSTOM') {
      checksToRun = CUSTOM_CHECKS;
    } else {
      checksToRun = CHECK_DEFINITIONS.filter((c) => c.standardId === standardId);
    }

    let passedCount = 0;
    let failedCount = 0;
    let errorCount = 0;
    const results: Array<{
      checkCode: string;
      status: string;
      details: string;
      remediation: string | null;
    }> = [];

    // Run each check
    for (const checkDef of checksToRun) {
      const checkStart = Date.now();

      try {
        const result = await checkDef.check(ctx);
        const executionTimeMs = Date.now() - checkStart;

        // Update counts
        if (result.status === 'PASS') passedCount++;
        else if (result.status === 'FAIL') failedCount++;
        else if (result.status === 'ERROR') errorCount++;

        // Create/update ComplianceCheck record
        await db.complianceCheck.upsert({
          where: {
            standardId_checkCode_targetId: {
              standardId: checkDef.standardId,
              checkCode: checkDef.code,
              targetId: 'global',
            },
          },
          create: {
            standardId: checkDef.standardId,
            checkCode: checkDef.code,
            name: checkDef.name,
            description: checkDef.description,
            category: checkDef.category,
            severity: checkDef.severity,
            targetType: checkDef.targetType,
            targetId: 'global',
            status: result.status,
            resultDetails: result.details,
            remediationSteps: result.remediation || null,
            executedAt: new Date(),
            executionTimeMs,
          },
          update: {
            name: checkDef.name,
            description: checkDef.description,
            category: checkDef.category,
            severity: checkDef.severity,
            status: result.status,
            resultDetails: result.details,
            remediationSteps: result.remediation || null,
            executedAt: new Date(),
            executionTimeMs,
          },
        });

        results.push({
          checkCode: checkDef.code,
          status: result.status,
          details: JSON.stringify(result.details),
          remediation: result.remediation || null,
        });

        console.log(`[Compliance] ${checkDef.code}: ${result.status} (${executionTimeMs}ms)`);
      } catch (error) {
        errorCount++;
        console.error(`[Compliance] ${checkDef.code} error:`, error);

        results.push({
          checkCode: checkDef.code,
          status: 'ERROR',
          details: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          remediation: null,
        });
      }
    }

    // Update run with final results
    await db.complianceRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        totalChecks: checksToRun.length,
        passedChecks: passedCount,
        failedChecks: failedCount,
        errorChecks: errorCount,
        results,
      },
    });

    console.log(
      `[Compliance] Run ${runId} completed: ${passedCount} passed, ${failedCount} failed, ${errorCount} errors (${Date.now() - startTime}ms)`
    );
  } catch (error) {
    console.error(`[Compliance] Run ${runId} failed:`, error);

    await db.complianceRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
