import type { AgentModule } from "./contracts";

export const PORTABLE_AGENT_MANIFEST_VERSION = 2 as const;

export interface PortableAgentManifest {
  readonly version: typeof PORTABLE_AGENT_MANIFEST_VERSION;
  readonly primitiveVersion: 2;
  readonly agents: readonly PortableAgentManifestEntry[];
}

export interface PortableAgentManifestEntry {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly definitionRevision: string;
  readonly hook?: {
    readonly pathRoot?: PortableAgentPathRoot;
    readonly relativePath: string;
    readonly document: {
      readonly eventsPath: readonly string[];
      readonly version?: {
        readonly field: string;
        readonly value: number;
      };
    };
    readonly entry: {
      readonly commandField: "command" | "bash";
      readonly wrapper?: {
        readonly field: string;
        readonly when: "always" | "matcher";
      };
    };
    readonly marker: string;
    readonly managed: readonly {
      readonly event: string;
      readonly matcher?: string;
    }[];
    readonly deprecated: readonly string[];
    readonly outputMode: "silent" | "json";
    readonly successResponse: Readonly<Record<string, unknown>>;
    readonly fallbackResponse: Readonly<Record<string, unknown>>;
    readonly fallbackByEvent?: Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
    readonly sessionClaim?: {
      readonly startEvents: readonly string[];
      readonly sessionIdFields: readonly string[];
    };
  };
  readonly metadata?: {
    readonly pathRoot?: PortableAgentPathRoot;
    readonly defaultRoot: string;
    readonly sources: readonly {
      readonly role: string;
      readonly format: "jsonl" | "sqlite";
      readonly pattern: string;
      readonly purposes: readonly string[];
      readonly claimScope?: "session" | "agent";
      readonly queryPlanIds?: readonly string[];
    }[];
  };
}

export interface PortableAgentPathRoot {
  readonly defaultHomeRelativePath: string;
  readonly environmentVariable: string;
}

export function createPortableAgentManifest(
  modules: readonly AgentModule[]
): PortableAgentManifest {
  return {
    version: PORTABLE_AGENT_MANIFEST_VERSION,
    primitiveVersion: 2,
    agents: modules.map((module) => {
      const hook = module.hooks?.portable;
      if (hook) {
        validateRelativePattern(hook.relativePath, "hook path");
        validatePathRoot(hook.pathRoot, "hook path root");
      }
      const metadata = module.metadataSources;
      if (metadata) {
        validateRelativePattern(metadata.defaultRoot, "metadata root");
        validatePathRoot(metadata.pathRoot, "metadata path root");
        for (const source of metadata.sources) {
          validateRelativePattern(source.pattern, "metadata source pattern");
        }
      }
      return {
        id: module.descriptor.id,
        aliases: [...module.descriptor.aliases],
        definitionRevision: module.definitionRevision,
        ...(hook
          ? {
              hook: {
                ...(hook.pathRoot ? { pathRoot: { ...hook.pathRoot } } : {}),
                relativePath: hook.relativePath,
                document: {
                  eventsPath: [...hook.document.eventsPath],
                  ...(hook.document.version
                    ? { version: { ...hook.document.version } }
                    : {})
                },
                entry: {
                  commandField: hook.entry.commandField,
                  ...(hook.entry.wrapper
                    ? { wrapper: { ...hook.entry.wrapper } }
                    : {})
                },
                marker: hook.marker,
                managed: hook.managed.map((entry) => ({ ...entry })),
                deprecated: [...hook.deprecated],
                outputMode: hook.outputMode,
                successResponse: { ...hook.successResponse },
                fallbackResponse: { ...hook.fallbackResponse },
                ...(hook.fallbackByEvent
                  ? {
                      fallbackByEvent: Object.fromEntries(
                        Object.entries(hook.fallbackByEvent).map(
                          ([event, response]) => [event, { ...response }]
                        )
                      )
                    }
                  : {}),
                ...(hook.sessionClaim
                  ? {
                      sessionClaim: {
                        startEvents: [...hook.sessionClaim.startEvents],
                        sessionIdFields: [...hook.sessionClaim.sessionIdFields]
                      }
                    }
                  : {})
              }
            }
          : {}),
        ...(metadata
          ? {
              metadata: {
                ...(metadata.pathRoot
                  ? { pathRoot: { ...metadata.pathRoot } }
                  : {}),
                defaultRoot: metadata.defaultRoot,
                sources: metadata.sources.map((source) => ({
                  role: source.role,
                  format: source.format,
                  pattern: source.pattern,
                  purposes: [...source.purposes],
                  ...(source.claimScope === undefined
                    ? {}
                    : { claimScope: source.claimScope }),
                  ...(source.queryPlanIds?.length
                    ? { queryPlanIds: [...source.queryPlanIds] }
                    : {})
                }))
              }
            }
          : {})
      };
    })
  };
}

function validatePathRoot(
  root: PortableAgentPathRoot | undefined,
  label: string
): void {
  if (!root) return;
  validateRelativePattern(root.defaultHomeRelativePath, label);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(root.environmentVariable)) {
    throw new TypeError(`${label} environment variable is invalid`);
  }
}

function validateRelativePattern(value: string, label: string): void {
  if (
    !value ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value
      .split(/[\\/]/u)
      .some((part) => part === "" || part === "." || part === "..") ||
    /[^A-Za-z0-9._*/-]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}
