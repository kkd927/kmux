export const LOCAL_TERMINAL_REGRESSION_METRICS = Object.freeze({
  echoP95Ms: Object.freeze({ group: "steady", field: "echoP95Ms" }),
  echoP99Ms: Object.freeze({ group: "steady", field: "echoP99Ms" }),
  renderP95Ms: Object.freeze({ group: "steady", field: "renderP95Ms" }),
  renderP99Ms: Object.freeze({ group: "steady", field: "renderP99Ms" }),
  paintP95Ms: Object.freeze({ group: "steady", field: "paintP95Ms" }),
  schedulerMaxMs: Object.freeze({ group: "steady", field: "schedulerMaxMs" }),
  eventLoopP95Ms: Object.freeze({
    group: "steady",
    field: "eventLoopP95Ms"
  }),
  warmSwitchMaxMs: Object.freeze({
    group: "steady",
    field: "warmSwitchMaxMs"
  }),
  burstEchoP95Ms: Object.freeze({ group: "burst", field: "echoP95Ms" }),
  burstEchoP99Ms: Object.freeze({ group: "burst", field: "echoP99Ms" }),
  burstCatchUpElapsedMs: Object.freeze({
    group: "burst",
    field: "catchUpElapsedMs"
  })
});

const LOCAL_TERMINAL_PREPARATION_COMMANDS = Object.freeze([
  "npm run smoke:dev",
  "npm run build"
]);
const LOCAL_TERMINAL_SAMPLE_COMMAND =
  "npm run profile:terminal-data-plane:sample";
const LOCAL_TERMINAL_ENVIRONMENT_FIELDS = Object.freeze([
  "platform",
  "architecture",
  "productVersion",
  "physicalCpuCores",
  "memoryBytes",
  "node",
  "npm",
  "electron"
]);

export function deriveLocalTerminalExecutionPlan(fixture) {
  const contract = requireCandidateGate(fixture);
  const preparation = fixture.candidatePreparation;
  if (
    !preparation ||
    typeof preparation !== "object" ||
    Array.isArray(preparation) ||
    !Array.isArray(preparation.commands) ||
    preparation.commands.length !==
      LOCAL_TERMINAL_PREPARATION_COMMANDS.length ||
    preparation.commands.some(
      (command, index) => command !== LOCAL_TERMINAL_PREPARATION_COMMANDS[index]
    )
  ) {
    throw new TypeError(
      "candidatePreparation.commands must preserve the recognized one-time preparation"
    );
  }
  if (fixture.sampleCommand !== LOCAL_TERMINAL_SAMPLE_COMMAND) {
    throw new TypeError(
      "sampleCommand must run only the recognized measured workload"
    );
  }
  return {
    preparationScripts: ["smoke:dev", "build"],
    sampleScript: "profile:terminal-data-plane:sample",
    measuredRuns: contract.measuredRuns
  };
}

export function median(values, label = "values") {
  const sorted = values
    .map((value) => requireMetric(value, label))
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function average(values, label = "values") {
  const normalized = values.map((value) => requireMetric(value, label));
  if (normalized.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
}

export function evaluateLocalTerminalEnvironment(fixture, actual) {
  const expected = fixture?.preSshBaseline?.environment;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new TypeError("pre-SSH baseline environment must be an object");
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    throw new TypeError("candidate environment must be an object");
  }
  const mismatches = LOCAL_TERMINAL_ENVIRONMENT_FIELDS.flatMap((field) => {
    const expectedValue = normalizeEnvironmentValue(field, expected[field]);
    const actualValue = normalizeEnvironmentValue(field, actual[field]);
    return expectedValue === actualValue
      ? []
      : [
          {
            field,
            expected: expected[field] ?? null,
            actual: actual[field] ?? null
          }
        ];
  });
  return {
    passed: mismatches.length === 0,
    comparedFields: [...LOCAL_TERMINAL_ENVIRONMENT_FIELDS],
    mismatches
  };
}

export function classifyLocalTerminalSampleEvidence({
  steady,
  burst,
  steadyProfile,
  ringProfile,
  exitCode,
  signal,
  spawnError
}) {
  const missing = [
    ["steady-metrics", steady],
    ["burst-metrics", burst],
    ["steady-burst-profile", steadyProfile],
    ["ring-gap-profile", ringProfile]
  ]
    .filter(([, value]) => !value)
    .map(([kind]) => kind);
  if (missing.length === 0) {
    return { kind: "complete", missing };
  }

  // A normally launched workload that exits unsuccessfully is a gate failure,
  // even when it fails before every metric marker is emitted. Treating it as
  // replaceable infrastructure evidence would allow a functional failure to
  // disappear from the five-run set.
  const workloadStarted = !spawnError && (exitCode !== null || signal !== null);
  return {
    kind: workloadStarted ? "workload-failure" : "infrastructure-failure",
    missing
  };
}

export function deriveLocalTerminalBaselineEnvelope(fixture) {
  const contract = requireCandidateGate(fixture);
  const samples = requireSamples(
    fixture.preSshBaseline?.samples,
    contract.measuredRuns,
    "pre-SSH baseline"
  );
  const relativeAllowance = requireNonNegativeNumber(
    contract.numeric.maximumRelativeIncrease,
    "maximumRelativeIncrease"
  );
  const allowances = contract.numeric.absoluteNoiseAllowance;
  if (!allowances || typeof allowances !== "object") {
    throw new TypeError("absoluteNoiseAllowance must be an object");
  }
  const repeatabilityBatches =
    fixture.preSshBaseline?.repeatabilityBatchMedians;
  if (
    !Array.isArray(repeatabilityBatches) ||
    repeatabilityBatches.length === 0 ||
    repeatabilityBatches.length > 16
  ) {
    throw new TypeError(
      "pre-SSH repeatabilityBatchMedians must contain 1 to 16 batches"
    );
  }

  return Object.fromEntries(
    Object.entries(LOCAL_TERMINAL_REGRESSION_METRICS).map(
      ([metric, location]) => {
        const baselineValues = samples.map((sample) =>
          readMetric(sample, location, metric)
        );
        const baselineMedian = median(baselineValues, metric);
        const repeatabilityBatchMedians = repeatabilityBatches.map(
          (batch, index) => {
            if (
              !batch ||
              typeof batch !== "object" ||
              Array.isArray(batch) ||
              batch.sourceRevision !== fixture.preSshBaseline.sourceRevision ||
              batch.source !== "phase3Exit.samples[*].entry" ||
              fixture.phase3Exit?.entrySource?.revision !==
                fixture.preSshBaseline.sourceRevision ||
              !batch.metrics ||
              typeof batch.metrics !== "object" ||
              Array.isArray(batch.metrics)
            ) {
              throw new TypeError(
                `pre-SSH repeatability batch ${index + 1} is invalid`
              );
            }
            const declaredMedian = requireMetric(
              batch.metrics[metric],
              `repeatabilityBatchMedians[${index}].metrics.${metric}`
            );
            const sourceSamples = requireSamples(
              fixture.phase3Exit?.samples?.map((pair) => pair?.entry),
              contract.measuredRuns,
              `pre-SSH repeatability batch ${index + 1}`
            );
            const sourceMedian = median(
              sourceSamples.map((sample) =>
                readMetric(sample, location, metric)
              ),
              `pre-SSH repeatability batch ${index + 1} ${metric}`
            );
            if (declaredMedian !== sourceMedian) {
              throw new TypeError(
                `pre-SSH repeatability batch ${index + 1} ${metric} does not match its raw source`
              );
            }
            return sourceMedian;
          }
        );
        const baselineCenter = Math.max(
          baselineMedian,
          ...repeatabilityBatchMedians
        );
        const absoluteAllowance = requireNonNegativeNumber(
          allowances[metric],
          `absoluteNoiseAllowance.${metric}`
        );
        const tolerance = Math.max(
          Math.abs(baselineCenter) * relativeAllowance,
          absoluteAllowance
        );
        return [
          metric,
          {
            baselineValues,
            baselineAverage: average(baselineValues, metric),
            baselineMedian,
            repeatabilityBatchMedians,
            baselineCenter,
            tolerance,
            limit: baselineCenter + tolerance
          }
        ];
      }
    )
  );
}

export function evaluateLocalTerminalCandidate(fixture, samples) {
  const contract = requireCandidateGate(fixture);
  const normalizedSamples = requireSamples(
    samples,
    contract.measuredRuns,
    "candidate"
  );
  const envelope = deriveLocalTerminalBaselineEnvelope(fixture);
  const numeric = Object.fromEntries(
    Object.entries(LOCAL_TERMINAL_REGRESSION_METRICS).map(
      ([metric, location]) => {
        const candidateValues = normalizedSamples.map((sample) =>
          readMetric(sample, location, metric)
        );
        const candidateMedian = median(candidateValues, metric);
        const regressionMargin = candidateMedian - envelope[metric].limit;
        return [
          metric,
          {
            ...envelope[metric],
            candidateValues,
            candidateAverage: average(candidateValues, metric),
            candidateMedian,
            regressionMargin,
            passed: regressionMargin <= 0
          }
        ];
      }
    )
  );
  const functionalFailures = normalizedSamples
    .filter((sample) => sample.functionalPassed !== true)
    .map((sample) => sample.runId);
  const boundFailures = normalizedSamples
    .filter(
      (sample) =>
        sample.steady.cacheBoundViolations !== 0 ||
        sample.steady.supervisorBoundViolations !== 0
    )
    .map((sample) => sample.runId);
  const numericFailures = Object.entries(numeric)
    .filter(([, result]) => !result.passed)
    .map(([metric]) => metric);

  return {
    functional: {
      passed: functionalFailures.length === 0,
      failedRuns: functionalFailures
    },
    bounds: {
      passed: boundFailures.length === 0,
      failedRuns: boundFailures
    },
    numeric,
    numericFailures,
    passed:
      functionalFailures.length === 0 &&
      boundFailures.length === 0 &&
      numericFailures.length === 0
  };
}

function requireCandidateGate(fixture) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new TypeError("local terminal regression fixture must be an object");
  }
  const contract = fixture.candidateGate;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new TypeError("candidateGate must be an object");
  }
  if (
    !Number.isSafeInteger(contract.measuredRuns) ||
    contract.measuredRuns < 1
  ) {
    throw new TypeError(
      "candidateGate.measuredRuns must be a positive integer"
    );
  }
  if (!contract.numeric || typeof contract.numeric !== "object") {
    throw new TypeError("candidateGate.numeric must be an object");
  }
  return contract;
}

function requireSamples(value, expectedCount, label) {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new TypeError(
      `${label} samples must contain exactly ${expectedCount} runs`
    );
  }
  return value;
}

function readMetric(sample, location, metric) {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
    throw new TypeError(`${metric} sample must be an object`);
  }
  return requireMetric(sample[location.group]?.[location.field], metric);
}

function requireMetric(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

function requireNonNegativeNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

function normalizeEnvironmentValue(field, value) {
  if (field === "architecture") {
    if (["x64", "x86_64", "amd64"].includes(value)) return "x64";
    if (["arm64", "aarch64"].includes(value)) return "arm64";
  }
  return value;
}
