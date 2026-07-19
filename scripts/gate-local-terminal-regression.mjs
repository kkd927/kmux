import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

import {
  classifyLocalTerminalSampleEvidence,
  deriveLocalTerminalExecutionPlan,
  evaluateLocalTerminalEnvironment,
  evaluateLocalTerminalCandidate
} from "./local-terminal-regression-contract.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = join(
  workspaceRoot,
  "tests",
  "e2e",
  "fixtures",
  "local-terminal-regression-gates.v1.json"
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const executionPlan = deriveLocalTerminalExecutionPlan(fixture);

const requestedEvidenceRoot = parseEvidenceRoot(process.argv.slice(2));
const shortTempBase = existsSync("/tmp") ? "/tmp" : process.env.TMPDIR;
if (!shortTempBase)
  throw new Error("a short temporary directory is unavailable");
const runRoot = mkdtempSync(join(shortTempBase, "klg-"));
const evidenceRoot = requestedEvidenceRoot
  ? resolve(requestedEvidenceRoot)
  : join(runRoot, "evidence");
const rawRoot = join(evidenceRoot, "raw");
mkdirSync(rawRoot, { recursive: true });

const gateStartedAt = new Date().toISOString();
const samples = [];
const rawFiles = [];
const infrastructureFailures = [];
const workloadFailures = [];
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const environment = captureEnvironment(npmCommand);
const environmentCompatibility = evaluateLocalTerminalEnvironment(
  fixture,
  environment
);
if (!environmentCompatibility.passed) {
  infrastructureFailures.push({
    stage: "environment-preflight",
    reason:
      "candidate environment does not match the immutable pre-SSH baseline",
    mismatches: environmentCompatibility.mismatches
  });
}
const preparationRoot = join(evidenceRoot, "preparation");
mkdirSync(preparationRoot, { recursive: true });
const preparation = {
  startedAt: new Date().toISOString(),
  steps: []
};

for (const [index, script] of executionPlan.preparationScripts.entries()) {
  if (infrastructureFailures.length > 0) break;
  const startedAt = new Date().toISOString();
  const child = spawnSync(npmCommand, ["run", script], {
    cwd: workspaceRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  const logPath = join(
    preparationRoot,
    `${String(index + 1).padStart(2, "0")}-${script.replaceAll(":", "-")}.log`
  );
  const log = [
    child.stdout ?? "",
    child.stderr ? `\n${child.stderr}` : ""
  ].join("");
  writeFileSync(logPath, log, "utf8");
  const completedAt = new Date().toISOString();
  const step = {
    order: index + 1,
    command: `npm run ${script}`,
    startedAt,
    completedAt,
    exitCode: child.status,
    signal: child.signal,
    log: describeEvidenceFile("command-log", logPath)
  };
  preparation.steps.push(step);
  if (child.status !== 0) {
    infrastructureFailures.push({
      stage: "candidate-preparation",
      command: step.command,
      startedAt,
      completedAt,
      exitCode: child.status,
      signal: child.signal,
      reason: "candidate preparation failed before measurement"
    });
    break;
  }
}
preparation.completedAt = new Date().toISOString();
preparation.passed = infrastructureFailures.length === 0;
const measuredAtStart = new Date().toISOString();

for (
  let runId = 1;
  infrastructureFailures.length === 0 && runId <= executionPlan.measuredRuns;
  runId += 1
) {
  const runTemp = join(runRoot, `r${runId}`);
  const runEvidence = join(rawRoot, `run-${runId}`);
  mkdirSync(runTemp, { recursive: true });
  mkdirSync(runEvidence, { recursive: true });
  const startedAt = new Date().toISOString();
  const child = spawnSync(npmCommand, ["run", executionPlan.sampleScript], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      TMPDIR: runTemp,
      KMUX_LOCAL_REGRESSION_SAMPLE_ONLY: "1"
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  const logPath = join(runEvidence, "run.log");
  const log = [
    child.stdout ?? "",
    child.stderr ? `\n${child.stderr}` : ""
  ].join("");
  writeFileSync(logPath, log, "utf8");
  rawFiles.push(describeFile(runId, "command-log", logPath));

  const steady = parseMetricMarker(log, "kmux-steady-metrics");
  const burst = parseMetricMarker(log, "kmux-burst-metrics");
  const steadyProfile = copyProfile(
    runId,
    runTemp,
    runEvidence,
    "kmux-data-plane-gate-",
    "steady-burst-profile.jsonl",
    rawFiles
  );
  const ringProfile = copyProfile(
    runId,
    runTemp,
    runEvidence,
    "kmux-ring-gap-gate-",
    "ring-gap-profile.jsonl",
    rawFiles
  );
  const testResults = join(workspaceRoot, "test-results");
  if (existsSync(testResults)) {
    cpSync(testResults, join(runEvidence, "test-results"), {
      recursive: true
    });
  }

  const evidenceStatus = classifyLocalTerminalSampleEvidence({
    steady,
    burst,
    steadyProfile,
    ringProfile,
    exitCode: child.status,
    signal: child.signal,
    spawnError: Boolean(child.error)
  });
  if (evidenceStatus.kind !== "complete") {
    const failure = {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: child.status,
      signal: child.signal,
      missing: evidenceStatus.missing,
      reason:
        evidenceStatus.kind === "workload-failure"
          ? "the workload failed before emitting its complete metric/profile evidence"
          : "the workload did not start and could not emit complete metric/profile evidence"
    };
    if (evidenceStatus.kind === "infrastructure-failure") {
      infrastructureFailures.push(failure);
      break;
    }
    workloadFailures.push(failure);
    samples.push({
      runId,
      startedAt,
      completedAt: failure.completedAt,
      steady: steady ?? null,
      burst: burst ?? null,
      evidenceComplete: false,
      functionalPassed: false,
      exitCode: child.status,
      signal: child.signal
    });
    continue;
  }

  samples.push({
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    steady,
    burst,
    evidenceComplete: true,
    functionalPassed: child.status === 0 && /\b3 passed\b/u.test(log),
    exitCode: child.status,
    signal: child.signal
  });
}

let evaluation;
if (infrastructureFailures.length === 0 && workloadFailures.length === 0) {
  evaluation = evaluateLocalTerminalCandidate(fixture, samples);
}
const report = {
  schemaVersion: 1,
  fixture: fixturePath,
  command: fixture.command,
  candidatePreparation: fixture.candidatePreparation,
  sampleCommand: fixture.sampleCommand,
  startedAt: gateStartedAt,
  preparation,
  measuredAt: `${measuredAtStart}/${new Date().toISOString()}`,
  environment,
  environmentCompatibility,
  runRoot,
  evidenceRoot,
  samples,
  rawFiles,
  infrastructureFailures,
  workloadFailures,
  evaluation: evaluation ?? null,
  result:
    infrastructureFailures.length > 0
      ? "failed: incomplete infrastructure evidence"
      : workloadFailures.length > 0
        ? "failed: workload evidence incomplete"
        : evaluation.passed
          ? "passed"
          : "failed"
};
const reportPath = join(evidenceRoot, "local-terminal-regression-gate.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (report.result === "passed") {
  process.stdout.write(
    `local terminal regression gate passed (${samples.length} candidate runs)\n`
  );
} else {
  process.stderr.write(`${report.result}\n`);
  if (evaluation) {
    process.stderr.write(
      `numeric failures: ${evaluation.numericFailures.join(", ") || "none"}\n`
    );
    process.stderr.write(
      `functional failed runs: ${evaluation.functional.failedRuns.join(", ") || "none"}\n`
    );
    process.stderr.write(
      `bound failed runs: ${evaluation.bounds.failedRuns.join(", ") || "none"}\n`
    );
  }
  if (workloadFailures.length > 0) {
    process.stderr.write(
      `workload failed runs: ${workloadFailures.map(({ runId }) => runId).join(", ")}\n`
    );
  }
  process.exitCode = 1;
}
process.stdout.write(`evidence: ${reportPath}\n`);

function parseEvidenceRoot(args) {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--evidence-root" && args[1]) {
    return args[1];
  }
  throw new Error(
    "usage: node scripts/gate-local-terminal-regression.mjs [--evidence-root PATH]"
  );
}

function parseMetricMarker(log, marker) {
  const match = log.match(new RegExp(`\\[${marker}\\] (\\{[^\\n]+\\})`, "u"));
  return match ? JSON.parse(match[1]) : undefined;
}

function copyProfile(
  runId,
  runTemp,
  runEvidence,
  prefix,
  destinationName,
  evidence
) {
  const matches = readdirSync(runTemp, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => join(runTemp, entry.name, "profile.jsonl"))
    .filter(existsSync);
  if (matches.length !== 1) return undefined;
  const destination = join(runEvidence, destinationName);
  copyFileSync(matches[0], destination);
  evidence.push(describeFile(runId, destinationName, destination, matches[0]));
  return destination;
}

function describeFile(runId, kind, path, source) {
  return {
    runId,
    ...describeEvidenceFile(kind, path, source)
  };
}

function describeEvidenceFile(kind, path, source) {
  const bytes = readFileSync(path);
  return {
    kind,
    ...(source ? { source } : {}),
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function captureEnvironment(command) {
  const npm = spawnSync(command, ["--version"], {
    cwd: workspaceRoot,
    encoding: "utf8"
  });
  const packageJson = JSON.parse(
    readFileSync(join(workspaceRoot, "package.json"), "utf8")
  );
  const cpuList = cpus();
  const currentPlatform = platform();
  return {
    platform: currentPlatform,
    architecture: arch(),
    productVersion: readProductVersion(currentPlatform),
    release: release(),
    physicalCpuCores: readPhysicalCpuCores(currentPlatform),
    logicalCpuCores: cpuList.length,
    cpuModel: cpuList[0]?.model ?? "unknown",
    memoryBytes: totalmem(),
    node: process.versions.node,
    npm: npm.status === 0 ? npm.stdout.trim() : "unknown",
    electron: readInstalledElectronVersion(packageJson),
    workspace: basename(workspaceRoot)
  };
}

function readProductVersion(currentPlatform) {
  if (currentPlatform !== "darwin") return release();
  return readCommandValue("sw_vers", ["-productVersion"]);
}

function readPhysicalCpuCores(currentPlatform) {
  if (currentPlatform === "darwin") {
    return parsePositiveInteger(
      readCommandValue("sysctl", ["-n", "hw.physicalcpu"])
    );
  }
  if (currentPlatform === "linux") {
    const output = readCommandValue("lscpu", ["-p=CORE,SOCKET"]);
    if (output === "unknown") return "unknown";
    const cores = new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
    );
    return cores.size > 0 ? cores.size : "unknown";
  }
  return "unknown";
}

function readInstalledElectronVersion(packageJson) {
  try {
    const installed = JSON.parse(
      readFileSync(
        join(workspaceRoot, "node_modules", "electron", "package.json"),
        "utf8"
      )
    );
    if (typeof installed.version === "string" && installed.version) {
      return installed.version;
    }
  } catch {
    // The preparation step will report a missing dependency separately.
  }
  return packageJson.devDependencies?.electron ?? "unknown";
}

function readCommandValue(command, args) {
  const child = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8"
  });
  return child.status === 0 && child.stdout.trim()
    ? child.stdout.trim()
    : "unknown";
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : "unknown";
}
