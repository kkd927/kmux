import { orchestration } from "../orchestrationClient";
import {
  type FlowEditorDocumentV1,
  type JsonValue,
  type WorkflowDraft
} from "@kmux/orchestration";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkflowJsonDrafts } from "../components/WorkflowJsonField";
import {
  compileEditorCanonical,
  sameWorkflowExecution
} from "../workflowProjection";
import {
  type DraftValidation,
  asEditorDocument,
  pretty,
  asWorkflowDefinition,
  errorMessage
} from "../components/workflowUi";
export function useWorkflowDraft(props: {
  draftId: string;
  definitionId: string;
  existing: boolean;
  templateId?: string;
  onCatalogChanged: () => Promise<void>;
}) {
  const jsonDrafts = useWorkflowJsonDrafts();

  const [draft, setDraft] = useState<WorkflowDraft | null>(null);

  const [canonicalValue, setCanonicalValue] = useState<JsonValue | null>(null);

  const [editorValue, setEditorValue] = useState<JsonValue | null>(null);

  const [canvasRevision, setCanvasRevision] = useState(0);

  const [validation, setValidation] = useState<DraftValidation | null>(null);

  const [jsonDirty, setJsonDirty] = useState(false);

  const [editorText, setEditorText] = useState("");

  const [dirty, setDirty] = useState(false);

  const [notice, setNotice] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

  const draftRef = useRef<WorkflowDraft | null>(null);

  const dirtyRef = useRef(false);

  const editRevisionRef = useRef(0);

  const saveInFlightRef = useRef<Promise<WorkflowDraft> | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      if (props.existing) {
        const next = await orchestration("workflow.draft.get", {
          draftId: props.draftId
        });
        if (generation !== loadGeneration.current) return;
        draftRef.current = next;
        setDraft(next);
        const source = asEditorDocument(next.editorDocument);
        const document = source;
        setCanonicalValue(
          document
            ? (compileEditorCanonical(document) as unknown as JsonValue)
            : next.canonicalDraft
        );
        setEditorValue(
          (document as unknown as JsonValue) ?? next.editorDocument
        );
        setEditorText(pretty(document ?? next.editorDocument));
        setJsonDirty(false);
        const original = asWorkflowDefinition(next.canonicalDraft);
        const needsSync = Boolean(
          document &&
          (!original ||
            !sameWorkflowExecution(compileEditorCanonical(document), original))
        );
        dirtyRef.current = needsSync;
        setDirty(needsSync);
      } else {
        draftRef.current = null;
        const initial = await orchestration(
          props.templateId
            ? "workflow.template.get"
            : "workflow.draft.initialize",
          props.templateId
            ? {
                templateId: props.templateId,
                definitionId: props.definitionId
              }
            : {
                definitionId: props.definitionId,
                name: "Untitled workflow"
              }
        );
        if (generation !== loadGeneration.current) return;
        setCanonicalValue(initial.canonicalDraft as unknown as JsonValue);
        setEditorValue(initial.editorDocument as unknown as JsonValue);
        setEditorText(pretty(initial.editorDocument));
        dirtyRef.current = true;
        setDirty(true);
      }
      setError(null);
    } catch (cause) {
      if (generation !== loadGeneration.current) return;
      setError(errorMessage(cause));
    }
  }, [props.definitionId, props.draftId, props.existing, props.templateId]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [load]);

  const editorDocument = asEditorDocument(editorValue);

  const definition = asWorkflowDefinition(canonicalValue);

  const updateDocument = (
    next: FlowEditorDocumentV1,
    options: { remount?: boolean } = {}
  ) => {
    // Editor documents are JSON. Electron structured clone preserves undefined
    // properties, so omit cleared optional fields before the IPC save boundary.
    const document = JSON.parse(JSON.stringify(next)) as FlowEditorDocumentV1;
    const canonical = compileEditorCanonical(document);
    jsonDrafts.retainNodes(document);
    setEditorValue(document as unknown as JsonValue);
    setCanonicalValue(canonical as unknown as JsonValue);
    setEditorText(pretty(document));
    setJsonDirty(false);
    editRevisionRef.current += 1;
    dirtyRef.current = true;
    setDirty(true);
    setValidation(null);
    if (options.remount) setCanvasRevision((revision) => revision + 1);
  };

  const removeGeneratedInputBuffers = (next: FlowEditorDocumentV1) => {
    if (!editorDocument) return;
    const start = editorDocument.nodes.find(
      (entry) => entry.definition.kind === "start"
    );
    if (!start) return;
    // Projection cleanup may remove unused generated selectors while another
    // input has unfinished JSON. Keep its buffer attached to the same row.
    for (
      let index = editorDocument.workflow.inputs.length - 1;
      index >= 0;
      index -= 1
    ) {
      if (
        !next.workflow.inputs.some(
          (input) => input.id === editorDocument.workflow.inputs[index]!.id
        )
      )
        jsonDrafts.removeItem(["nodes", start.id, "inputs"], index);
    }
  };

  const save = async (): Promise<WorkflowDraft> => {
    if (!jsonDirty && jsonDrafts.errors.length)
      throw new Error("Correct unfinished JSON fields before saving.");
    if (saveInFlightRef.current) return saveInFlightRef.current;
    const document = jsonDirty ? applyRawJson() : editorDocument;
    const canonical = document
      ? (compileEditorCanonical(document) as unknown as JsonValue)
      : canonicalValue;
    const editor = (document as unknown as JsonValue) ?? editorValue;
    const currentDefinition = asWorkflowDefinition(canonical);
    if (canonical === null || editor === null || !currentDefinition) {
      throw new Error("Workflow is not loaded");
    }
    const revision = editRevisionRef.current;
    const name = currentDefinition.name.trim();
    if (!name) throw new Error("Workflow name is required");
    const operation = (async () => {
      const currentDraft = draftRef.current;
      const saved = currentDraft
        ? await orchestration("workflow.draft.update", {
            draftId: currentDraft.draftId,
            expectedRevision: currentDraft.revision,
            canonicalDraft: canonical,
            editorDocument: editor
          })
        : await orchestration("workflow.draft.create", {
            draftId: props.draftId,
            definitionId: props.definitionId,
            name,
            canonicalDraft: canonical,
            editorDocument: editor
          });
      draftRef.current = saved;
      setDraft(saved);
      if (editRevisionRef.current === revision) {
        dirtyRef.current = false;
        setDirty(false);
      }
      setNotice("Workflow saved");
      setError(null);
      await props.onCatalogChanged();
      return saved;
    })();
    saveInFlightRef.current = operation;
    try {
      return await operation;
    } finally {
      if (saveInFlightRef.current === operation) {
        saveInFlightRef.current = null;
      }
    }
  };

  const applyRawJson = (): FlowEditorDocumentV1 => {
    const imported = asEditorDocument(JSON.parse(editorText) as JsonValue);
    if (!imported)
      throw new Error(
        "Workflow JSON must contain workflow, nodes and edges with node positions."
      );
    const document = {
      ...imported,
      workflow: {
        ...imported.workflow,
        definitionId: draftRef.current?.definitionId ?? props.definitionId
      }
    };
    jsonDrafts.clear([]);
    updateDocument(document, { remount: true });
    return document;
  };
  const editJsonText = (text: string) => {
    setEditorText(text);
    setJsonDirty(true);
    editRevisionRef.current += 1;
    dirtyRef.current = true;
    setDirty(true);
  };
  const ensureSaved = () =>
    !draftRef.current || dirtyRef.current
      ? save()
      : Promise.resolve(draftRef.current);
  const remountCanvas = () => setCanvasRevision((revision) => revision + 1);
  return {
    jsonDrafts,
    draft,
    canvasRevision,
    validation,
    setValidation,
    jsonDirty,
    editorText,
    dirty,
    notice,
    setNotice,
    error,
    setError,
    editorDocument,
    definition,
    updateDocument,
    removeGeneratedInputBuffers,
    save,
    applyRawJson,
    editJsonText,
    ensureSaved,
    remountCanvas
  };
}
