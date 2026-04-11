import { expect, test } from "@playwright/test";

import { closeKmux, dispatch, launchKmux, waitForView } from "./helpers";

test("workspace sidebar context menu exposes key cmux-style management actions", async () => {
  const launched = await launchKmux("kmux-e2e-workspace-context-menu-");

  try {
    const page = launched.page;

    await dispatch(page, { type: "workspace.create", name: "alpha" });
    await dispatch(page, { type: "workspace.create", name: "beta" });
    await dispatch(page, { type: "workspace.create", name: "gamma" });

    const seeded = await waitForView(
      page,
      (view) =>
        view.workspaceRows.length >= 4 &&
        view.workspaceRows.some((row) => row.name === "hq") &&
        view.workspaceRows.some((row) => row.name === "alpha") &&
        view.workspaceRows.some((row) => row.name === "beta") &&
        view.workspaceRows.some((row) => row.name === "gamma"),
      "workspace fixtures should be visible before opening the context menu"
    );

    const betaId = seeded.workspaceRows.find(
      (row) => row.name === "beta"
    )?.workspaceId;
    const hqId = seeded.workspaceRows.find(
      (row) => row.name === "hq"
    )?.workspaceId;
    expect(betaId).toBeTruthy();
    expect(hqId).toBeTruthy();

    const betaRow = page.locator(`[data-workspace-id="${betaId!}"]`);
    await betaRow.click({ button: "right" });
    await expect(
      page.getByRole("menu", { name: "Workspace menu for beta" })
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Close Workspaces Above" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: "Close Workspaces Below" })
    ).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Rename Workspace…" }).click();

    const betaRenameInput = page.locator(
      `[data-workspace-id="${betaId!}"] input`
    );
    await expect(betaRenameInput).toBeFocused();
    await betaRenameInput.fill("ops");
    await betaRenameInput.press("Enter");

    await waitForView(
      page,
      (view) =>
        view.workspaceRows.some(
          (row) => row.workspaceId === betaId && row.name === "ops"
        ),
      "rename workspace should update the workspace row name"
    );

    await betaRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin Workspace" }).click();

    await waitForView(
      page,
      (view) =>
        view.workspaceRows.some(
          (row) => row.workspaceId === betaId && row.pinned
        ),
      "pin workspace should toggle pinned state from the context menu"
    );
    await expect(betaRow.getByText("PIN")).toBeVisible();

    await betaRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to Top" }).click();

    await waitForView(
      page,
      (view) => view.workspaceRows[0]?.workspaceId === betaId,
      "move to top should reorder the workspace row"
    );

    const hqRow = page.locator(`[data-workspace-id="${hqId!}"]`);
    await hqRow.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Close Workspace", exact: true })
      .click();

    await waitForView(
      page,
      (view) => view.workspaceRows.every((row) => row.workspaceId !== hqId),
      "close workspace should remove the targeted workspace row"
    );

    await betaRow.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Close Other Workspaces" })
      .click();

    await waitForView(
      page,
      (view) =>
        view.workspaceRows.length === 1 &&
        view.workspaceRows[0]?.workspaceId === betaId &&
        view.activeWorkspace.id === betaId,
      "close other workspaces should keep only the selected workspace"
    );
  } finally {
    await closeKmux(launched);
  }
});
