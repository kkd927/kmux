import { useCallback, useReducer } from "react";

import type { Id } from "@kmux/proto";

const WEBGL_LRU_SIZE = 10;

interface LruState {
  mostRecent: Id[];
}

type LruAction =
  | { type: "touch"; paneId: Id }
  | { type: "touchMany"; paneIds: Id[] }
  | { type: "forget"; paneId: Id };

function lruReducer(state: LruState, action: LruAction): LruState {
  switch (action.type) {
    case "touch": {
      const filtered = state.mostRecent.filter((id) => id !== action.paneId);
      const next = [action.paneId, ...filtered].slice(0, WEBGL_LRU_SIZE);
      return next.length === state.mostRecent.length &&
        next.every((id, i) => id === state.mostRecent[i])
        ? state
        : { mostRecent: next };
    }
    case "touchMany": {
      const incoming = [...new Set(action.paneIds)].slice(0, WEBGL_LRU_SIZE);
      const filtered = state.mostRecent.filter((id) => !incoming.includes(id));
      const next = [...incoming, ...filtered].slice(0, WEBGL_LRU_SIZE);
      return next.length === state.mostRecent.length &&
        next.every((id, i) => id === state.mostRecent[i])
        ? state
        : { mostRecent: next };
    }
    case "forget": {
      const next = state.mostRecent.filter((id) => id !== action.paneId);
      return next.length === state.mostRecent.length
        ? state
        : { mostRecent: next };
    }
  }
}

export interface WebglLru {
  isPaneWebglEnabled: (paneId: Id) => boolean;
  touch: (paneId: Id) => void;
  touchMany: (paneIds: Id[]) => void;
  forget: (paneId: Id) => void;
}

export function useWebglLru(): WebglLru {
  const [state, dispatch] = useReducer(lruReducer, { mostRecent: [] });

  const enabledSet = new Set(state.mostRecent);

  const isPaneWebglEnabled = useCallback(
    (paneId: Id) => enabledSet.has(paneId),
    [state.mostRecent]
  );

  const touch = useCallback((paneId: Id) => {
    dispatch({ type: "touch", paneId });
  }, []);

  const touchMany = useCallback((paneIds: Id[]) => {
    dispatch({ type: "touchMany", paneIds });
  }, []);

  const forget = useCallback((paneId: Id) => {
    dispatch({ type: "forget", paneId });
  }, []);

  return { isPaneWebglEnabled, touch, touchMany, forget };
}
