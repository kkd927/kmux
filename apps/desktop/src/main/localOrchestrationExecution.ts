import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  classifyBuiltinAgentTerminalReadiness,
  listBuiltinProcessMatchers,
  normalizeBuiltinAgentScopeSettings,
  prepareBuiltinAgentWorkspaceTrust,
  resolveBuiltinAgentId,
  resolveBuiltinAgentLaunchPolicy,
  resolvedAgentCommandIsAvailable
} from "@kmux/agents/builtin-runtime";
import { resolveAiCliProcessMatches } from "@kmux/metadata";
import { formatUint64Decimal, makeId } from "@kmux/proto";
import {
  decodeLocalPath,
  defaultNewSurfaceCwd,
  formatAgentCommandForShell,
  locatedPathForTarget,
  resolveAgentScopeSettings,
  terminalSessionForSurface,
  type AppState,
  type LocalPath
} from "@kmux/core";
import {
  contentHash,
  type ArtifactRef,
  type AgentLaunchReceipt,
  type WorkflowRun
} from "@kmux/orchestration";
import { logDiagnostics } from "../shared/diagnostics";
import { reuseLocalAgentSurface } from "./localAgentSurfaceReuse";
import { LocalAgentReadinessRegistry } from "./localAgentReadiness";
import { verifyTerminalCoordinator } from "./localCoordinatorCaller";
import {
  AgentPreparationNeedsAttentionError,
  AgentPreparationError,
  LocalAgentNodeExecutor
} from "./localAgentNodeExecutor";
import { LocalShellNodeExecutor } from "./localShellNodeExecutor";
import { FileOrchestrationArtifactStore } from "@kmux/orchestration/node";
import {
  OrchestrationRepositoryStateCapture,
  worktreePathToken
} from "./orchestrationRepositoryState";
import type {
  TargetServiceSet,
  TargetServiceRegistry
} from "./targets/contracts";
import type { AppRuntime } from "./appRuntime";
import type { AgentMetadataScanService } from "./usageScanWorkerClient";
import type { LocalPathResolver } from "./targets/targetServiceRegistry";
import type { AppPaths } from "@kmux/persistence";
import type { LocalOrchestrationHost } from "./orchestrationHost";
import type { PtyHostManager } from "./ptyHost";
/** Compose local native-terminal Worker execution and its application services. */
export function configureLocalOrchestration({
  ptyHost,
  desktopInstallationId,
  orchestrationHost,
  paths,
  runtime,
  resolveLocalPath,
  localAgentMetadataScanner,
  localTargetServices,
  targetServices,
  launchEnv,
  userHomeDir
}: {
  ptyHost: PtyHostManager | null;
  desktopInstallationId: string;
  orchestrationHost: LocalOrchestrationHost;
  paths: Pick<AppPaths, "orchestrationArtifactRoot">;
  runtime: AppRuntime;
  resolveLocalPath: LocalPathResolver;
  localAgentMetadataScanner: AgentMetadataScanService;
  localTargetServices: TargetServiceSet<LocalPath>;
  targetServices: TargetServiceRegistry;
  launchEnv: Record<string, string | undefined>;
  userHomeDir: string;
}) {
  const orchestrationPtyHost = ptyHost;
  if (!orchestrationPtyHost) {
    throw new Error("local PTY host is unavailable for orchestration");
  }
  const lastUserInputAtByGeneration = new Map<string, string>();
  const localGenerationKey = (
    surfaceId: string,
    sessionId: string,
    runtimeEpoch: string
  ) => `${surfaceId}|${sessionId}|${runtimeEpoch}`;
  const localAgentReadiness = new LocalAgentReadinessRegistry({
    targetAuthority: `desktop:${desktopInstallationId}`,
    sessionRef: (surfaceId, sessionId) =>
      orchestrationPtyHost.sessionRef(surfaceId, sessionId),
    observeTui: async (execution, agentId) => {
      const snapshot = await orchestrationPtyHost.snapshot(
        execution.sessionId,
        execution.surfaceId,
        { settleForMs: 200, timeoutMs: 2_000 }
      );
      if (!snapshot) return null;
      const matcher = listBuiltinProcessMatchers().find(
        (candidate) => candidate.agentId === agentId
      );
      const parentPid = orchestrationPtyHost.sessionPid(execution.sessionId);
      if (!matcher || parentPid === undefined) return null;
      const matches = await resolveAiCliProcessMatches(
        [{ parentPid, vendor: matcher.agentId }],
        process.env,
        [matcher]
      );
      const observation = classifyBuiltinAgentTerminalReadiness({
        agentId,
        visible: snapshot.vt,
        agentProcessDetected: matches.has(parentPid)
      });
      return observation?.state === "ready"
        ? {
            ...observation,
            observationId: formatUint64Decimal(snapshot.sequence)
          }
        : observation;
    }
  });
  orchestrationPtyHost.on("event", (event) => {
    if (event.type === "exit") {
      localAgentReadiness.forgetSession(event.payload.sessionId);
      void orchestrationHost
        .observeLocalSessionExit(event.payload.sessionId)
        .catch((error) =>
          logDiagnostics("main.orchestration.session-loss-persistence-error", {
            message: error instanceof Error ? error.message : String(error),
            sessionId: event.payload.sessionId
          })
        );
    }
  });
  const orchestrationArtifacts = new FileOrchestrationArtifactStore({
    root: paths.orchestrationArtifactRoot
  });
  const orchestrationRepositoryState = new OrchestrationRepositoryStateCapture({
    getState: runtime.getState,
    targetServices,
    artifacts: orchestrationArtifacts,
    worktreeRegistryRoot: join(paths.orchestrationArtifactRoot, "worktrees")
  });
  const localWorktreeForToken = async (
    pathToken: string,
    state: AppState,
    fallbackWorkspace: AppState["workspaces"][string]
  ) => {
    const captured =
      await orchestrationRepositoryState.resolveWorktree(pathToken);
    if (captured) return { workspace: fallbackWorkspace, cwd: captured };
    const workspace = Object.values(state.workspaces).find((candidate) => {
      if (candidate.location.target.kind !== "local" || !candidate.worktree) {
        return false;
      }
      return (
        contentHash({
          targetId: "local",
          path: realpathSync.native(resolveLocalPath(candidate.worktree.path))
        }) === pathToken
      );
    });
    return workspace?.worktree?.path.kind === "local"
      ? { workspace, cwd: workspace.worktree.path.path }
      : undefined;
  };
  const localRunWorkspacePlacement = async (
    run: Pick<WorkflowRun, "coordinatorAttachment">,
    workspace: AppState["workspaces"][string],
    state = runtime.getState()
  ) => {
    const attachment = run.coordinatorAttachment;
    const attachedSurface =
      attachment?.transport === "terminal"
        ? state.surfaces[attachment.surfaceId]
        : undefined;
    const attachedSession = attachedSurface
      ? terminalSessionForSurface(state, attachedSurface.id)
      : undefined;
    const attachedPane = attachedSurface
      ? state.panes[attachedSurface.paneId]
      : undefined;
    const pane =
      attachedSession?.id === attachment?.sessionId &&
      attachedPane?.workspaceId === workspace.id
        ? attachedPane
        : state.panes[workspace.activePaneId];
    if (!pane) throw new Error("workspace has no active pane");
    let cwd = defaultNewSurfaceCwd(state, pane.id);
    if (cwd.kind !== "local") {
      throw new Error("local orchestration requires a local workspace cwd");
    }
    if (attachedSession && attachment) {
      const observed = await orchestrationPtyHost.snapshot(
        attachment.sessionId,
        attachment.surfaceId,
        { settleForMs: 0, timeoutMs: 1_000 }
      );
      if (observed?.cwd && isAbsolute(observed.cwd)) {
        const observedCwd = locatedPathForTarget(
          workspace.location.target,
          observed.cwd
        );
        if (observedCwd.kind === "local") cwd = observedCwd;
      }
    }
    return { paneId: pane.id, cwd: cwd.path };
  };
  const localAgentExecutor = new LocalAgentNodeExecutor({
    capabilitiesForAgent: (selectedId) =>
      resolveBuiltinAgentId(selectedId)
        ? ["terminal", "filesystem-write"]
        : undefined,
    ptyHost: orchestrationPtyHost,
    readiness: localAgentReadiness,
    readTranscript: async ({ run, dispatchId }) => {
      const dispatch = run.dispatches[dispatchId]!;
      const execution = dispatch.execution!;
      const session = terminalSessionForSurface(
        runtime.getState(),
        execution.surfaceId
      );
      const agentId = resolveBuiltinAgentId(dispatch.selectedAgentId);
      const attested = dispatch.readinessReceiptId
        ? run.readinessReceipts[dispatch.readinessReceiptId]
            ?.verifiedProviderSessionId
        : undefined;
      const providerSessionId =
        attested ??
        (session?.id === execution.sessionId &&
        session.agentSessionRef &&
        session.agentSessionRef.vendor === agentId
          ? session.agentSessionRef.id
          : undefined);
      if (!agentId || !providerSessionId) {
        return {
          status: "missing",
          text: "",
          truncated: false,
          reason: "Worker has no attested provider session identity"
        };
      }
      return localAgentMetadataScanner.readSessionTranscript({
        agentId,
        sessionId: providerSessionId,
        dispatchMarker: `[kmux-dispatch:${dispatchId}]`
      });
    },
    id: makeId,
    lastUserInputAt: (execution) =>
      execution.generation.kind === "local"
        ? lastUserInputAtByGeneration.get(
            localGenerationKey(
              execution.surfaceId,
              execution.sessionId,
              execution.generation.runtimeEpoch
            )
          )
        : undefined,
    removeReleasedSurface: (execution) => {
      const state = runtime.getState();
      const surface = state.surfaces[execution.surfaceId];
      const session = surface
        ? terminalSessionForSurface(state, execution.surfaceId)
        : undefined;
      // The PTY close was generation-fenced. Fence the UI cleanup as well so
      // a Surface that has since been rebound can never be removed.
      if (
        surface?.content.kind === "terminal" &&
        session?.id === execution.sessionId
      ) {
        runtime.dispatchAppAction({
          type: "surface.close",
          surfaceId: execution.surfaceId
        });
      }
    },
    bindSurface: async ({ run, attempt }) => {
      const dispatch = attempt.dispatchId
        ? run.dispatches[attempt.dispatchId]
        : undefined;
      if (!dispatch) throw new Error("Agent attempt has no Dispatch");
      const reused = await reuseLocalAgentSurface({
        run,
        attempt,
        worktreeRoot: async (cwd) => {
          const { repository } = await localTargetServices.git.inspect(
            decodeLocalPath(cwd),
            { dirtyLimit: 0 }
          );
          return (
            repository &&
            realpathSync.native(
              localTargetServices.files.display(repository.root)
            )
          );
        },
        sessionCwd: (execution) => {
          const session = terminalSessionForSurface(
            runtime.getState(),
            execution.surfaceId
          );
          const ref = orchestrationPtyHost.sessionRef(
            execution.surfaceId,
            execution.sessionId
          );
          if (
            session?.id !== execution.sessionId ||
            execution.generation.kind !== "local" ||
            ref?.epoch !== execution.generation.runtimeEpoch
          )
            return undefined;
          return realpathSync.native(
            resolveLocalPath(session.runtimeMetadata.cwd)
          );
        },
        lastUserInputAt: (execution) =>
          execution.generation.kind === "local"
            ? lastUserInputAtByGeneration.get(
                localGenerationKey(
                  execution.surfaceId,
                  execution.sessionId,
                  execution.generation.runtimeEpoch
                )
              )
            : undefined
      });
      if (reused) return reused;
      const state = runtime.getState();
      const workspace = run.workspaceId
        ? state.workspaces[run.workspaceId]
        : undefined;
      if (!workspace || workspace.location.target.kind !== "local") {
        throw new Error("local Agent execution requires a local workspace");
      }
      const coordinatorPlacement = await localRunWorkspacePlacement(
        run,
        workspace
      );
      let executionWorkspace = workspace;
      let workspaceCwd = coordinatorPlacement.cwd;
      if (dispatch.requestedBinding.worktreePolicy === "from-input") {
        const inputName =
          dispatch.requestedBinding.worktreeInput?.target ?? "worktree";
        const worktreeValue = attempt.resolvedInputs[inputName];
        const pathToken = worktreePathToken(worktreeValue);
        const located = pathToken
          ? await localWorktreeForToken(pathToken, state, workspace)
          : undefined;
        if (!located) {
          throw new Error(
            "from-input Agent placement has no matching trusted worktree receipt"
          );
        }
        executionWorkspace = located.workspace;
        workspaceCwd = located.cwd;
      } else if (
        dispatch.requestedBinding.worktreePolicy === "dedicated-child" ||
        dispatch.requestedBinding.worktreePolicy === "dedicated-top-level"
      ) {
        if (
          dispatch.requestedBinding.surfacePolicy === "existing" ||
          dispatch.requestedBinding.sessionPolicy === "existing"
        ) {
          throw new Error("a new worktree requires a new Agent terminal");
        }
        const inspection = await localTargetServices.git.inspect(workspaceCwd, {
          dirtyLimit: 0
        });
        if (!inspection.repository)
          throw new Error("new Agent worktree requires a Git repository");
        const commonGitDir = realpathSync.native(
          resolveLocalPath({
            kind: "local",
            path: inspection.repository.commonGitDir
          })
        );
        const repositoryRoot = realpathSync.native(
          resolveLocalPath({ kind: "local", path: inspection.repository.root })
        );
        const identity = contentHash({
          runId: run.runId,
          binding: dispatch.bindingInstanceKey
        }).slice(7, 31);
        const parentIdentity = contentHash({
          commonGitDir,
          repositoryRoot
        }).slice(7, 31);
        const child =
          dispatch.requestedBinding.worktreePolicy === "dedicated-child";
        const placementPath = localTargetServices.files.join(
          localTargetServices.git.managedWorktreeRoot(),
          "orchestration",
          ...(child ? [parentIdentity, "children"] : []),
          identity
        );
        const branch = `kmux/work-${identity}`;
        if (await localTargetServices.files.exists(placementPath)) {
          const existing = await localTargetServices.git.inspect(
            placementPath,
            { dirtyLimit: 0 }
          );
          if (
            !existing.repository ||
            existing.branch !== branch ||
            realpathSync.native(
              resolveLocalPath({
                kind: "local",
                path: existing.repository.commonGitDir
              })
            ) !== commonGitDir ||
            realpathSync.native(
              resolveLocalPath({
                kind: "local",
                path: existing.repository.root
              })
            ) !==
              realpathSync.native(
                resolveLocalPath({ kind: "local", path: placementPath })
              )
          ) {
            throw new Error(
              "existing Agent worktree does not match this Run binding"
            );
          }
        } else {
          const baseRef = inspection.branch || "HEAD";
          const outcome = await localTargetServices.git.createWorktree({
            workspaceId: workspace.id,
            cwd: workspaceCwd,
            path: placementPath,
            branch,
            baseRef,
            product: {
              name: `work-${identity}`,
              path: resolveLocalPath({ kind: "local", path: placementPath }),
              repoRoot: repositoryRoot,
              commonGitDir,
              baseRef,
              branch,
              createdByKmux: true
            }
          });
          if (outcome.status !== "succeeded") {
            throw new Error(
              outcome.status === "failed"
                ? outcome.message
                : `Agent worktree creation requires reconciliation: ${outcome.reason}`
            );
          }
        }
        workspaceCwd = placementPath;
      } else if (
        dispatch.requestedBinding.worktreePolicy === "target-repository-new"
      ) {
        const stateValue = attempt.resolvedInputs.repositoryState;
        const repositoryState =
          stateValue &&
          typeof stateValue === "object" &&
          !Array.isArray(stateValue)
            ? stateValue
            : undefined;
        const worktreeRef =
          repositoryState?.worktreeRef &&
          typeof repositoryState.worktreeRef === "object" &&
          !Array.isArray(repositoryState.worktreeRef)
            ? repositoryState.worktreeRef
            : undefined;
        const source =
          typeof worktreeRef?.pathToken === "string"
            ? await localWorktreeForToken(
                worktreeRef.pathToken,
                state,
                workspace
              )
            : undefined;
        const headOid =
          typeof repositoryState?.headOid === "string"
            ? repositoryState.headOid
            : undefined;
        const repositoryId =
          typeof repositoryState?.repositoryId === "string"
            ? repositoryState.repositoryId
            : undefined;
        const worktreeId =
          typeof worktreeRef?.worktreeId === "string"
            ? worktreeRef.worktreeId
            : undefined;
        if (!source || !headOid || !repositoryId || !worktreeId) {
          throw new Error(
            "reviewer placement requires one trusted local Repository State"
          );
        }
        executionWorkspace = source.workspace;
        const sourceCwd = source.cwd;
        const inspection = await localTargetServices.git.inspect(sourceCwd, {
          dirtyLimit: 0
        });
        if (!inspection.repository) {
          throw new Error(
            "reviewer Repository State is no longer a git worktree"
          );
        }
        const commonGitDir = realpathSync.native(
          resolveLocalPath({
            kind: "local",
            path: inspection.repository.commonGitDir
          })
        );
        const repositoryRoot = realpathSync.native(
          resolveLocalPath({ kind: "local", path: inspection.repository.root })
        );
        if (
          contentHash({ targetId: "local", commonGitDir }) !== repositoryId ||
          contentHash({
            targetId: "local",
            repository: commonGitDir,
            worktree: repositoryRoot
          }) !== worktreeId
        ) {
          throw new Error(
            "reviewer Repository State does not match its trusted worktree identity"
          );
        }
        const artifactRef = (
          value: unknown,
          kind: string
        ): ArtifactRef | undefined => {
          const record = value as Record<string, unknown> | undefined;
          if (
            !record ||
            typeof record !== "object" ||
            Array.isArray(record) ||
            typeof record.artifactId !== "string" ||
            record.kind !== kind ||
            typeof record.contentHash !== "string" ||
            typeof record.sizeBytes !== "number"
          ) {
            return undefined;
          }
          return record as unknown as ArtifactRef;
        };
        const dirtyPatchRef = artifactRef(
          repositoryState?.dirtyPatch,
          "git-dirty-patch"
        );
        const untrackedManifestRef = artifactRef(
          repositoryState?.untrackedManifest,
          "git-untracked-manifest"
        );
        if (
          (repositoryState?.dirtyPatch !== undefined && !dirtyPatchRef) ||
          (repositoryState?.untrackedManifest !== undefined &&
            !untrackedManifestRef)
        ) {
          throw new Error(
            "reviewer Repository State artifact reference is invalid"
          );
        }
        const artifactBound = Math.min(
          run.limits.maxArtifactBytes,
          16 * 1024 * 1024
        );
        const dirtyPatch = dirtyPatchRef
          ? await orchestrationArtifacts.get({
              artifact: dirtyPatchRef,
              expectedKind: "git-dirty-patch",
              maxBytes: artifactBound
            })
          : undefined;
        const untrackedManifest = untrackedManifestRef
          ? await orchestrationArtifacts.get({
              artifact: untrackedManifestRef,
              expectedKind: "git-untracked-manifest",
              maxBytes: artifactBound
            })
          : undefined;
        const identity = contentHash({
          bindingInstanceKey: dispatch.bindingInstanceKey,
          repositoryId,
          worktreeId,
          headOid
        }).slice(7, 31);
        const reviewPath = localTargetServices.files.join(
          localTargetServices.git.managedWorktreeRoot(),
          "orchestration-reviews",
          identity
        );
        if (await localTargetServices.files.exists(reviewPath)) {
          const captured = await localTargetServices.git.captureState?.(
            reviewPath,
            {
              maxDirtyPatchBytes: artifactBound,
              maxUntrackedManifestBytes: artifactBound
            }
          );
          if (
            !captured ||
            captured.headOid !== headOid ||
            (typeof repositoryState?.indexTreeHash === "string" &&
              captured.indexTreeHash !== repositoryState.indexTreeHash) ||
            digestArtifactBytes(captured.dirtyPatch) !==
              dirtyPatchRef?.contentHash ||
            digestArtifactBytes(captured.untrackedManifest) !==
              untrackedManifestRef?.contentHash
          ) {
            throw new Error(
              "existing reviewer worktree does not match the requested Repository State"
            );
          }
        } else {
          const branch = `kmux/review-${identity}`;
          const outcome = await localTargetServices.git.createWorktree({
            workspaceId: source.workspace.id,
            cwd: sourceCwd,
            path: reviewPath,
            branch,
            baseRef: headOid,
            product: {
              name: `review-${identity}`,
              path: resolveLocalPath({ kind: "local", path: reviewPath }),
              repoRoot: resolveLocalPath({
                kind: "local",
                path: inspection.repository.root
              }),
              commonGitDir: resolveLocalPath({
                kind: "local",
                path: inspection.repository.commonGitDir
              }),
              baseRef: headOid,
              branch,
              createdByKmux: true
            }
          });
          if (outcome.status !== "succeeded") {
            throw new Error(
              outcome.status === "failed"
                ? outcome.message
                : `reviewer worktree outcome is ${outcome.reason}`
            );
          }
          if (!localTargetServices.git.materializeState) {
            throw new Error(
              "target cannot materialize an exact reviewer Repository State"
            );
          }
          await localTargetServices.git.materializeState(reviewPath, {
            headOid,
            ...(typeof repositoryState?.indexTreeHash === "string"
              ? { indexTreeHash: repositoryState.indexTreeHash }
              : {}),
            ...(dirtyPatch ? { dirtyPatch } : {}),
            ...(untrackedManifest ? { untrackedManifest } : {})
          });
        }
        workspaceCwd = reviewPath;
      }
      const agentId = resolveBuiltinAgentId(dispatch.selectedAgentId);
      if (!agentId) {
        throw new Error(
          `Agent '${dispatch.selectedAgentId}' is not a supported local integration`
        );
      }
      const settings = Object.fromEntries(
        normalizeBuiltinAgentScopeSettings(
          resolveAgentScopeSettings(runtime.getState().settings.agents, "local")
        )
      );
      const launch = resolveBuiltinAgentLaunchPolicy({
        agentId,
        settings: Object.hasOwn(settings, agentId)
          ? settings[agentId]
          : undefined,
        preferences: dispatch.requestedLaunch
      });
      if (
        !launch ||
        !resolvedAgentCommandIsAvailable(launch.command, launchEnv)
      ) {
        throw new AgentPreparationError(
          "agent-launch-unavailable",
          `Agent '${agentId}' executable is unavailable`
        );
      }
      if (
        dispatch.requestedBinding.sessionPolicy === "existing" ||
        dispatch.requestedBinding.surfacePolicy === "existing"
      ) {
        if (
          dispatch.requestedLaunch.model !== undefined ||
          dispatch.requestedLaunch.effort !== undefined
        ) {
          throw new Error(
            "model or effort launch preferences cannot target an existing Agent terminal"
          );
        }
        const surfaceId = dispatch.requestedBinding.existingSurfaceId;
        if (!surfaceId) {
          throw new Error(
            "existing Surface policy requires an explicit Surface selection"
          );
        }
        const session = terminalSessionForSurface(state, surfaceId);
        const ref = session
          ? orchestrationPtyHost.sessionRef(surfaceId, session.id)
          : undefined;
        if (!session || !ref) {
          throw new Error("the selected existing Surface is not live locally");
        }
        const execution = {
          targetId: "local",
          targetAuthority: `desktop:${desktopInstallationId}`,
          surfaceId,
          sessionId: session.id,
          generation: { kind: "local" as const, runtimeEpoch: ref.epoch },
          inputAuthorityRef: makeId("input-authority")
        };
        const priorDispatch = Object.values(run.dispatches).find(
          (candidate) =>
            candidate.execution?.surfaceId === surfaceId &&
            candidate.execution.sessionId === session.id &&
            candidate.selectedAgentId === agentId &&
            candidate.launchReceipt
        );
        if (!priorDispatch?.launchReceipt) {
          throw new AgentPreparationNeedsAttentionError(
            "agent-launch-reuse-mismatch",
            "The exact prior Agent Dispatch is unavailable for reuse"
          );
        }
        return {
          execution,
          cwd: resolveLocalPath(session.runtimeMetadata.cwd),
          launchReceipt: {
            ...priorDispatch.launchReceipt,
            requested: { ...dispatch.requestedLaunch }
          },
          priorOwnership: {
            owner: "runtime"
          }
        };
      }
      prepareBuiltinAgentWorkspaceTrust({
        agentId,
        cwd: resolveLocalPath({ kind: "local", path: workspaceCwd }),
        homeDir: userHomeDir,
        env: launchEnv
      });
      const currentState = runtime.getState();
      const preferredPaneId =
        executionWorkspace.id === workspace.id
          ? coordinatorPlacement.paneId
          : executionWorkspace.activePaneId;
      const pane =
        currentState.panes[preferredPaneId]?.workspaceId ===
        executionWorkspace.id
          ? currentState.panes[preferredPaneId]
          : currentState.panes[executionWorkspace.activePaneId];
      if (!pane) throw new Error("workspace has no active pane");
      const { surfaceId } = await localTargetServices.terminal
        .create({
          workspaceId: executionWorkspace.id,
          paneId: pane.id,
          placement: {
            kind: "right-preview",
            sourceSurfaceId: pane.activeSurfaceId
          },
          launch: {
            cwd: workspaceCwd,
            title: `${agentId} · orchestration`
          }
        })
        .catch((error: unknown) => {
          throw new AgentPreparationError(
            "surface-creation-failed",
            error instanceof Error ? error.message : String(error)
          );
        });
      const nextState = runtime.getState();
      const session = surfaceId
        ? terminalSessionForSurface(nextState, surfaceId)
        : undefined;
      if (!surfaceId || !session) {
        throw new AgentPreparationError(
          "surface-creation-failed",
          "fresh Agent Surface was not created"
        );
      }
      const ref = orchestrationPtyHost.sessionRef(surfaceId, session.id);
      if (!ref) {
        throw new AgentPreparationError(
          "agent-launch-failed",
          "fresh Agent terminal generation was not bound"
        );
      }
      const execution = {
        targetId: "local",
        targetAuthority: `desktop:${desktopInstallationId}`,
        surfaceId,
        sessionId: session.id,
        generation: { kind: "local" as const, runtimeEpoch: ref.epoch },
        inputAuthorityRef: makeId("input-authority")
      };
      const launchReceipt: AgentLaunchReceipt = {
        requested: { ...dispatch.requestedLaunch },
        effective: {
          ...(launch.launchPreferences?.effective ?? {})
        },
        evidence: "executor-applied" as const,
        agentDescriptorRevision: launch.agentDescriptorRevision ?? "unknown"
      };
      return {
        execution,
        cwd: resolveLocalPath(session.runtimeMetadata.cwd),
        launchReceipt,
        start: async () => {
          await orchestrationPtyHost.waitForInputReady(ref);
          await localTargetServices.terminal.sendText(
            session.id,
            `${formatAgentCommandForShell([launch.command, ...launch.args])}\r`
          );
        }
      };
    },
    captureRepositoryState: async ({ execution }) =>
      (
        await orchestrationRepositoryState.capture({
          execution,
          maxArtifactBytes: 16 * 1024 * 1024
        })
      )?.state,
    mutations: {
      persistInputControl: (input) =>
        orchestrationHost.persistAttemptInputControl(input),
      observePreparationInput: (input) =>
        orchestrationHost.observePreparationInput(input),
      persistPending: (input) =>
        orchestrationHost.persistPendingPromptDelivery(input),
      settleDelivery: (input) => orchestrationHost.settlePromptDelivery(input),
      markPreparationFailed: (input) =>
        orchestrationHost.failPreparation(input),
      markPreparationNeedsAttention: (input) =>
        orchestrationHost.requirePreparationAttention(input)
    }
  });
  const localShellExecutor = new LocalShellNodeExecutor({
    ptyHost: orchestrationPtyHost,
    id: makeId,
    prepareSurface: async ({ run, attempt, command }) => {
      const state = runtime.getState();
      const workspace = run.workspaceId
        ? state.workspaces[run.workspaceId]
        : undefined;
      if (!workspace || workspace.location.target.kind !== "local") {
        throw new Error("local Shell execution requires a local workspace");
      }
      const node = run.graph.nodes[attempt.nodeId];
      if (
        node?.definition.kind !== "shell" ||
        node.definition.config.targetPolicy !== "local"
      ) {
        throw new Error("local v1 Shell supports only the local target policy");
      }
      const coordinatorPlacement = await localRunWorkspacePlacement(
        run,
        workspace
      );
      let executionWorkspace = workspace;
      let executionCwd = coordinatorPlacement.cwd;
      if (node.definition.config.cwdPolicy === "from-input") {
        const inputName = node.definition.config.cwdInput?.target;
        const input = inputName ? attempt.resolvedInputs[inputName] : undefined;
        const pathToken = worktreePathToken(input);
        const located = pathToken
          ? await localWorktreeForToken(pathToken, state, workspace)
          : undefined;
        if (!located) {
          throw new Error(
            "from-input Shell cwd has no matching trusted worktree receipt"
          );
        }
        executionWorkspace = located.workspace;
        executionCwd = located.cwd;
      }
      const currentState = runtime.getState();
      const preferredPaneId =
        executionWorkspace.id === workspace.id
          ? coordinatorPlacement.paneId
          : executionWorkspace.activePaneId;
      const pane =
        currentState.panes[preferredPaneId]?.workspaceId ===
        executionWorkspace.id
          ? currentState.panes[preferredPaneId]
          : currentState.panes[executionWorkspace.activePaneId];
      if (!pane) throw new Error("workspace has no active pane");
      const cwd = resolveLocalPath({
        kind: "local",
        path: executionCwd
      });
      const definition = node.definition;
      return async (operationId) => {
        const { surfaceId } = await localTargetServices.terminal.create({
          workspaceId: executionWorkspace.id,
          paneId: pane.id,
          launch: {
            cwd: executionCwd,
            shell: command.executable,
            args: [...command.args],
            env: {
              ...command.env,
              KMUX_ORCHESTRATION_COMMAND_ID: operationId,
              KMUX_ORCHESTRATION_RESULT_MODE: definition.config.resultMode,
              KMUX_ORCHESTRATION_COMMAND_MAX_BYTES: String(
                definition.config.maxOutputBytes
              )
            },
            title: `${definition.title} · workflow`
          }
        });
        const nextState = runtime.getState();
        const session = surfaceId
          ? terminalSessionForSurface(nextState, surfaceId)
          : undefined;
        if (!surfaceId || !session) {
          throw new Error("managed Shell Surface was not created");
        }
        const ref = orchestrationPtyHost.sessionRef(surfaceId, session.id);
        if (!ref)
          throw new Error("managed Shell terminal generation was not bound");
        const processId = await orchestrationPtyHost.waitForSessionPid(
          session.id,
          10_000
        );
        return {
          execution: {
            targetId: "local",
            targetAuthority: `desktop:${desktopInstallationId}`,
            surfaceId,
            sessionId: session.id,
            generation: { kind: "local", runtimeEpoch: ref.epoch },
            inputAuthorityRef: makeId("shell-input-authority")
          },
          processId,
          cwd
        };
      };
    },
    mutations: {
      recordIntent: (input) => orchestrationHost.recordShellIntent(input),
      bindExecution: (input) => orchestrationHost.bindShellExecution(input),
      settle: (input) => orchestrationHost.settleShell(input),
      markPreparationFailed: (input) =>
        orchestrationHost.failPreparation(input),
      markOutcomeUnknown: (input) =>
        orchestrationHost.markShellOutcomeUnknown(input)
    }
  });
  orchestrationHost.configureExecution({
    getWorkerTerminalPolicy: () =>
      runtime.getState().settings.orchestrationWorkerPolicy ?? {
        succeeded: "retain",
        failed: "retain"
      },
    verifyCoordinatorCaller: async (attachment, callerPid) => {
      if (attachment.transport === "terminal") {
        await verifyTerminalCoordinator(
          orchestrationPtyHost.sessionPid(attachment.sessionId),
          callerPid,
          attachment.process
        );
      }
    },
    resolveCallerRepositoryIdentity: async (attachment) => {
      const captured = await orchestrationRepositoryState.capture({
        execution: attachment.execution,
        maxArtifactBytes: 16 * 1024 * 1024
      });
      if (!captured)
        throw new Error(
          "Calling Agent requires an available repository in its current terminal"
        );
      return (
        captured.state.worktreeRef?.worktreeId ?? captured.state.repositoryId
      );
    },
    resolveRunWorkspaceId: (principal) => {
      const state = runtime.getState();
      const sessionId = principal.startsWith("session:")
        ? principal.slice("session:".length)
        : undefined;
      const session = sessionId ? state.sessions[sessionId] : undefined;
      const surface = session ? state.surfaces[session.surfaceId] : undefined;
      const pane = surface ? state.panes[surface.paneId] : undefined;
      const workspaceId = sessionId
        ? pane?.workspaceId
        : state.windows[state.activeWindowId]?.activeWorkspaceId;
      if (!workspaceId || !state.workspaces[workspaceId]) {
        throw new Error(
          "Run creation requires an available execution workspace"
        );
      }
      return workspaceId;
    },
    driver: localAgentExecutor,
    shellDriver: localShellExecutor,
    isExecutionCurrent: (execution) => {
      if (execution.generation.kind !== "local") return false;
      const current = orchestrationPtyHost.sessionRef(
        execution.surfaceId,
        execution.sessionId
      );
      return current?.epoch === execution.generation.runtimeEpoch;
    },
    trustedResultAssembler: {
      assemble: async ({ run, attempt, submission }) => {
        if (submission.artifacts && submission.artifacts.length > 0) {
          throw new Error(
            "Agent-supplied artifact references are unsupported until trusted artifact ingestion is enabled"
          );
        }
        const dispatch = attempt.dispatchId
          ? run.dispatches[attempt.dispatchId]
          : undefined;
        if (
          !dispatch?.execution ||
          dispatch.execution.generation.kind !== "local"
        ) {
          throw new Error("result attempt has no exact local execution");
        }
        const live = orchestrationPtyHost.sessionRef(
          dispatch.execution.surfaceId,
          dispatch.execution.sessionId
        );
        if (
          !live ||
          live.epoch !== dispatch.execution.generation.runtimeEpoch
        ) {
          throw new Error(
            "result submission terminal generation is no longer live"
          );
        }
        const captured = await orchestrationRepositoryState.capture({
          execution: dispatch.execution,
          maxArtifactBytes: run.limits.maxArtifactBytes
        });
        const node = run.graph.nodes[attempt.nodeId];
        if (
          node?.definition.kind === "agent" &&
          node.definition.config.coding &&
          !captured
        ) {
          throw new Error("coding Agent results require trusted Git state");
        }
        if (
          node?.definition.kind === "agent" &&
          !node.definition.config.coding &&
          dispatch.repositoryStateInput &&
          captured &&
          (captured.state.headOid !== dispatch.repositoryStateInput.headOid ||
            captured.state.dirtyPatchHash !==
              dispatch.repositoryStateInput.dirtyPatchHash ||
            captured.state.untrackedManifest?.contentHash !==
              dispatch.repositoryStateInput.untrackedManifest?.contentHash)
        ) {
          throw new Error(
            "read-only Agent changed the captured repository state"
          );
        }
        return {
          ...(captured
            ? {
                repositoryState: captured.state,
                filesModified: captured.changedPaths
              }
            : {})
        };
      }
    }
  });
  orchestrationPtyHost.on("event", (event) => {
    if (event.type === "input.observed" && event.session.epoch !== undefined) {
      lastUserInputAtByGeneration.set(
        localGenerationKey(
          event.session.surfaceId,
          event.session.sessionId,
          event.session.epoch
        ),
        new Date().toISOString()
      );
      void orchestrationHost
        .observeUserTerminalInput({
          surfaceId: event.session.surfaceId,
          sessionId: event.session.sessionId,
          runtimeEpoch: event.session.epoch
        })
        .catch((error) => {
          console.error(
            "Failed to retain a completed Worker after user input",
            error
          );
        });
    }
  });
  return { ptyHost: orchestrationPtyHost, readiness: localAgentReadiness };
}
function digestArtifactBytes(
  bytes: Uint8Array | undefined
): string | undefined {
  return bytes
    ? `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    : undefined;
}
