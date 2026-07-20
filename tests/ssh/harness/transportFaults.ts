import type { CreatedProxy } from "@testcontainers/toxiproxy";

type ToxicDirection = "upstream" | "downstream";

interface RemovableToxic {
  remove(): Promise<void>;
}

export class SshTransportFaults {
  constructor(private readonly proxy: CreatedProxy) {}

  async disconnect(): Promise<void> {
    await this.proxy.setEnabled(false);
  }

  async reconnect(): Promise<void> {
    await this.proxy.setEnabled(true);
  }

  async addLatency(options: {
    latencyMs: number;
    jitterMs?: number;
    direction?: ToxicDirection;
  }): Promise<RemovableToxic> {
    const latencyMs = boundedInteger(options.latencyMs, "latencyMs", 1, 60_000);
    const jitterMs = boundedInteger(
      options.jitterMs ?? 0,
      "jitterMs",
      0,
      latencyMs
    );
    return await this.proxy.instance.addToxic({
      name: `latency-${options.direction ?? "downstream"}`,
      type: "latency",
      stream: options.direction ?? "downstream",
      toxicity: 1,
      attributes: { latency: latencyMs, jitter: jitterMs }
    });
  }

  async addBandwidthLimit(options: {
    kibPerSecond: number;
    direction?: ToxicDirection;
  }): Promise<RemovableToxic> {
    const rate = boundedInteger(
      options.kibPerSecond,
      "kibPerSecond",
      1,
      1024 * 1024
    );
    return await this.proxy.instance.addToxic({
      name: `bandwidth-${options.direction ?? "downstream"}`,
      type: "bandwidth",
      stream: options.direction ?? "downstream",
      toxicity: 1,
      attributes: { rate }
    });
  }

  async resetConnections(
    direction: ToxicDirection = "downstream"
  ): Promise<RemovableToxic> {
    return await this.proxy.instance.addToxic({
      name: `reset-${direction}`,
      type: "reset_peer",
      stream: direction,
      toxicity: 1,
      attributes: { timeout: 0 }
    });
  }
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}
