import { createHash } from "node:crypto";

import type { HtmlTagDescriptor, Plugin } from "vite";

const CONTENT_SECURITY_POLICY_HEADER = "Content-Security-Policy";

// @vitejs/plugin-react exposes its refresh preamble with this base placeholder.
export function resolveReactRefreshPreamble(
  preambleCode: string,
  base = "/"
): string {
  return preambleCode.replace("__BASE__", base);
}

export function createRendererContentSecurityPolicy(
  reactRefreshPreamble: string
): string {
  const reactRefreshHash = createHash("sha256")
    .update(reactRefreshPreamble)
    .digest("base64");

  return `script-src 'self' 'wasm-unsafe-eval' 'sha256-${reactRefreshHash}';`;
}

export function createRendererContentSecurityPolicyPlugin(options: {
  reactRefreshPreamble: string;
}): Plugin {
  const contentSecurityPolicy = createRendererContentSecurityPolicy(
    options.reactRefreshPreamble
  );
  const metaTag: HtmlTagDescriptor = {
    tag: "meta",
    attrs: {
      "http-equiv": CONTENT_SECURITY_POLICY_HEADER,
      content: contentSecurityPolicy
    },
    injectTo: "head-prepend"
  };

  return {
    name: "kmux:renderer-content-security-policy",
    config() {
      // The header protects development from the first byte, including the
      // React Refresh preamble that Vite prepends ahead of HTML meta tags.
      return {
        server: {
          headers: {
            [CONTENT_SECURITY_POLICY_HEADER]: contentSecurityPolicy
          }
        }
      };
    },
    transformIndexHtml: {
      order: "pre",
      handler() {
        // Packaged renderers load over file://, where CSP must live in markup.
        return [metaTag];
      }
    }
  };
}
