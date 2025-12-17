import { TokenManager } from './token-manager.js';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

interface EmailAttachment {
  name: string;
  contentType: string;
  contentBytes: string; // Base64 encoded
}

interface EmailMessage {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  bodyType?: 'html' | 'text';
  attachments?: EmailAttachment[];
}

/**
 * Microsoft Graph Email Client
 * Uses app-only permissions to send emails
 */
export class EmailClient {
  private tokenManager: TokenManager;

  constructor(userId: string, tenantId?: string) {
    this.tokenManager = new TokenManager(userId, tenantId);
  }

  /**
   * Send an email using Microsoft Graph API
   * Requires Mail.Send application permission
   */
  async sendEmail(
    fromEmail: string,
    message: EmailMessage
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const accessToken = await this.tokenManager.getAppOnlyGraphToken();

      const emailPayload = {
        message: {
          subject: message.subject,
          body: {
            contentType: message.bodyType || 'html',
            content: message.body,
          },
          toRecipients: message.to.map(email => ({
            emailAddress: { address: email },
          })),
          ccRecipients: message.cc?.map(email => ({
            emailAddress: { address: email },
          })) || [],
          attachments: message.attachments?.map(att => ({
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: att.name,
            contentType: att.contentType,
            contentBytes: att.contentBytes,
          })) || [],
        },
        saveToSentItems: true,
      };

      const response = await fetch(
        `${GRAPH_BASE_URL}/users/${fromEmail}/sendMail`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(emailPayload),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Graph API email error:', response.status, errorText);
        return {
          success: false,
          error: `Failed to send email: ${response.status} - ${errorText}`,
        };
      }

      return { success: true };
    } catch (error) {
      console.error('Email send error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Send access review report email with optional PDF attachment
   */
  async sendAccessReviewReport(
    fromEmail: string,
    toEmails: string[],
    campaignName: string,
    summary: {
      total: number;
      retained: number;
      removed: number;
      pending: number;
    },
    dashboardUrl: string,
    pdfBuffer?: Buffer
  ): Promise<{ success: boolean; error?: string }> {
    const htmlBody = this.generateAccessReviewEmailHtml(campaignName, summary, dashboardUrl);

    const attachments = pdfBuffer ? [
      {
        name: `Access_Review_Report_${campaignName.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
        contentType: 'application/pdf',
        contentBytes: pdfBuffer.toString('base64'),
      },
    ] : undefined;

    return this.sendEmail(fromEmail, {
      to: toEmails,
      subject: `Access Review Report: ${campaignName}`,
      body: htmlBody,
      bodyType: 'html',
      attachments,
    });
  }

  /**
   * Generate HTML email body for access review report
   */
  private generateAccessReviewEmailHtml(
    campaignName: string,
    summary: { total: number; retained: number; removed: number; pending: number },
    dashboardUrl: string
  ): string {
    const completionRate = summary.total > 0
      ? Math.round(((summary.retained + summary.removed) / summary.total) * 100)
      : 0;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #ea580c 0%, #f97316 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 24px; font-weight: 600;">Access Review Report</h1>
      <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 14px;">${campaignName}</p>
    </div>

    <!-- Content -->
    <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
      <!-- Progress Bar -->
      <div style="margin-bottom: 25px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span style="font-size: 14px; color: #6b7280;">Completion</span>
          <span style="font-size: 14px; font-weight: 600; color: #ea580c;">${completionRate}%</span>
        </div>
        <div style="background: #e5e7eb; border-radius: 9999px; height: 8px; overflow: hidden;">
          <div style="background: linear-gradient(90deg, #10b981 0%, #059669 100%); height: 100%; width: ${completionRate}%; border-radius: 9999px;"></div>
        </div>
      </div>

      <!-- Summary Cards -->
      <table width="100%" cellpadding="0" cellspacing="8" style="margin-bottom: 25px;">
        <tr>
          <td style="background: #f9fafb; border-radius: 8px; padding: 15px; text-align: center; width: 25%;">
            <div style="font-size: 28px; font-weight: 700; color: #111827;">${summary.total}</div>
            <div style="font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;">Total</div>
          </td>
          <td style="background: #dcfce7; border-radius: 8px; padding: 15px; text-align: center; width: 25%;">
            <div style="font-size: 28px; font-weight: 700; color: #166534;">${summary.retained}</div>
            <div style="font-size: 12px; color: #166534; text-transform: uppercase; letter-spacing: 0.5px;">Retained</div>
          </td>
          <td style="background: #fee2e2; border-radius: 8px; padding: 15px; text-align: center; width: 25%;">
            <div style="font-size: 28px; font-weight: 700; color: #991b1b;">${summary.removed}</div>
            <div style="font-size: 12px; color: #991b1b; text-transform: uppercase; letter-spacing: 0.5px;">Removed</div>
          </td>
          <td style="background: #fef3c7; border-radius: 8px; padding: 15px; text-align: center; width: 25%;">
            <div style="font-size: 28px; font-weight: 700; color: #92400e;">${summary.pending}</div>
            <div style="font-size: 12px; color: #92400e; text-transform: uppercase; letter-spacing: 0.5px;">Pending</div>
          </td>
        </tr>
      </table>

      <!-- Message -->
      <div style="background: #fff7ed; border-left: 4px solid #f97316; padding: 15px; border-radius: 0 8px 8px 0; margin-bottom: 25px;">
        <p style="margin: 0; color: #c2410c; font-size: 14px;">
          <strong>Review Summary</strong><br>
          This report summarizes the access review decisions made for this campaign.
        </p>
      </div>

      <!-- CTA Button -->
      <div style="text-align: center; margin-bottom: 25px;">
        <a href="${dashboardUrl}" style="display: inline-block; background: linear-gradient(135deg, #ea580c 0%, #f97316 100%); color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">View in Dashboard</a>
      </div>

      <!-- Footer -->
      <div style="text-align: center; padding-top: 20px; border-top: 1px solid #e5e7eb;">
        <p style="color: #9ca3af; font-size: 12px; margin: 0;">
          Generated by AuditSphere Access Review
        </p>
      </div>
    </div>
  </div>
</body>
</html>
`;
  }
}
