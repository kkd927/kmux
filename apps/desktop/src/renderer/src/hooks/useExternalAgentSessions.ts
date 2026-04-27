import { useCallback, useEffect, useState } from "react";

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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.kmux.getExternalAgentSessions());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sessions unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { snapshot, loading, error, refresh };
}
