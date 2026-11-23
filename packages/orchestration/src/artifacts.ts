import { writePrivateFileAtomic } from "./nodePersistence";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactRef, ContentHash } from "./types";

export class FileOrchestrationArtifactStore {
  constructor(
    private readonly options: {
      readonly root: string;
      readonly now?: () => string;
      readonly id?: (kind: string) => string;
    }
  ) {}

  async put(input: {
    readonly kind: string;
    readonly bytes: Uint8Array;
    readonly maxBytes: number;
    readonly targetId?: string;
  }): Promise<ArtifactRef> {
    assertArtifactBound(input.maxBytes);
    if (
      !isArtifactKind(input.kind) ||
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > input.maxBytes
    ) {
      throw new Error("orchestration artifact exceeds its declared byte bound");
    }
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    const contentHash = `sha256:${digest}` as ContentHash;
    const directory = join(this.options.root, digest.slice(0, 2));
    const path = join(directory, `${digest}.bin`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await open(this.options.root, "r");
    try {
      await root.sync();
    } finally {
      await root.close();
    }
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size !== input.bytes.byteLength) {
        throw new Error(
          "existing orchestration artifact does not match content"
        );
      }
      const existing = await readFile(path);
      if (createHash("sha256").update(existing).digest("hex") !== digest) {
        throw new Error(
          "existing orchestration artifact does not match content"
        );
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await writePrivateFileAtomic(path, input.bytes);
    }
    return {
      artifactId: this.options.id?.("artifact") ?? `artifact:${randomUUID()}`,
      kind: input.kind,
      contentHash,
      sizeBytes: input.bytes.byteLength,
      ...(input.targetId ? { targetId: input.targetId } : {}),
      retentionUntil: new Date(
        Date.parse(this.options.now?.() ?? new Date().toISOString()) +
          30 * 24 * 60 * 60 * 1_000
      ).toISOString()
    };
  }

  async get(input: {
    readonly artifact: ArtifactRef;
    readonly maxBytes: number;
    readonly expectedKind?: string;
  }): Promise<Uint8Array> {
    assertArtifactBound(input.maxBytes);
    const { artifact } = input;
    if (
      !isArtifactKind(artifact.kind) ||
      !/^sha256:[a-f0-9]{64}$/u.test(artifact.contentHash) ||
      artifact.sizeBytes < 1 ||
      artifact.sizeBytes > input.maxBytes ||
      (input.expectedKind !== undefined && artifact.kind !== input.expectedKind)
    ) {
      throw new Error(
        "orchestration artifact reference is invalid or out of bounds"
      );
    }
    const digest = artifact.contentHash.slice("sha256:".length);
    const path = join(this.options.root, digest.slice(0, 2), `${digest}.bin`);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size !== artifact.sizeBytes) {
      throw new Error("orchestration artifact metadata does not match storage");
    }
    const bytes = await readFile(path);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== digest) {
      throw new Error("orchestration artifact content hash does not match");
    }
    return new Uint8Array(bytes);
  }
}

function assertArtifactBound(maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024 ** 3) {
    throw new TypeError("orchestration artifact bound is outside 1..1GiB");
  }
}

function isArtifactKind(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
