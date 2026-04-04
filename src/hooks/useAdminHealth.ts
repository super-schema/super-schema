/**
 * Admin Health hooks — wrappers for health monitoring oRPC calls.
 */

import { useState, useCallback } from "react";
import type { HealthCheckResponse, UsageMetrics, ActivityMetrics, ErrorSummary } from "@/types/schemas/health";

export function useAdminHealth() {
  const [healthCheck, setHealthCheck] = useState<HealthCheckResponse | null>(null);
  const [usageMetrics, setUsageMetrics] = useState<UsageMetrics | null>(null);
  const [activityMetrics, setActivityMetrics] = useState<ActivityMetrics | null>(null);
  const [errorSummary, setErrorSummary] = useState<ErrorSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runHealthCheck = useCallback(async () => {
    setLoading(true);
    try {
      // In production: call oRPC admin.health.runCheck
      setHealthCheck(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Health check failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // In production: call all oRPC admin.health queries
      await Promise.all([
        // admin.health.usageMetrics
        // admin.health.activityMetrics
        // admin.health.errorSummary
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    healthCheck, usageMetrics, activityMetrics, errorSummary,
    loading, error, runHealthCheck, refresh,
  };
}
