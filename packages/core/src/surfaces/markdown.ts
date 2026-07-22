import {
  assertLocatedPathTarget,
  decodeLocatedPathDto,
  encodeLocatedPathDto
} from "../domain";
import type { SurfaceCoreModule } from "./registry";

const MAX_MARKDOWN_TITLE_LENGTH = 512;

export const markdownSurfaceCoreModule: SurfaceCoreModule<"markdown"> = {
  kind: "markdown",

  create(context, init) {
    const workspace = context.state.workspaces[context.workspaceId];
    const pane = context.state.panes[context.paneId];
    if (!workspace || !pane || pane.workspaceId !== workspace.id) {
      throw new Error("Markdown Surface create context is invalid");
    }
    assertLocatedPathTarget(workspace.location.target, init.path);
    const title = boundedTitle(init.title);
    return {
      surface: {
        id: context.surfaceId,
        paneId: context.paneId,
        title,
        titleLocked: false,
        unreadCount: 0,
        attention: false,
        content: {
          kind: "markdown",
          source: { kind: "file", path: init.path }
        }
      },
      effects: []
    };
  },

  close(_state, surface) {
    return [
      {
        type: "surface.runtime.close",
        kind: "markdown",
        surfaceId: surface.id
      }
    ];
  },

  encodeContent(content) {
    return {
      kind: "markdown",
      source: {
        kind: "file",
        path: encodeLocatedPathDto(content.source.path)
      }
    };
  },

  decodeContent(value) {
    const record = requireExactRecord(
      value,
      ["kind", "source"],
      "Markdown content"
    );
    if (record.kind !== "markdown") {
      throw new TypeError("Markdown content kind is invalid");
    }
    const source = requireExactRecord(
      record.source,
      ["kind", "path"],
      "Markdown file source"
    );
    if (source.kind !== "file") {
      throw new TypeError("Markdown source kind is invalid");
    }
    return {
      kind: "markdown",
      source: { kind: "file", path: decodeLocatedPathDto(source.path) }
    };
  },

  buildVmContent() {
    return { kind: "markdown" };
  }
};

function boundedTitle(value: string): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (
    !title ||
    title.length > MAX_MARKDOWN_TITLE_LENGTH ||
    /[\0\r\n]/u.test(title)
  ) {
    throw new TypeError("Markdown title must be non-empty and bounded");
  }
  return title;
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} keys are invalid`);
  }
  return record;
}
