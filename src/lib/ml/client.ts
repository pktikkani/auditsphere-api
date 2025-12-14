const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000';

export interface AuditEventInput {
  event_id: string;
  creation_time: string;
  operation: string;
  user_id?: string | null;
  user_type?: number | null;
  site_url?: string | null;
  source_file_name?: string | null;
  client_ip?: string | null;
  raw_event?: Record<string, unknown>;
  // Historical context
  event_count_1h?: number;
  event_count_24h?: number;
  unique_sites_24h?: number;
  unique_ops_24h?: number;
  events_last_5min?: number;
  is_new_ip?: boolean;
  unusual_location?: boolean;
}

export interface AnomalyDetectionResult {
  event_id: string;
  is_anomaly: boolean;
  anomaly_score: number;
  confidence: number;
  anomaly_type: string | null;
  features_used: Record<string, number>;
}

export interface BatchDetectionResponse {
  results: AnomalyDetectionResult[];
  total_events: number;
  anomalies_detected: number;
  processing_time_ms: number;
}

export interface ModelStatus {
  model_loaded: boolean;
  model_path: string;
  last_trained: string | null;
  n_estimators: number;
  contamination: number;
  training_samples: number | null;
}

export interface TrainingResponse {
  status: string;
  event_count: number;
  message: string;
}

/**
 * Detect anomalies in a batch of audit events
 */
export async function detectAnomalies(
  events: AuditEventInput[]
): Promise<BatchDetectionResponse> {
  const response = await fetch(`${ML_SERVICE_URL}/api/v1/anomaly/detect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ events })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ML service error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<BatchDetectionResponse>;
}

/**
 * Score a single audit event for anomaly detection
 */
export async function scoreEvent(
  event: AuditEventInput
): Promise<AnomalyDetectionResult> {
  const response = await fetch(`${ML_SERVICE_URL}/api/v1/anomaly/score`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ML service error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<AnomalyDetectionResult>;
}

/**
 * Train or retrain the anomaly detection model
 */
export async function trainModel(
  events: AuditEventInput[]
): Promise<TrainingResponse> {
  const response = await fetch(`${ML_SERVICE_URL}/api/v1/anomaly/train`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ events })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ML service error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<TrainingResponse>;
}

/**
 * Get current model status
 */
export async function getModelStatus(): Promise<ModelStatus> {
  const response = await fetch(`${ML_SERVICE_URL}/api/v1/anomaly/model/status`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ML service error: ${response.status} - ${error}`);
  }

  return response.json() as Promise<ModelStatus>;
}

/**
 * Check if ML service is healthy
 */
export async function checkHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${ML_SERVICE_URL}/api/v1/health`, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}
