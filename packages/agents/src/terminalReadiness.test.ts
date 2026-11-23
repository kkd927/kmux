import { describe, expect, it } from "vitest";
import { classifyBuiltinAgentTerminalReadiness } from "./builtinRuntime";

const classify = (
  agentId: string,
  visible: string,
  agentProcessDetected = true
) =>
  classifyBuiltinAgentTerminalReadiness({
    agentId,
    visible,
    agentProcessDetected
  });

describe("Agent terminal readiness", () => {
  it("recognizes the captured Codex 0.162.1 composer with multiple compact footers", () => {
    const screen =
      "›Ask Codex to do anything\n\nGPT-6.1-Solxhigh ·/private/tmp/worker…\n?forshortcuts⚠1warning·f2toview";
    expect(classify("codex", screen)).toEqual({ state: "ready" });
    expect(
      classify("codex", screen.replace("GPT-6.1-Sol", "GPT-6-Luna"))
    ).toEqual({ state: "ready" });
    expect(classify("codex", `${screen}\nWaiting for permission`)).toBeNull();
    expect(classify("codex", `${screen}\n›1. Allow command`)).toBeNull();
    expect(
      classify(
        "codex",
        `• Working (5s • esc to interrupt)\n⚠5hlimit:44%left\n${screen}`
      )
    ).toBeNull();
    expect(
      classify("codex", `>_ OpenAI Codex\nmodel: loading\n${screen}`)
    ).toBeNull();
    expect(
      classify("codex", `Earlier output mentioned esc to interrupt)\n${screen}`)
    ).toEqual({ state: "ready" });
  });
  it("requires a running Agent and distinguishes a shell startup failure", () => {
    expect(
      classify(
        "copilot",
        "user@host % copilot\nenv: node: No such file or directory\nuser@host % ",
        false
      )
    ).toMatchObject({ state: "blocked" });
    expect(classify("copilot", "user@host % ", false)).toBeNull();
    expect(
      classify("copilot", "GitHub Copilot\n\u001b[32m> \u001b[0m")
    ).toEqual({ state: "ready" });
    expect(
      classify("copilot", "An earlier command failed: permission denied\n❯")
    ).toEqual({ state: "ready" });
  });

  it("uses the provider's own compact and framed input screens", () => {
    const copilot =
      "GitHub Copilot\n~/Projects/kmux [main*%]\n────────────────────\n❯\n────────────────────\n← open sidebar · / commands · ? help · tab next tab\n Auto";
    expect(classify("copilot", copilot)).toEqual({ state: "ready" });
    expect(
      classify("copilot", `${copilot}\nWorking on a new turn...`)
    ).toBeNull();
    expect(classify("antigravity", copilot)).toBeNull();
    expect(
      classify(
        "copilot",
        "GitHub Copilot v1.0.86\n╻▄▄▄▄▄▄▄▄▄▄▄▄\n┃   \n╹▀▀▀▀▀▀▀▀▀▀▀▀\n ← open sidebar · / commands · ? help · tab next tabAuto"
      )
    ).toEqual({ state: "ready" });
    expect(
      classify(
        "antigravity",
        "Antigravity CLI 1.2.6\n────────────────────────\n>\n────────────────────────\n? for shortcutsGemini 3.8 Flash · high"
      )
    ).toEqual({ state: "ready" });
  });

  it("recognizes an active dialog without blocking an ordinary review of authentication", () => {
    expect(
      classify(
        "copilot",
        "GitHub Copilot\nConfirm folder trust\nDo you trust the files in this folder?\n❯ 1. Yes"
      )
    ).toMatchObject({ state: "blocked" });
    expect(
      classify(
        "copilot",
        "Confirm folder trust\nDo you trust the files in this folder?\n❯ 1. Yes\n  2. No\nPress Enter to confirm"
      )
    ).toMatchObject({ state: "blocked" });
    expect(
      classify(
        "copilot",
        "GitHub Copilot\nAuthentication required. Use /login."
      )
    ).toMatchObject({ state: "blocked" });
    for (const agentId of ["copilot", "antigravity", "codex", "claude"]) {
      expect(
        classify(
          agentId,
          "Review completed: the sign-in and login flow needs validation.\n❯"
        )
      ).toEqual({ state: "ready" });
      expect(
        classify(
          agentId,
          "Review found: Authentication required. Use /login.\n❯"
        )
      ).toEqual({ state: "ready" });
    }
    expect(
      classify(
        "antigravity",
        "Welcome to the Antigravity CLI. You are currently not signed in\nSigning in..."
      )
    ).toBeNull();
  });

  it("recognizes a wrapped Copilot footer while requiring an idle empty input", () => {
    const footer =
      "← open   · Interactive · / commands · ? help ·\nsidebar    Allow all     tab next tab\nAuto";
    const ready = `Copilot v1.0.95\n────────────────────\n❯ \n────────────────────\n${footer}`;
    expect(classify("copilot", ready)).toEqual({ state: "ready" });
    expect(
      classify("copilot", ready.replace("❯ ", "❯ pending text"))
    ).toBeNull();
    expect(
      classify("copilot", `${ready}\nWorking on a new turn...`)
    ).toBeNull();
    expect(
      classify(
        "copilot",
        ready.replace(footer, "◉ Working · 8.5 KiB\nesc interrupt\nAuto")
      )
    ).toBeNull();
    expect(classify("antigravity", ready)).toBeNull();
    expect(
      classify("copilot", `╻▄▄▄▄▄▄▄▄▄▄\n┃ \n╹▀▀▀▀▀▀▀▀▀▀\n${footer}`)
    ).toEqual({ state: "ready" });
  });

  it("keeps Copilot readiness independent of footer line wrapping", () => {
    const footers = [
      "← open sidebar· Interactive · Allow All· / commands · ? help · tab next\ntab\n Auto",
      "← open · Interactive · · / commands · ? help ·\nsidebarAllow Alltab next tab\n Auto",
      "← open · Interactive · Allow · / commands · ? help · tab\nsidebarAllnext tab\n Auto",
      "← open sidebar· Interactive · Allow All· / commands · ? help · tab next\ntab\n Auto → gpt-6-luna",
      "← open sidebar · / commands · ? help · tab next tab GPT-6.1Sol"
    ];
    const footer =
      "← open sidebar · Interactive · Allow All · / commands · ? help · tab next tab\nAuto → gpt-6-luna";
    // Exercise every possible hard-wrap position, including within labels.
    for (let column = 1; column < footer.length; column++) {
      footers.push(`${footer.slice(0, column)}\n${footer.slice(column)}`);
    }
    for (const wrapped of footers) {
      const screen = `Copilot\n────────────────────\n❯\n────────────────────\n${wrapped}`;
      expect(classify("copilot", screen), wrapped).toEqual({ state: "ready" });
      expect(
        classify("copilot", `${screen}\nWorking on a new turn...`)
      ).toBeNull();
      expect(
        classify("copilot", screen.replace("❯\n", "❯ pending\n"))
      ).toBeNull();
    }
  });

  it("uses the latest Copilot input frame when previous frames remain visible", () => {
    const footer = "← open sidebar · / commands · ? help · tab next tabAuto";
    const stale = `❯\n────────────────────\n${footer}\nPrevious answer\n`;
    expect(
      classify("copilot", `${stale}❯\n────────────────────\n${footer}`)
    ).toEqual({ state: "ready" });
    expect(
      classify("copilot", `${stale}❯ pending\n────────────────────\n${footer}`)
    ).toBeNull();
  });

  it("recognizes input placeholders and footers without accepting numbered dialogs", () => {
    expect(
      classify(
        "codex",
        "OpenAI Codex\n› Summarize recent commits\n  ? for shortcuts                         100% context left"
      )
    ).toEqual({ state: "ready" });
    expect(
      classify("codex", "› Find and fix a bug\n  gpt-6-sol · 100% context left")
    ).toEqual({ state: "ready" });
    expect(
      classify(
        "claude",
        "Claude Code\n❯ Try fixing a bug\n────────────────────\n  ? for shortcuts"
      )
    ).toEqual({ state: "ready" });
    expect(
      classify("codex", "Sign in to Codex\n› 1. Sign in with ChatGPT")
    ).toBeNull();
    expect(
      classify("claude", "Select login method\n❯ 1. Claude subscription")
    ).toBeNull();
  });
});
