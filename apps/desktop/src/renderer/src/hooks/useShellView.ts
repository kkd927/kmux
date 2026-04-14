import { useEffect, useState } from "react";

import type { ShellViewModel } from "@kmux/proto";

export function useShellView(): ShellViewModel | null {
  const [view, setView] = useState<ShellViewModel | null>(null);

  useEffect(() => {
    let active = true;
    let subscriptionDeliveredView = false;

    const unsubscribe = window.kmux.subscribeView((nextView) => {
      subscriptionDeliveredView = true;
      setView(nextView);
    });

    void window.kmux.getView().then((nextView) => {
      if (active && !subscriptionDeliveredView) {
        setView(nextView);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return view;
}
