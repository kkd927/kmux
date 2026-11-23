// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  initializeFlowEditorDocument,
  starterWorkflowDefinition,
  type JsonValue,
  type WorkflowDraft
} from "@kmux/orchestration";
import { compileEditorCanonical } from "../workflowProjection";
import { useWorkflowDraft } from "./useWorkflowDraft";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Workflow draft editing", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useWorkflowDraft>;
  let original: Window["kmux"];
  let stored: WorkflowDraft;
  const definition = starterWorkflowDefinition({
    definitionId: "workflow:draft",
    name: "Original"
  });
  const rpc =
    vi.fn<
      (request: {
        method: string;
        params: Record<string, unknown>;
      }) => Promise<WorkflowDraft>
    >();
  const onCatalogChanged = async () => {};
  function Probe({ existing = true }: { existing?: boolean }) {
    current = useWorkflowDraft({
      draftId: stored.draftId,
      definitionId: stored.definitionId,
      existing,
      onCatalogChanged
    });
    return (
      <output>
        {current.definition?.name}:{current.dirty ? "unsaved" : "saved"}
      </output>
    );
  }
  beforeEach(() => {
    stored = {
      draftId: "draft:one",
      definitionId: definition.definitionId,
      revision: 1,
      canonicalDraft: definition as unknown as JsonValue,
      editorDocument: initializeFlowEditorDocument(
        definition
      ) as unknown as JsonValue,
      createdAt: "2026-10-09T00:00:00.000Z",
      updatedAt: "2026-10-09T00:00:00.000Z"
    };
    rpc.mockReset().mockImplementation(async (request) => {
      if (
        request.method === "workflow.draft.get" ||
        request.method === "workflow.draft.initialize"
      )
        return stored;
      stored = {
        ...stored,
        ...(request.method === "workflow.draft.create"
          ? {
              draftId: request.params.draftId as string,
              definitionId: request.params.definitionId as string
            }
          : {}),
        revision: stored.revision + 1,
        canonicalDraft: request.params.canonicalDraft as JsonValue,
        editorDocument: request.params.editorDocument as JsonValue
      };
      return stored;
    });
    original = window.kmux;
    window.kmux = { orchestration: rpc } as unknown as Window["kmux"];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.kmux = original;
  });

  it("preserves edits made during a save and saves them against the returned revision", async () => {
    await act(async () => root.render(<Probe />));
    const firstDocument = {
      ...current.editorDocument!,
      workflow: { ...current.editorDocument!.workflow, name: "First edit" }
    };
    await act(async () => current.updateDocument(firstDocument));
    let resolve!: (value: WorkflowDraft) => void;
    rpc.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    let save!: Promise<WorkflowDraft>;
    await act(async () => {
      save = current.save();
    });
    const nextDocument = {
      ...firstDocument,
      workflow: { ...firstDocument.workflow, name: "Second edit" }
    };
    await act(async () => current.updateDocument(nextDocument));
    await act(async () => {
      stored = {
        ...stored,
        revision: 2,
        canonicalDraft: compileEditorCanonical(
          firstDocument
        ) as unknown as JsonValue,
        editorDocument: firstDocument as unknown as JsonValue
      };
      resolve(stored);
      await save;
    });
    expect(container.textContent).toBe("Second edit:unsaved");
    await act(async () => {
      await current.ensureSaved();
    });
    expect(rpc.mock.calls.at(-1)?.[0].params.expectedRevision).toBe(2);
    expect(stored.canonicalDraft).toMatchObject({ name: "Second edit" });
    expect(container.textContent).toBe("Second edit:saved");
  });

  it("keeps unfinished JSON in the draft and prevents it from being submitted", async () => {
    await act(async () => root.render(<Probe />));
    await act(async () => current.editJsonText("{"));
    await expect(current.ensureSaved()).rejects.toThrow();
    expect(current.editorText).toBe("{");
    expect(current.dirty).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "preserves the target Workflow identity when importing JSON (existing=%s)",
    async (existing) => {
      await act(async () => root.render(<Probe existing={existing} />));
      const imported = {
        ...definition,
        definitionId: "workflow:imported",
        name: "Imported workflow"
      };
      await act(async () =>
        current.editJsonText(
          JSON.stringify(initializeFlowEditorDocument(imported))
        )
      );
      await act(async () => {
        current.applyRawJson();
      });
      await act(async () => {
        await current.ensureSaved();
      });
      expect(stored.definitionId).toBe(definition.definitionId);
      expect(stored.canonicalDraft).toEqual({
        ...imported,
        definitionId: stored.definitionId
      });
      expect(stored.editorDocument).toMatchObject({
        workflow: {
          definitionId: stored.definitionId,
          name: imported.name
        }
      });
    }
  );
});
