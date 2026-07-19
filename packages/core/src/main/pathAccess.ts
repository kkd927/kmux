import {
  LocalPath,
  RemotePath,
  pathRawValueForInternalAccess
} from "../domain";
import type { Id } from "@kmux/proto";

/**
 * Capability available only to the target composition root. Providers receive
 * the location-specific half and cannot unwrap the other path brand.
 */
export interface PathAccess {
  unwrapLocal(path: LocalPath): string;
  unwrapRemote(targetId: Id, path: RemotePath): string;
}

export type LocalPathAccess = Pick<PathAccess, "unwrapLocal">;
export type RemotePathAccess = Pick<PathAccess, "unwrapRemote">;

export function createPathAccess(): PathAccess {
  return Object.freeze({
    unwrapLocal(path: LocalPath): string {
      if (!(path instanceof LocalPath)) {
        throw new TypeError("local path access requires a LocalPath value");
      }
      return pathRawValueForInternalAccess(path);
    },
    unwrapRemote(targetId: Id, path: RemotePath): string {
      if (!(path instanceof RemotePath)) {
        throw new TypeError("remote path access requires a RemotePath value");
      }
      return pathRawValueForInternalAccess(path, targetId);
    }
  });
}
