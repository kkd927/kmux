import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  classifyLocalTerminalSampleEvidence,
  deriveLocalTerminalExecutionPlan,
  deriveLocalTerminalBaselineEnvelope,
  evaluateLocalTerminalEnvironment,
  evaluateLocalTerminalCandidate,
  median
} from "./local-terminal-regression-contract.mjs";

const fixturePath = fileURLToPath(
  new URL(
    "../tests/e2e/fixtures/local-terminal-regression-gates.v1.json",
    import.meta.url
  )
);

function loadFixture() {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function candidateSamples(fixture) {
  return fixture.preSshBaseline.samples.map((sample, index) => ({
    ...sample,
    steady: { ...sample.steady },
    burst: { ...sample.burst },
    runId: index + 1,
    functionalPassed: true
  }));
}

describe("local terminal regression contract", () => {
  it("prepares once before the repeat set and measures without rebuilding", () => {
    const fixture = loadFixture();

    expect(deriveLocalTerminalExecutionPlan(fixture)).toEqual({
      preparationScripts: ["smoke:dev", "build"],
      sampleScript: "profile:terminal-data-plane:sample",
      measuredRuns: 5
    });
    expect(fixture.measurement.finalVerification).toContain("diagnostic");
    expect(fixture.historicalPairedGate.status).toBe(
      "historical-and-diagnostic-only"
    );
  });

  it("does not classify an incomplete failed workload as replaceable infrastructure", () => {
    expect(
      classifyLocalTerminalSampleEvidence({
        steady: {},
        burst: undefined,
        steadyProfile: "/tmp/steady.jsonl",
        ringProfile: "/tmp/ring.jsonl",
        exitCode: 1,
        signal: null,
        spawnError: false
      })
    ).toEqual({
      kind: "workload-failure",
      missing: ["burst-metrics"]
    });
  });

  it("reserves infrastructure classification for a workload that did not start", () => {
    expect(
      classifyLocalTerminalSampleEvidence({
        steady: undefined,
        burst: undefined,
        steadyProfile: undefined,
        ringProfile: undefined,
        exitCode: null,
        signal: null,
        spawnError: true
      })
    ).toEqual({
      kind: "infrastructure-failure",
      missing: [
        "steady-metrics",
        "burst-metrics",
        "steady-burst-profile",
        "ring-gap-profile"
      ]
    });
  });

  it("derives fixed limits from repeatability-calibrated pre-SSH batch medians", () => {
    const envelope = deriveLocalTerminalBaselineEnvelope(loadFixture());

    expect(envelope.renderP95Ms.baselineMedian).toBe(19.9228515625);
    expect(envelope.renderP95Ms.baselineCenter).toBe(19.9228515625);
    expect(envelope.renderP95Ms.tolerance).toBe(2);
    expect(envelope.renderP95Ms.limit).toBe(21.9228515625);
    expect(envelope.echoP99Ms.baselineMedian).toBe(36.099999994039536);
    expect(envelope.echoP99Ms.baselineCenter).toBe(50.400000005960464);
    expect(envelope.echoP99Ms.limit).toBeCloseTo(52.92000000625849);
    expect(envelope.schedulerMaxMs.limit).toBeCloseTo(0.800048828125);
  });

  it("accepts a held-out five-run batch from the exact pre-SSH revision", () => {
    const fixture = loadFixture();
    const samples = fixture.phase3Exit.samples.map((pair, index) => ({
      ...pair.entry,
      runId: index + 1,
      functionalPassed: true
    }));

    expect(evaluateLocalTerminalCandidate(fixture, samples)).toMatchObject({
      passed: true,
      numericFailures: [],
      functional: { passed: true },
      bounds: { passed: true }
    });
  });

  it("fails closed when the candidate host differs from the baseline environment", () => {
    const fixture = loadFixture();
    const matching = {
      ...fixture.preSshBaseline.environment,
      architecture: "x64"
    };

    expect(evaluateLocalTerminalEnvironment(fixture, matching)).toMatchObject({
      passed: true,
      mismatches: []
    });
    expect(
      evaluateLocalTerminalEnvironment(fixture, {
        ...matching,
        node: "99.0.0"
      })
    ).toMatchObject({
      passed: false,
      mismatches: [{ field: "node", expected: "22.16.0", actual: "99.0.0" }]
    });
  });

  it("uses a repeated candidate median instead of failing one noisy run", () => {
    const fixture = loadFixture();
    const samples = candidateSamples(fixture);
    samples[0].steady.renderP95Ms = 500;
    samples[0].steady.schedulerMaxMs = 500;
    samples[0].steady.warmSwitchMaxMs = 500;

    const evaluation = evaluateLocalTerminalCandidate(fixture, samples);

    expect(evaluation.passed).toBe(true);
    expect(evaluation.numericFailures).toEqual([]);
  });

  it("fails when the candidate median exceeds the baseline envelope", () => {
    const fixture = loadFixture();
    const samples = candidateSamples(fixture);
    for (const sample of samples.slice(0, 3)) {
      sample.steady.echoP95Ms = 100;
    }

    const evaluation = evaluateLocalTerminalCandidate(fixture, samples);

    expect(evaluation.passed).toBe(false);
    expect(evaluation.numericFailures).toContain("echoP95Ms");
    expect(evaluation.numeric.echoP95Ms.regressionMargin).toBeGreaterThan(0);
  });

  it("never averages away functional or resource-bound failures", () => {
    const fixture = loadFixture();
    const samples = candidateSamples(fixture);
    samples[1].functionalPassed = false;
    samples[2].steady.cacheBoundViolations = 1;

    const evaluation = evaluateLocalTerminalCandidate(fixture, samples);

    expect(evaluation.functional).toEqual({ passed: false, failedRuns: [2] });
    expect(evaluation.bounds).toEqual({ passed: false, failedRuns: [3] });
    expect(evaluation.passed).toBe(false);
  });

  it("computes an ordinary median for odd and even sample counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
