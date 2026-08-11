import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createRendererContentSecurityPolicy,
  createRendererContentSecurityPolicyPlugin,
  resolveReactRefreshPreamble
} from "./rendererContentSecurityPolicy";

describe("renderer content security policy", () => {
  it("allows only bundled JavaScript, WebAssembly, and the exact React Refresh preamble", () => {
    const preamble = resolveReactRefreshPreamble(
      'import "__BASE__@react-refresh";'
    );
    const expectedHash = createHash("sha256").update(preamble).digest("base64");

    expect(preamble).toBe('import "/@react-refresh";');
    expect(createRendererContentSecurityPolicy(preamble)).toBe(
      `script-src 'self' 'wasm-unsafe-eval' 'sha256-${expectedHash}';`
    );
  });

  it("serves the same policy as a development header and an HTML meta tag", async () => {
    const policy = createRendererContentSecurityPolicy("refresh preamble");
    const plugin = createRendererContentSecurityPolicyPlugin({
      reactRefreshPreamble: "refresh preamble"
    });
    const configHook = plugin.config;
    const htmlHook = plugin.transformIndexHtml;

    expect(typeof configHook).toBe("function");
    expect(typeof htmlHook).toBe("object");
    if (
      typeof configHook !== "function" ||
      typeof htmlHook !== "object" ||
      !("handler" in htmlHook)
    ) {
      throw new Error("Expected callable CSP plugin hooks");
    }

    const config = await configHook.call(
      {} as never,
      {},
      { command: "serve", mode: "development" }
    );
    const tags = await htmlHook.handler.call({} as never, "", {} as never);

    expect(config).toMatchObject({
      server: {
        headers: {
          "Content-Security-Policy": policy
        }
      }
    });
    expect(tags).toEqual([
      {
        tag: "meta",
        attrs: {
          "http-equiv": "Content-Security-Policy",
          content: policy
        },
        injectTo: "head-prepend"
      }
    ]);
  });
});
