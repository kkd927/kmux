import { useCallback, useEffect, useRef, useState } from "react";

import type { ExternalAgentSessionsSnapshot } from "@kmux/proto";

const EMPTY_EXTERNAL_SESSIONS: ExternalAgentSessionsSnapshot = {
  sessions: [],
  updatedAt: ""
};

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

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      return refreshInFlightRef.current;
    }
    setLoading(true);
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
        if (mountedRef.current) {
          setLoading(false);
        }
        refreshInFlightRef.current = null;
      }
    })();
    refreshInFlightRef.current = refreshPromise;
    return refreshPromise;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { snapshot, loading, error, refresh };
}
