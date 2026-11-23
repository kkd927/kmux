import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalMetadataInventoryService,
  type AgentMetadataInventoryService
} from "@kmux/metadata";
import {
  builtinAgentMetadataSourceRevisions,
  readBuiltinAgentSessionTranscript
} from "./builtinRuntime";
import { readAgentSessionTranscript } from "./sessionTranscript";

describe("exact provider session transcripts", () => {
  it.each([
    {
      agentId: "codex",
      path: ".codex/sessions/2026/10/03/rollout-current.jsonl",
      records: [
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Older task" }]
          }
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "[kmux-dispatch:dispatch:current]" }
            ]
          }
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            output: "hidden tool result"
          }
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Detailed findings 한글" }]
          }
        }
      ]
    },
    {
      agentId: "claude",
      path: ".claude/projects/repository/current.jsonl",
      records: [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Older task" }] }
        },
        {
          type: "user",
          message: { content: "[kmux-dispatch:dispatch:current]" }
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", content: "hidden tool result" }]
          }
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Detailed findings 한글" }]
          }
        }
      ]
    },
    {
      agentId: "copilot",
      path: ".copilot/session-state/current/events.jsonl",
      records: [
        { type: "assistant.message", data: { content: "Older task" } },
        {
          type: "user.message",
          data: { content: "[kmux-dispatch:dispatch:current]" }
        },
        {
          type: "assistant.message",
          agentId: "subagent",
          data: { content: "hidden tool result" }
        },
        {
          type: "assistant.message",
          data: { content: "Detailed findings 한글" }
        }
      ]
    }
  ])(
    "reads $agentId conversation text and the current Dispatch boundary",
    async ({ agentId, path, records }) => {
      const homeDir = mkdtempSync(join(tmpdir(), "kmux-session-transcript-"));
      const file = join(homeDir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        records.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
      );
      const inventory = createLocalMetadataInventoryService({
        principal: "test",
        sourceDefinitionRevisions: builtinAgentMetadataSourceRevisions()
      });
      const read = (sessionId: string) =>
        readBuiltinAgentSessionTranscript({
          homeDir,
          agentId,
          sessionId,
          metadataInventory: inventory,
          dispatchMarker: "[kmux-dispatch:dispatch:current]"
        });
      try {
        const output = await read("current");
        expect(output).toMatchObject({ status: "available", truncated: false });
        expect(output.text).toContain("Detailed findings 한글");
        expect(output.text).not.toMatch(/Older task|hidden tool result/u);
        writeFileSync(
          file,
          records
            .concat(
              records
                .slice(1)
                .map((record) =>
                  JSON.parse(
                    JSON.stringify(record)
                      .replaceAll("dispatch:current", "dispatch:next")
                      .replaceAll(
                        "Detailed findings 한글",
                        "Next task findings"
                      )
                  )
                )
            )
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n"
        );
        const previous = await read("current");
        expect(previous.text).toContain("Detailed findings 한글");
        expect(previous.text).not.toMatch(/dispatch:next|Next task findings/u);
        await expect(read("another-session")).resolves.toMatchObject({
          status: "missing",
          text: ""
        });
        await expect(
          readBuiltinAgentSessionTranscript({
            homeDir,
            agentId: "antigravity",
            sessionId: "current",
            metadataInventory: inventory
          })
        ).resolves.toMatchObject({ status: "unsupported", text: "" });
      } finally {
        await inventory.close();
        rmSync(homeDir, { recursive: true, force: true });
      }
    }
  );

  it.each([
    { ending: "LF", newline: "\n", partialBytes: 0 },
    { ending: "CRLF", newline: "\r\n", partialBytes: 0 },
    { ending: "LF", newline: "\n", partialBytes: 5 },
    { ending: "CRLF", newline: "\r\n", partialBytes: 6 }
  ])(
    "preserves the requested Dispatch at a bounded $ending window (partialBytes=$partialBytes)",
    async ({ newline, partialBytes }) => {
      const homeDir = mkdtempSync(join(tmpdir(), "kmux-transcript-boundary-"));
      const file = join(homeDir, ".copilot/session-state/current/events.jsonl");
      const marker = "[kmux-dispatch:dispatch:current]";
      const record = (type: string, content: string) =>
        JSON.stringify({ type, data: { content } }) + newline;
      const prefix = record("assistant.message", "Older task 한글");
      const tail =
        record("user.message", marker) +
        record("assistant.message", "Current findings 한글") +
        record("user.message", "[kmux-dispatch:dispatch:next]") +
        record("assistant.message", "Next task findings");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, prefix + tail);
      const inventory = createLocalMetadataInventoryService({
        principal: "test",
        sourceDefinitionRevisions: builtinAgentMetadataSourceRevisions()
      });
      try {
        const output = await readBuiltinAgentSessionTranscript({
          homeDir,
          agentId: "copilot",
          sessionId: "current",
          metadataInventory: inventory,
          dispatchMarker: marker,
          maxBytes: Buffer.byteLength(tail) + partialBytes
        });
        expect(output).toMatchObject({ status: "available", truncated: true });
        expect(output.text).toContain("Current findings 한글");
        expect(output.text).not.toMatch(/Older task|dispatch:next|Next task/u);
      } finally {
        await inventory.close();
        rmSync(homeDir, { recursive: true, force: true });
      }
    }
  );

  it.each([false, true])(
    "does not substitute another Dispatch when the requested boundary is absent (clipped=%s)",
    async (clipped) => {
      const release = vi.fn(async () => undefined);
      const inventory = {
        acquire: () => ({
          invalidate: () => undefined,
          inventory: async () => ({
            candidates: [
              {
                path: "/session.jsonl",
                size: clipped ? 1_000_000 : 100,
                mtimeMs: 1
              }
            ],
            truncated: false,
            diagnostics: []
          }),
          readText: async () =>
            `${clipped ? "partial record\n" : ""}${JSON.stringify({ role: "user", text: "Reference to [kmux-dispatch:dispatch:previous] in task instructions.\n[kmux-dispatch:dispatch:next]" })}\n{"role":"assistant","text":"Next task findings"}\n`,
          release
        })
      } as unknown as AgentMetadataInventoryService;
      const output = await readAgentSessionTranscript({
        agentId: "copilot",
        sessionId: "exact",
        roots: ["/"],
        metadataInventory: inventory,
        dispatchMarker: "[kmux-dispatch:dispatch:previous]",
        capability: {
          matchesPath: () => true,
          decodeRecord: (value) =>
            value as { role: "user" | "assistant"; text: string }
        }
      });
      expect(output).toMatchObject({
        status: "missing",
        text: "",
        truncated: clipped
      });
      expect(output.reason).toMatch(/Dispatch boundary/u);
      expect(release).toHaveBeenCalledOnce();
    }
  );

  it.each(["bounded", "empty", "unreadable"] as const)(
    "distinguishes %s records and releases its inventory lease",
    async (mode) => {
      const release = vi.fn(async () => undefined);
      const readText = vi.fn(async () => {
        if (mode === "unreadable") throw new Error("access denied");
        return mode === "empty"
          ? ""
          : 'partial first record\n{"text":"Tail findings"}\n{"unfinished":';
      });
      const inventory = {
        acquire: () => ({
          invalidate: () => undefined,
          inventory: async () => ({
            candidates: [
              {
                path: "/exact/session.jsonl",
                size: mode === "bounded" ? 1_000_000 : 0,
                mtimeMs: 1
              }
            ],
            truncated: false,
            diagnostics: []
          }),
          readText,
          release
        })
      } as unknown as AgentMetadataInventoryService;
      const output = await readAgentSessionTranscript({
        agentId: "codex",
        sessionId: "exact",
        roots: ["/exact"],
        metadataInventory: inventory,
        capability: {
          matchesPath: () => true,
          decodeRecord: (value) => ({
            role: "assistant",
            text: (value as { text: string }).text
          })
        }
      });
      expect(output.status).toBe(mode === "bounded" ? "available" : mode);
      expect(output.truncated).toBe(mode === "bounded");
      if (mode === "bounded") {
        expect(output.text).toBe("[assistant]\nTail findings");
        expect(readText).toHaveBeenCalledWith({
          path: "/exact/session.jsonl",
          offset: 1_000_000 - 256 * 1024,
          maxBytes: 256 * 1024
        });
      }
      expect(release).toHaveBeenCalledOnce();
    }
  );
});
