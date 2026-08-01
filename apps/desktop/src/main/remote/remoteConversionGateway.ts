import type { RemoteHostManager } from "../remoteHost";
import type {
  ConversionRemoteGateway,
  ConversionRemotePrepareRequest
} from "./transactionalWorkspaceConversion";
import { conversionSurfaceIdForTransaction } from "./transactionalWorkspaceConversion";
import type { ConversionProductInstalledRecord } from "./conversionWal";

export function createRemoteHostSshWorkspaceTransactionGateway(
  host: RemoteHostManager
): ConversionRemoteGateway {
  return Object.freeze({
    async prepare(request: ConversionRemotePrepareRequest) {
      const record = request.record;
      const prepared = await host.prepareConversion(
        record.workspaceResourceKey.targetId,
        {
          transactionId: record.transactionId,
          workspaceCreateOperationId: record.workspaceCreateOperationId,
          sessionCreateOperationId: record.sessionCreateOperationId,
          surfaceId: conversionSurfaceIdForTransaction(record.transactionId),
          workspaceResourceKey: record.workspaceResourceKey,
          sessionResourceKey: record.sessionResourceKey,
          remoteSnapshot: request.remoteSnapshot,
          remoteSnapshotHash: request.remoteSnapshotHash,
          launch: record.launch,
          preparedAt: record.preparedAt
        }
      );
      return {
        remoteSnapshotHash: prepared.remoteSnapshotHash,
        workspaceDescriptorHash: prepared.workspaceDescriptorHash,
        sessionDescriptorHash: prepared.sessionDescriptorHash,
        keeperGeneration: prepared.keeperGeneration,
        remoteResourceRevision: prepared.remoteResourceRevision,
        remoteCreatedAt: prepared.remoteCreatedAt
      };
    },

    async promote(record: ConversionProductInstalledRecord) {
      const promoted = await host.promoteConversion(
        record.workspaceResourceKey.targetId,
        {
          transactionId: record.transactionId,
          workspaceCreateOperationId: record.workspaceCreateOperationId,
          sessionCreateOperationId: record.sessionCreateOperationId,
          workspaceResourceKey: record.workspaceResourceKey,
          sessionResourceKey: record.sessionResourceKey,
          remoteSnapshotHash: record.remoteSnapshotHash
        }
      );
      return {
        transactionId: promoted.transactionId,
        remoteSnapshotHash: promoted.remoteSnapshotHash,
        remotePromotionHash: promoted.remotePromotionHash
      };
    }
  });
}

/** @deprecated Use createRemoteHostSshWorkspaceTransactionGateway. */
export const createRemoteHostConversionGateway =
  createRemoteHostSshWorkspaceTransactionGateway;
