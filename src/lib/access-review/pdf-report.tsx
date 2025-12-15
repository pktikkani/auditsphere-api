import React from 'react';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';

// Styles for the PDF
const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: 'Helvetica',
  },
  header: {
    marginBottom: 20,
    borderBottomWidth: 2,
    borderBottomColor: '#ea580c',
    paddingBottom: 10,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#ea580c',
    marginBottom: 5,
  },
  subtitle: {
    fontSize: 12,
    color: '#6b7280',
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#ea580c',
    marginBottom: 10,
    paddingBottom: 5,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 15,
  },
  summaryCard: {
    width: '25%',
    padding: 10,
    backgroundColor: '#f9fafb',
    marginRight: 10,
    marginBottom: 10,
    borderRadius: 4,
  },
  summaryLabel: {
    fontSize: 9,
    color: '#6b7280',
    marginBottom: 2,
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#111827',
  },
  table: {
    width: '100%',
    marginTop: 10,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderBottomWidth: 1,
    borderBottomColor: '#d1d5db',
    paddingVertical: 8,
    paddingHorizontal: 5,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    paddingVertical: 6,
    paddingHorizontal: 5,
  },
  tableRowAlt: {
    backgroundColor: '#f9fafb',
  },
  colResource: { width: '30%' },
  colGrantedTo: { width: '25%' },
  colAccess: { width: '15%' },
  colDecision: { width: '15%' },
  colJustification: { width: '15%' },
  headerText: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#374151',
  },
  cellText: {
    fontSize: 8,
    color: '#4b5563',
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    alignSelf: 'flex-start',
  },
  badgeRetain: {
    backgroundColor: '#dcfce7',
    color: '#166534',
  },
  badgeRemove: {
    backgroundColor: '#fee2e2',
    color: '#991b1b',
  },
  badgePending: {
    backgroundColor: '#fef3c7',
    color: '#92400e',
  },
  footer: {
    position: 'absolute',
    bottom: 30,
    left: 40,
    right: 40,
    textAlign: 'center',
    color: '#9ca3af',
    fontSize: 8,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 10,
  },
  metadata: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 15,
    padding: 10,
    backgroundColor: '#f9fafb',
    borderRadius: 4,
  },
  metadataItem: {
    flex: 1,
  },
  metadataLabel: {
    fontSize: 8,
    color: '#6b7280',
  },
  metadataValue: {
    fontSize: 10,
    color: '#111827',
  },
});

interface ReportItem {
  resourceName: string;
  resourcePath: string;
  grantedTo: string | null;
  accessLevel: string;
  decision: {
    decision: string;
    justification: string | null;
  } | null;
}

interface ReportData {
  campaignName: string;
  campaignDescription: string | null;
  status: string;
  dueDate: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  items: ReportItem[];
  summary: {
    total: number;
    retained: number;
    removed: number;
    pending: number;
  };
  generatedAt: Date;
  generatedBy: string;
}

const AccessReviewReport: React.FC<{ data: ReportData }> = ({ data }) => {
  const formatDate = (date: Date | null) => {
    if (!date) return 'Not set';
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const getDecisionStyle = (decision: string | undefined) => {
    switch (decision) {
      case 'retain':
        return styles.badgeRetain;
      case 'remove':
        return styles.badgeRemove;
      default:
        return styles.badgePending;
    }
  };

  const getDecisionText = (decision: string | undefined) => {
    switch (decision) {
      case 'retain':
        return 'Retained';
      case 'remove':
        return 'Removed';
      default:
        return 'Pending';
    }
  };

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Access Review Report</Text>
          <Text style={styles.subtitle}>{data.campaignName}</Text>
        </View>

        {/* Metadata */}
        <View style={styles.metadata}>
          <View style={styles.metadataItem}>
            <Text style={styles.metadataLabel}>Status</Text>
            <Text style={styles.metadataValue}>{data.status.toUpperCase()}</Text>
          </View>
          <View style={styles.metadataItem}>
            <Text style={styles.metadataLabel}>Due Date</Text>
            <Text style={styles.metadataValue}>{formatDate(data.dueDate)}</Text>
          </View>
          <View style={styles.metadataItem}>
            <Text style={styles.metadataLabel}>Completed</Text>
            <Text style={styles.metadataValue}>{formatDate(data.completedAt)}</Text>
          </View>
          <View style={styles.metadataItem}>
            <Text style={styles.metadataLabel}>Generated</Text>
            <Text style={styles.metadataValue}>{formatDate(data.generatedAt)}</Text>
          </View>
        </View>

        {/* Summary Cards */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Summary</Text>
          <View style={styles.summaryGrid}>
            <View style={styles.summaryCard}>
              <Text style={styles.summaryLabel}>Total Items</Text>
              <Text style={styles.summaryValue}>{data.summary.total}</Text>
            </View>
            <View style={[styles.summaryCard, { backgroundColor: '#dcfce7' }]}>
              <Text style={styles.summaryLabel}>Retained</Text>
              <Text style={[styles.summaryValue, { color: '#166534' }]}>{data.summary.retained}</Text>
            </View>
            <View style={[styles.summaryCard, { backgroundColor: '#fee2e2' }]}>
              <Text style={styles.summaryLabel}>Removed</Text>
              <Text style={[styles.summaryValue, { color: '#991b1b' }]}>{data.summary.removed}</Text>
            </View>
            <View style={[styles.summaryCard, { backgroundColor: '#fef3c7' }]}>
              <Text style={styles.summaryLabel}>Pending</Text>
              <Text style={[styles.summaryValue, { color: '#92400e' }]}>{data.summary.pending}</Text>
            </View>
          </View>
        </View>

        {/* Items Table */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Review Items</Text>
          <View style={styles.table}>
            {/* Table Header */}
            <View style={styles.tableHeader}>
              <View style={styles.colResource}>
                <Text style={styles.headerText}>Resource</Text>
              </View>
              <View style={styles.colGrantedTo}>
                <Text style={styles.headerText}>Granted To</Text>
              </View>
              <View style={styles.colAccess}>
                <Text style={styles.headerText}>Access</Text>
              </View>
              <View style={styles.colDecision}>
                <Text style={styles.headerText}>Decision</Text>
              </View>
              <View style={styles.colJustification}>
                <Text style={styles.headerText}>Notes</Text>
              </View>
            </View>

            {/* Table Rows */}
            {data.items.slice(0, 50).map((item, index) => (
              <View
                key={index}
                style={[styles.tableRow, index % 2 === 1 ? styles.tableRowAlt : {}]}
              >
                <View style={styles.colResource}>
                  <Text style={styles.cellText}>{item.resourceName}</Text>
                </View>
                <View style={styles.colGrantedTo}>
                  <Text style={styles.cellText}>{item.grantedTo || 'Unknown'}</Text>
                </View>
                <View style={styles.colAccess}>
                  <Text style={styles.cellText}>{item.accessLevel}</Text>
                </View>
                <View style={styles.colDecision}>
                  <View style={[styles.badge, getDecisionStyle(item.decision?.decision)]}>
                    <Text style={{ fontSize: 8 }}>{getDecisionText(item.decision?.decision)}</Text>
                  </View>
                </View>
                <View style={styles.colJustification}>
                  <Text style={styles.cellText}>
                    {item.decision?.justification || '-'}
                  </Text>
                </View>
              </View>
            ))}
          </View>

          {data.items.length > 50 && (
            <Text style={{ marginTop: 10, color: '#6b7280', fontSize: 9 }}>
              Showing 50 of {data.items.length} items. Export CSV for complete data.
            </Text>
          )}
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <Text>
            Generated by AuditSphere | {formatDate(data.generatedAt)} | Generated by: {data.generatedBy}
          </Text>
        </View>
      </Page>
    </Document>
  );
};

/**
 * Generate PDF buffer from report data
 */
export async function generateAccessReviewPdf(data: ReportData): Promise<Buffer> {
  const buffer = await renderToBuffer(<AccessReviewReport data={data} />);
  return Buffer.from(buffer);
}

export type { ReportData, ReportItem };
