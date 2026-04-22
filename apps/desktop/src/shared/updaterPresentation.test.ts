import { describe, expect, it } from "vitest";

import type { UpdaterState } from "@kmux/proto";

import {
  getTitlebarUpdaterAction,
  getUpdaterMenuLabel
} from "./updaterPresentation";

describe("updater presentation helpers", () => {
  it("keeps menu labels aligned with updater state", () => {
    expect(getUpdaterMenuLabel({ status: "idle" })).toBe(
      "Check for Updates…"
    );
    expect(getUpdaterMenuLabel({ status: "checking" })).toBe(
      "Checking for Updates…"
    );
    expect(getUpdaterMenuLabel({ status: "available", version: "0.2.3" })).toBe(
      "Download Update 0.2.3…"
    );
    expect(
      getUpdaterMenuLabel({ status: "downloading", version: "0.2.3" })
    ).toBe("Downloading Update 0.2.3…");
    expect(
      getUpdaterMenuLabel({ status: "downloaded", version: "0.2.3" })
    ).toBe("Install Update 0.2.3 and Relaunch…");
    expect(
      getUpdaterMenuLabel({ status: "error", errorMessage: "boom" })
    ).toBe("Check for Updates…");
  });

  it("shows titlebar CTA only for available, downloading, and downloaded states", () => {
    const hiddenStates: UpdaterState[] = [
      { status: "disabled" },
      { status: "idle" },
      { status: "checking" },
      { status: "error", errorMessage: "boom" }
    ];

    for (const state of hiddenStates) {
      expect(getTitlebarUpdaterAction(state)).toBeNull();
    }

    expect(
      getTitlebarUpdaterAction({ status: "available", version: "0.2.3" })
    ).toMatchObject({
      action: "download",
      label: "Update",
      disabled: false,
      prominent: true,
      title: "Update to version 0.2.3",
      ariaLabel: "Update to version 0.2.3"
    });
    expect(
      getTitlebarUpdaterAction({ status: "downloading", version: "0.2.3" })
    ).toMatchObject({
      action: "download",
      label: "Downloading...",
      disabled: true,
      progress: "indefinite",
      title: "Downloading update 0.2.3",
      ariaLabel: "Downloading update 0.2.3"
    });
    expect(
      getTitlebarUpdaterAction({ status: "downloaded", version: "0.2.3" })
    ).toMatchObject({
      action: "install",
      label: "Update",
      disabled: false,
      prominent: true,
      title: "Restart to install version 0.2.3",
      ariaLabel: "Restart to install version 0.2.3"
    });
  });
});
