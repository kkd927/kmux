interface SnapshotCacheRequest {
  sequence: number;
  cols: number;
  rows: number;
  serialize: () => string;
}

interface SnapshotCacheEntry {
  sequence: number;
  cols: number;
  rows: number;
  vt: string;
}

export class SnapshotCache {
  private entry: SnapshotCacheEntry | null = null;

  get(request: SnapshotCacheRequest): string {
    if (
      this.entry &&
      this.entry.sequence === request.sequence &&
      this.entry.cols === request.cols &&
      this.entry.rows === request.rows
    ) {
      return this.entry.vt;
    }

    const vt = request.serialize();
    this.entry = {
      sequence: request.sequence,
      cols: request.cols,
      rows: request.rows,
      vt
    };
    return vt;
  }
}
