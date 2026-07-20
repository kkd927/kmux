import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensurePrivateControlRoot,
  startParentDeathGuard,
  SshTransportPool,
  SshTransportPoolError,
  type RunningSshMaster,
  type SshMasterFactory
} from "./sshTransportPool";

const POLICY_A = "a".repeat(64);
const POLICY_B = "b".repeat(64);

describe("SSH ControlPath root", () => {
  it("creates a missing explicit root privately and rejects an exposed root", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-control-root-"));
    try {
      const privateRoot = join(sandbox, "cache", "ssh-control");
      await ensurePrivateControlRoot(privateRoot);
      await expect(
        ensurePrivateControlRoot(privateRoot)
      ).resolves.toBeUndefined();

      const exposedRoot = join(sandbox, "exposed");
      await ensurePrivateControlRoot(exposedRoot);
      chmodSync(exposedRoot, 0o755);
      await expect(ensurePrivateControlRoot(exposedRoot)).rejects.toMatchObject(
        {
          code: "invalid-request"
        }
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("cleans an owned process on lease loss but not after explicit cancellation", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-parent-guard-"));
    const socketPath = join(sandbox, "ready.sock");
    const markerPath = join(sandbox, "cleaned");
    const server = createServer();
    const watched = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { stdio: "ignore" }
    );
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socketPath, () => resolveListen());
      });
      if (watched.pid === undefined) throw new Error("watch fixture failed");
      const options = {
        watchedPid: watched.pid,
        readySocketPath: socketPath,
        cleanupExecutable: "/bin/sh",
        cleanupArgs: [
          "-c",
          'printf cleanup > "$1"',
          "kmux-parent-guard-cleanup",
          markerPath
        ]
      };

      const cancelled = await startParentDeathGuard(options);
      await cancelled.cancel();
      expect(existsSync(markerPath)).toBe(false);

      const orphaned = await startParentDeathGuard(options);
      await orphaned.cleanupNow();
      expect(readFileSync(markerPath, "utf8")).toBe("cleanup");
    } finally {
      watched.kill("SIGKILL");
      if (server.listening) {
        await new Promise<void>((resolveClose) =>
          server.close(() => resolveClose())
        );
      }
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("cleans the watched process after its actual owner is killed", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kmux-parent-crash-"));
    const socketPath = join(sandbox, "ready.sock");
    const markerPath = join(sandbox, "watched-stopped");
    const server = createServer();
    const ownerScript = String.raw`
        import { once } from "node:events";
        import { spawn } from "node:child_process";

        const socketPath = process.argv[1];
        const markerPath = process.argv[2];
        const { startParentDeathGuard } = await import(
          "./apps/desktop/src/remote-host/sshTransportPool.ts"
        );
        const watched = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            'import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => { writeFileSync(process.env.KMUX_GUARD_MARKER, "cleanup", "utf8"); process.exit(0); }); process.stdout.write("ready\\n"); setInterval(() => undefined, 1000);'
          ],
          {
            env: { ...process.env, KMUX_GUARD_MARKER: markerPath },
            stdio: ["ignore", "pipe", "ignore"]
          }
        );
        await once(watched.stdout, "data");
        if (watched.pid === undefined) throw new Error("watched process has no PID");
        const guard = await startParentDeathGuard({
          watchedPid: watched.pid,
          readySocketPath: socketPath,
          cleanupExecutable: "/bin/kill",
          cleanupArgs: ["-TERM", String(watched.pid)]
        });
        process.stdout.write("READY " + watched.pid + "\n");
        void guard;
        setInterval(() => undefined, 1000);
      `;
    const owner = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        ownerScript,
        socketPath,
        markerPath
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let watchedPid: number | undefined;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socketPath, () => resolveListen());
      });
      const readyLine = await readOutputLine(owner);
      const match = /^READY ([1-9][0-9]*)$/u.exec(readyLine);
      if (!match) throw new Error(`unexpected owner output: ${readyLine}`);
      const runningWatchedPid = Number(match[1]);
      watchedPid = runningWatchedPid;

      expect(owner.kill("SIGKILL")).toBe(true);
      await waitForChildClose(owner);
      await eventually(() => existsSync(markerPath));

      expect(readFileSync(markerPath, "utf8")).toBe("cleanup");
      await eventually(() => !isProcessRunning(runningWatchedPid));
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill("SIGKILL");
        await waitForChildClose(owner).catch(() => undefined);
      }
      if (watchedPid !== undefined && isProcessRunning(watchedPid)) {
        process.kill(watchedPid, "SIGKILL");
      }
      if (server.listening) {
        await new Promise<void>((resolveClose) =>
          server.close(() => resolveClose())
        );
      }
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 10_000);
});

async function readOutputLine(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5_000
): Promise<string> {
  return await new Promise<string>((resolveLine, rejectLine) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      rejectLine(new Error(`timed out waiting for owner output: ${stderr}`));
    }, timeoutMs);
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolveLine(stdout.slice(0, newline));
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString("utf8");
    };
    const onClose = (): void => {
      cleanup();
      rejectLine(new Error(`owner closed before readiness: ${stderr}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("close", onClose);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("close", onClose);
  });
}

async function waitForChildClose(
  child: ReturnType<typeof spawn>
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveClose) => child.once("close", resolveClose));
}

async function eventually(
  predicate: () => boolean,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("SSH transport pool assignment", () => {
  it("keeps an authority-verification master outside the target assignment map until promotion", async () => {
    const pool = new SshTransportPool(fakeMasterFactory([]));
    await pool.connectProvisional(request("attempt-a", POLICY_A));
    const verifying = await pool.beginAuthorityVerification({
      connectionAttemptId: "attempt-a",
      verificationId: "verification-a",
      effectiveConnectionPolicyHash: POLICY_A
    });

    expect(pool.getAssigned("verification-a")).toBeUndefined();
    expect(
      pool.isCurrentGeneration("verification-a", verifying.generation)
    ).toBe(true);
    const assigned = await pool.promoteAuthorityVerification({
      verificationId: "verification-a",
      targetId: "target-1",
      effectiveConnectionPolicyHash: POLICY_A
    });

    expect(assigned.targetId).toBe("target-1");
    expect(pool.getAssigned("target-1")?.generation).toBe(verifying.generation);
    expect(
      pool.isCurrentGeneration("verification-a", verifying.generation)
    ).toBe(false);
    await pool.close();
  });

  it("converges two authority-equivalent verifications before target feature use", async () => {
    const stopped: string[] = [];
    const pool = new SshTransportPool(fakeMasterFactory(stopped));
    await Promise.all([
      pool.connectProvisional(request("attempt-a", POLICY_A)),
      pool.connectProvisional(request("attempt-b", POLICY_A))
    ]);
    await Promise.all([
      pool.beginAuthorityVerification({
        connectionAttemptId: "attempt-a",
        verificationId: "verification-a",
        effectiveConnectionPolicyHash: POLICY_A
      }),
      pool.beginAuthorityVerification({
        connectionAttemptId: "attempt-b",
        verificationId: "verification-b",
        effectiveConnectionPolicyHash: POLICY_A
      })
    ]);

    const [first, second] = await Promise.all([
      pool.promoteAuthorityVerification({
        verificationId: "verification-a",
        targetId: "target-1",
        effectiveConnectionPolicyHash: POLICY_A
      }),
      pool.promoteAuthorityVerification({
        verificationId: "verification-b",
        targetId: "target-1",
        effectiveConnectionPolicyHash: POLICY_A
      })
    ]);

    expect(second.generation).toBe(first.generation);
    expect(stopped).toHaveLength(1);
    expect(pool.getAssigned("target-1")?.generation).toBe(first.generation);
    await pool.close();
  });

  it("discards an abandoned authority verification without publishing a target", async () => {
    const stopped: string[] = [];
    const pool = new SshTransportPool(fakeMasterFactory(stopped));
    await pool.connectProvisional(request("attempt-a", POLICY_A));
    const verifying = await pool.beginAuthorityVerification({
      connectionAttemptId: "attempt-a",
      verificationId: "verification-a",
      effectiveConnectionPolicyHash: POLICY_A
    });

    await pool.discardAuthorityVerification("verification-a");

    expect(stopped).toEqual(["attempt-a"]);
    expect(
      pool.isCurrentGeneration("verification-a", verifying.generation)
    ).toBe(false);
    expect(pool.getAssigned("verification-a")).toBeUndefined();
    await pool.close();
  });

  it("converges concurrent provisional aliases on one assigned target master", async () => {
    const stopped: string[] = [];
    const factory = fakeMasterFactory(stopped);
    const pool = new SshTransportPool(factory);
    await Promise.all([
      pool.connectProvisional(request("attempt-a", POLICY_A)),
      pool.connectProvisional(request("attempt-b", POLICY_A))
    ]);

    const [first, second] = await Promise.all([
      pool.promote({
        connectionAttemptId: "attempt-a",
        targetId: "target-1",
        effectiveConnectionPolicyHash: POLICY_A
      }),
      pool.promote({
        connectionAttemptId: "attempt-b",
        targetId: "target-1",
        effectiveConnectionPolicyHash: POLICY_A
      })
    ]);

    expect(second.generation).toBe(first.generation);
    expect(stopped).toHaveLength(1);
    expect(pool.isCurrentGeneration("target-1", first.generation)).toBe(true);
    await pool.close();
  });

  it("never binds one provisional master to two target identities", async () => {
    const pool = new SshTransportPool(fakeMasterFactory([]));
    await pool.connectProvisional(request("attempt-a", POLICY_A));

    const results = await Promise.allSettled([
      pool.promote({
        connectionAttemptId: "attempt-a",
        targetId: "target-1",
        effectiveConnectionPolicyHash: POLICY_A
      }),
      pool.promote({
        connectionAttemptId: "attempt-a",
        targetId: "target-2",
        effectiveConnectionPolicyHash: POLICY_A
      })
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(rejection?.reason).toMatchObject({ code: "attempt-conflict" });
    await pool.close();
  });

  it("rejects attempt reuse across a changed launch boundary", async () => {
    const pool = new SshTransportPool(fakeMasterFactory([]));
    await pool.connectProvisional(request("attempt-a", POLICY_A));
    await expect(
      pool.connectProvisional({
        ...request("attempt-a", POLICY_A),
        host: "other-host"
      })
    ).rejects.toMatchObject({ code: "attempt-conflict" });
    await pool.close();
  });

  it("closes a candidate instead of replacing a target across policy hashes", async () => {
    const stopped: string[] = [];
    const pool = new SshTransportPool(fakeMasterFactory(stopped));
    await pool.connectProvisional(request("attempt-a", POLICY_A));
    await pool.promote({
      connectionAttemptId: "attempt-a",
      targetId: "target-1",
      effectiveConnectionPolicyHash: POLICY_A
    });
    await pool.connectProvisional(request("attempt-b", POLICY_B));

    await expect(
      pool.promote({
        connectionAttemptId: "attempt-b",
        targetId: "target-1",
        effectiveConnectionPolicyHash: POLICY_B
      })
    ).rejects.toBeInstanceOf(SshTransportPoolError);
    expect(stopped).toContain("attempt-b");
    expect(pool.getAssigned("target-1")?.effectiveConnectionPolicyHash).toBe(
      POLICY_A
    );
    await pool.close();
  });

  it("cannot publish an assignment that finishes racing with pool close", async () => {
    const stopped: string[] = [];
    let releaseFactory: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const delegate = fakeMasterFactory(stopped);
    const pool = new SshTransportPool(async (launchRequest) => {
      await gate;
      return await delegate(launchRequest);
    });

    const connecting = pool.connectProvisional(request("attempt-a", POLICY_A));
    const promotion = pool.promote({
      connectionAttemptId: "attempt-a",
      targetId: "target-1",
      effectiveConnectionPolicyHash: POLICY_A
    });
    const closing = pool.close();
    const connectingAssertion = expect(connecting).rejects.toMatchObject({
      code: "master-closed"
    });
    const promotionAssertion = expect(promotion).rejects.toMatchObject({
      code: "master-closed"
    });
    releaseFactory?.();

    await connectingAssertion;
    await promotionAssertion;
    await closing;
    expect(pool.getAssigned("target-1")).toBeUndefined();
    expect(stopped).toEqual(["attempt-a"]);
    await expect(
      pool.connectProvisional(request("attempt-b", POLICY_A))
    ).rejects.toMatchObject({ code: "master-closed" });
  });

  it("publishes unexpected assigned-master loss and permits one replacement", async () => {
    const controls: FakeMasterControl[] = [];
    const pool = new SshTransportPool(fakeMasterFactory([], controls));
    const losses: unknown[] = [];
    pool.onTargetLost((event) => losses.push(event));
    await pool.connectProvisional(request("attempt-a", POLICY_A));
    const first = await pool.promote({
      connectionAttemptId: "attempt-a",
      targetId: "target-1",
      effectiveConnectionPolicyHash: POLICY_A
    });

    controls[0].closeUnexpectedly();
    await Promise.resolve();
    await Promise.resolve();
    expect(pool.getAssigned("target-1")).toBeUndefined();
    expect(losses).toEqual([
      {
        targetId: "target-1",
        masterGeneration: first.generation,
        code: "master-closed",
        message: "assigned OpenSSH master exited"
      }
    ]);

    await pool.connectProvisional(request("attempt-b", POLICY_A));
    const replacement = await pool.promote({
      connectionAttemptId: "attempt-b",
      targetId: "target-1",
      effectiveConnectionPolicyHash: POLICY_A
    });
    expect(replacement.generation).not.toBe(first.generation);
    await pool.close();
  });
});

function request(connectionAttemptId: string, policy: string) {
  return {
    connectionAttemptId,
    effectiveConnectionPolicyHash: policy,
    sshPath: "/usr/bin/ssh",
    configPath: "/tmp/ssh_config",
    host: "fixture"
  };
}

interface FakeMasterControl {
  closeUnexpectedly(): void;
}

function fakeMasterFactory(
  stopped: string[],
  controls: FakeMasterControl[] = []
): SshMasterFactory {
  let generation = 0;
  return async (request): Promise<RunningSshMaster> => {
    let running = true;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const close = (): void => {
      if (!running) return;
      running = false;
      resolveClosed();
    };
    controls.push({ closeUnexpectedly: close });
    return {
      connectionAttemptId: request.connectionAttemptId,
      effectiveConnectionPolicyHash: request.effectiveConnectionPolicyHash,
      generation: `generation-${++generation}`,
      controlPath: `/tmp/${request.connectionAttemptId}.sock`,
      sshPath: request.sshPath,
      configPath: request.configPath,
      host: request.host,
      closed,
      isRunning: () => running,
      check: async () => undefined,
      stop: async () => {
        if (!running) return;
        stopped.push(request.connectionAttemptId);
        close();
      }
    };
  };
}
