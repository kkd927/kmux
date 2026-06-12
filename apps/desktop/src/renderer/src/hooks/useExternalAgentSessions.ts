import { useCallback, useEffect, useRef, useState } from "react";

import type { ExternalAgentSessionsSnapshot } from "@kmux/proto";

const EMPTY_EXTERNAL_SESSIONS: ExternalAgentSessionsSnapshot = {
  sessions: [],
  updatedAt: ""
};
export const EXTERNAL_SESSIONS_REFRESH_MS = 60_000;

export function useExternalAgentSessions(): {
  snapshot: ExternalAgentSessionsSnapshot;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<ExternalAgentSessionsSnapshot>(
    EMPTY_EXTERNAL_SESSIONS
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(
    async (options: { showLoading?: boolean } = {}) => {
      if (refreshInFlightRef.current) {
        return refreshInFlightRef.current;
      }
      const showLoading = options.showLoading ?? true;
      if (showLoading) {
        setLoading(true);
      }
      setError(null);
      const refreshPromise = (async () => {
        try {
          const nextSnapshot = await window.kmux.getExternalAgentSessions();
          if (mountedRef.current) {
            setSnapshot(nextSnapshot);
          }
        } catch (caught) {
          if (mountedRef.current) {
            setError(
              caught instanceof Error ? caught.message : "Sessions unavailable"
            );
          }
        } finally {
          if (mountedRef.current && showLoading) {
            setLoading(false);
          }
          refreshInFlightRef.current = null;
        }
      })();
      refreshInFlightRef.current = refreshPromise;
      return refreshPromise;
    },
    []
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    const refreshTimer = setInterval(() => {
      void refresh({ showLoading: false });
    }, EXTERNAL_SESSIONS_REFRESH_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(refreshTimer);
    };
  }, [refresh]);

  return { snapshot, loading, error, refresh };
}
