use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const REMOTE_FRAME_HARD_MAX_BYTES: usize = 1024 * 1024;
pub const REMOTE_CONTROL_HARD_MAX_BYTES: usize = 256 * 1024;
pub const REMOTE_TERMINAL_CHUNK_HARD_MAX_BYTES: usize = 256 * 1024;
pub const REMOTE_CHECKPOINT_CHUNK_HARD_MAX_BYTES: usize = 256 * 1024;
pub const REMOTE_CHECKPOINT_HARD_MAX_CHUNKS: usize = 1_024;
pub const REMOTE_CHECKPOINT_HARD_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const REMOTE_METADATA_CHUNK_HARD_MAX_BYTES: usize = 256 * 1024;
pub const REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES: usize = 64 * 1024;
pub const REMOTE_PROTOCOL_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RemoteFrameKind {
    Control = 1,
    Terminal = 2,
    Checkpoint = 3,
    Metadata = 4,
    Status = 5,
}

impl TryFrom<u8> for RemoteFrameKind {
    type Error = RemoteWireError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Control),
            2 => Ok(Self::Terminal),
            3 => Ok(Self::Checkpoint),
            4 => Ok(Self::Metadata),
            5 => Ok(Self::Status),
            _ => Err(RemoteWireError::UnknownFrameKind(value)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteFrame {
    pub kind: RemoteFrameKind,
    pub payload: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum RemoteWireError {
    #[error("remote wire I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("remote frame length is zero or exceeds its hard limit")]
    InvalidFrameLength,
    #[error("remote frame kind {0} is unknown")]
    UnknownFrameKind(u8),
    #[error("remote frame payload exceeds its kind limit")]
    PayloadLimit,
    #[error("remote control JSON is invalid: {0}")]
    InvalidControlJson(#[from] serde_json::Error),
    #[error("remote terminal message is invalid: {0}")]
    InvalidTerminal(&'static str),
}

pub fn read_remote_frame(reader: &mut impl Read) -> Result<Option<RemoteFrame>, RemoteWireError> {
    let mut length_bytes = [0_u8; 4];
    let mut read = 0;
    while read < length_bytes.len() {
        match reader.read(&mut length_bytes[read..])? {
            0 if read == 0 => return Ok(None),
            0 => {
                return Err(RemoteWireError::Io(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "truncated remote frame length",
                )));
            }
            bytes => read += bytes,
        }
    }
    let frame_length = u32::from_be_bytes(length_bytes) as usize;
    if frame_length == 0 || frame_length > REMOTE_FRAME_HARD_MAX_BYTES {
        return Err(RemoteWireError::InvalidFrameLength);
    }
    let mut kind = [0_u8; 1];
    reader.read_exact(&mut kind)?;
    let kind = RemoteFrameKind::try_from(kind[0])?;
    let payload_length = frame_length - 1;
    validate_payload_length(kind, payload_length)?;
    let mut payload = vec![0_u8; payload_length];
    reader.read_exact(&mut payload)?;
    Ok(Some(RemoteFrame { kind, payload }))
}

pub fn write_remote_frame(
    writer: &mut impl Write,
    kind: RemoteFrameKind,
    payload: &[u8],
) -> Result<(), RemoteWireError> {
    validate_payload_length(kind, payload.len())?;
    let frame_length = payload
        .len()
        .checked_add(1)
        .and_then(|length| u32::try_from(length).ok())
        .ok_or(RemoteWireError::InvalidFrameLength)?;
    writer.write_all(&frame_length.to_be_bytes())?;
    writer.write_all(&[kind as u8])?;
    writer.write_all(payload)?;
    writer.flush()?;
    Ok(())
}

pub fn read_control<T: for<'de> Deserialize<'de>>(
    reader: &mut impl Read,
) -> Result<Option<T>, RemoteWireError> {
    let Some(frame) = read_remote_frame(reader)? else {
        return Ok(None);
    };
    if frame.kind != RemoteFrameKind::Control {
        return Err(RemoteWireError::InvalidTerminal("expected a control frame"));
    }
    Ok(Some(serde_json::from_slice(&frame.payload)?))
}

pub fn write_control(
    writer: &mut impl Write,
    value: &impl Serialize,
) -> Result<(), RemoteWireError> {
    let payload = serde_json::to_vec(value)?;
    write_remote_frame(writer, RemoteFrameKind::Control, &payload)
}

fn validate_payload_length(
    kind: RemoteFrameKind,
    payload_length: usize,
) -> Result<(), RemoteWireError> {
    let maximum = match kind {
        RemoteFrameKind::Control | RemoteFrameKind::Status => REMOTE_CONTROL_HARD_MAX_BYTES,
        RemoteFrameKind::Terminal => REMOTE_TERMINAL_CHUNK_HARD_MAX_BYTES,
        RemoteFrameKind::Checkpoint => REMOTE_CHECKPOINT_CHUNK_HARD_MAX_BYTES,
        RemoteFrameKind::Metadata => REMOTE_METADATA_CHUNK_HARD_MAX_BYTES,
    };
    if payload_length > maximum || payload_length.saturating_add(1) > REMOTE_FRAME_HARD_MAX_BYTES {
        return Err(RemoteWireError::PayloadLimit);
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoteTerminalWireMessage {
    Output {
        sequence: u64,
        data: Vec<u8>,
    },
    Resize {
        sequence: u64,
        cols: u16,
        rows: u16,
    },
    Exit {
        sequence: u64,
        exit_code: Option<i32>,
    },
    Input {
        writer_lease_id: String,
        attachment_id: String,
        input_sequence: u64,
        data: Vec<u8>,
    },
    ResizeRequest {
        writer_lease_id: String,
        attachment_id: String,
        cols: u16,
        rows: u16,
    },
}

pub fn encode_terminal_message(
    message: &RemoteTerminalWireMessage,
) -> Result<Vec<u8>, RemoteWireError> {
    let mut payload = Vec::new();
    match message {
        RemoteTerminalWireMessage::Output { sequence, data } => {
            if data.len() > REMOTE_TERMINAL_CHUNK_HARD_MAX_BYTES.saturating_sub(9) {
                return Err(RemoteWireError::PayloadLimit);
            }
            payload.push(1);
            payload.extend_from_slice(&sequence.to_be_bytes());
            payload.extend_from_slice(data);
        }
        RemoteTerminalWireMessage::Resize {
            sequence,
            cols,
            rows,
        } => {
            validate_dimensions(*cols, *rows)?;
            payload.push(2);
            payload.extend_from_slice(&sequence.to_be_bytes());
            payload.extend_from_slice(&cols.to_be_bytes());
            payload.extend_from_slice(&rows.to_be_bytes());
        }
        RemoteTerminalWireMessage::Exit {
            sequence,
            exit_code,
        } => {
            payload.push(3);
            payload.extend_from_slice(&sequence.to_be_bytes());
            match exit_code {
                Some(code) => {
                    payload.push(1);
                    payload.extend_from_slice(&code.to_be_bytes());
                }
                None => payload.push(0),
            }
        }
        RemoteTerminalWireMessage::Input {
            writer_lease_id,
            attachment_id,
            input_sequence,
            data,
        } => {
            if data.len() > REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES {
                return Err(RemoteWireError::PayloadLimit);
            }
            payload.push(16);
            write_wire_id(&mut payload, writer_lease_id)?;
            write_wire_id(&mut payload, attachment_id)?;
            payload.extend_from_slice(&input_sequence.to_be_bytes());
            payload.extend_from_slice(data);
        }
        RemoteTerminalWireMessage::ResizeRequest {
            writer_lease_id,
            attachment_id,
            cols,
            rows,
        } => {
            validate_dimensions(*cols, *rows)?;
            payload.push(17);
            write_wire_id(&mut payload, writer_lease_id)?;
            write_wire_id(&mut payload, attachment_id)?;
            payload.extend_from_slice(&cols.to_be_bytes());
            payload.extend_from_slice(&rows.to_be_bytes());
        }
    }
    validate_payload_length(RemoteFrameKind::Terminal, payload.len())?;
    Ok(payload)
}

pub fn decode_terminal_message(
    payload: &[u8],
) -> Result<RemoteTerminalWireMessage, RemoteWireError> {
    let (&kind, mut body) = payload
        .split_first()
        .ok_or(RemoteWireError::InvalidTerminal("empty payload"))?;
    match kind {
        1 => {
            let sequence = take_u64(&mut body)?;
            Ok(RemoteTerminalWireMessage::Output {
                sequence,
                data: body.to_vec(),
            })
        }
        2 => {
            let sequence = take_u64(&mut body)?;
            if body.len() != 4 {
                return Err(RemoteWireError::InvalidTerminal(
                    "invalid resize mutation length",
                ));
            }
            let cols = u16::from_be_bytes([body[0], body[1]]);
            let rows = u16::from_be_bytes([body[2], body[3]]);
            validate_dimensions(cols, rows)?;
            Ok(RemoteTerminalWireMessage::Resize {
                sequence,
                cols,
                rows,
            })
        }
        3 => {
            let sequence = take_u64(&mut body)?;
            let exit_code = match body {
                [0] => None,
                [1, a, b, c, d] => Some(i32::from_be_bytes([*a, *b, *c, *d])),
                _ => {
                    return Err(RemoteWireError::InvalidTerminal(
                        "invalid exit mutation payload",
                    ));
                }
            };
            Ok(RemoteTerminalWireMessage::Exit {
                sequence,
                exit_code,
            })
        }
        16 => {
            let writer_lease_id = take_wire_id(&mut body)?;
            let attachment_id = take_wire_id(&mut body)?;
            let input_sequence = take_u64(&mut body)?;
            if body.len() > REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES {
                return Err(RemoteWireError::PayloadLimit);
            }
            Ok(RemoteTerminalWireMessage::Input {
                writer_lease_id,
                attachment_id,
                input_sequence,
                data: body.to_vec(),
            })
        }
        17 => {
            let writer_lease_id = take_wire_id(&mut body)?;
            let attachment_id = take_wire_id(&mut body)?;
            if body.len() != 4 {
                return Err(RemoteWireError::InvalidTerminal(
                    "invalid resize request length",
                ));
            }
            let cols = u16::from_be_bytes([body[0], body[1]]);
            let rows = u16::from_be_bytes([body[2], body[3]]);
            validate_dimensions(cols, rows)?;
            Ok(RemoteTerminalWireMessage::ResizeRequest {
                writer_lease_id,
                attachment_id,
                cols,
                rows,
            })
        }
        _ => Err(RemoteWireError::InvalidTerminal("unknown message kind")),
    }
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), RemoteWireError> {
    if cols == 0 || rows == 0 || cols > 32_767 || rows > 32_767 {
        return Err(RemoteWireError::InvalidTerminal(
            "terminal dimensions are outside 1..32767",
        ));
    }
    Ok(())
}

fn write_wire_id(target: &mut Vec<u8>, value: &str) -> Result<(), RemoteWireError> {
    if value.is_empty()
        || value.len() > 256
        || value.chars().any(char::is_control)
        || u16::try_from(value.len()).is_err()
    {
        return Err(RemoteWireError::InvalidTerminal("invalid identity"));
    }
    target.extend_from_slice(&(value.len() as u16).to_be_bytes());
    target.extend_from_slice(value.as_bytes());
    Ok(())
}

fn take_wire_id(body: &mut &[u8]) -> Result<String, RemoteWireError> {
    if body.len() < 2 {
        return Err(RemoteWireError::InvalidTerminal(
            "truncated identity length",
        ));
    }
    let length = u16::from_be_bytes([body[0], body[1]]) as usize;
    *body = &body[2..];
    if length == 0 || length > 256 || body.len() < length {
        return Err(RemoteWireError::InvalidTerminal("invalid identity length"));
    }
    let value = std::str::from_utf8(&body[..length])
        .map_err(|_| RemoteWireError::InvalidTerminal("identity is not UTF-8"))?;
    if value.chars().any(char::is_control) {
        return Err(RemoteWireError::InvalidTerminal("invalid identity"));
    }
    *body = &body[length..];
    Ok(value.to_owned())
}

fn take_u64(body: &mut &[u8]) -> Result<u64, RemoteWireError> {
    let bytes: [u8; 8] = body
        .get(..8)
        .ok_or(RemoteWireError::InvalidTerminal("truncated uint64"))?
        .try_into()
        .expect("length was checked");
    *body = &body[8..];
    Ok(u64::from_be_bytes(bytes))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteRuntimeRoots {
    pub install_root: String,
    pub authority_root: String,
    pub state_root: String,
    pub runtime_root: String,
}

pub const DEFAULT_SESSION_RETENTION_QUOTA_MIB: u32 = 256;
pub const DEFAULT_TARGET_RETENTION_QUOTA_MIB: u32 = 2 * 1024;
pub const MIN_SESSION_RETENTION_QUOTA_MIB: u32 = 64;
pub const MAX_SESSION_RETENTION_QUOTA_MIB: u32 = 4 * 1024;
pub const MIN_TARGET_RETENTION_QUOTA_MIB: u32 = 256;
pub const MAX_TARGET_RETENTION_QUOTA_MIB: u32 = 32 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteRetentionPolicy {
    #[serde(rename = "sessionQuotaMiB")]
    pub session_quota_mib: u32,
    #[serde(rename = "targetQuotaMiB")]
    pub target_quota_mib: u32,
}

impl Default for RemoteRetentionPolicy {
    fn default() -> Self {
        Self {
            session_quota_mib: DEFAULT_SESSION_RETENTION_QUOTA_MIB,
            target_quota_mib: DEFAULT_TARGET_RETENTION_QUOTA_MIB,
        }
    }
}

impl RemoteRetentionPolicy {
    #[must_use]
    pub fn is_valid(self) -> bool {
        (MIN_SESSION_RETENTION_QUOTA_MIB..=MAX_SESSION_RETENTION_QUOTA_MIB)
            .contains(&self.session_quota_mib)
            && (MIN_TARGET_RETENTION_QUOTA_MIB..=MAX_TARGET_RETENTION_QUOTA_MIB)
                .contains(&self.target_quota_mib)
            && self.target_quota_mib >= self.session_quota_mib
    }

    #[must_use]
    pub fn session_quota_bytes(self) -> u64 {
        u64::from(self.session_quota_mib) * 1024 * 1024
    }

    #[must_use]
    pub fn target_quota_bytes(self) -> u64 {
        u64::from(self.target_quota_mib) * 1024 * 1024
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteResourceKey {
    pub desktop_installation_id: String,
    pub target_id: String,
    pub workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeRequestEnvelope {
    pub protocol_version: u16,
    pub request_id: String,
    pub token: String,
    pub roots: RemoteRuntimeRoots,
    #[serde(default)]
    pub retention_policy: RemoteRetentionPolicy,
    pub request: BridgeRequest,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum BridgeRequest {
    Hello {},
    #[serde(rename = "operation.execute")]
    OperationExecute {
        intent: Box<RemoteOperationIntent>,
        payload: RemoteOperationPayload,
    },
    Observe {
        #[serde(rename = "desktopInstallationId")]
        desktop_installation_id: String,
        #[serde(rename = "targetId")]
        target_id: String,
    },
    #[serde(rename = "git.inspect")]
    GitInspect {
        #[serde(rename = "desktopInstallationId")]
        desktop_installation_id: String,
        #[serde(rename = "targetId")]
        target_id: String,
        cwd: String,
        #[serde(rename = "dirtyLimit")]
        dirty_limit: usize,
        branch: Option<String>,
    },
    #[serde(rename = "ports.inspect")]
    PortsInspect {
        #[serde(rename = "resourceKey")]
        resource_key: RemoteResourceKey,
    },
    #[serde(rename = "history.scan")]
    HistoryScan {
        #[serde(rename = "desktopInstallationId")]
        desktop_installation_id: String,
        #[serde(rename = "targetId")]
        target_id: String,
        #[serde(rename = "maxRecords")]
        max_records: usize,
    },
    #[serde(rename = "usage.scan")]
    UsageScan {
        #[serde(rename = "desktopInstallationId")]
        desktop_installation_id: String,
        #[serde(rename = "targetId")]
        target_id: String,
        #[serde(rename = "startAtUnixMs")]
        start_at_unix_ms: String,
        #[serde(rename = "maxRecords")]
        max_records: usize,
    },
    #[serde(rename = "forwards.observe")]
    ForwardsObserve {
        #[serde(rename = "desktopInstallationId")]
        desktop_installation_id: String,
        #[serde(rename = "targetId")]
        target_id: String,
    },
    #[serde(rename = "attach.authorize")]
    AttachAuthorize {
        #[serde(rename = "resourceKey")]
        resource_key: RemoteResourceKey,
        #[serde(rename = "expectedKeeperGeneration")]
        expected_keeper_generation: Option<String>,
        access: AttachmentAccess,
    },
    #[serde(rename = "terminal.inject")]
    TerminalInject {
        #[serde(rename = "resourceKey")]
        resource_key: RemoteResourceKey,
        #[serde(rename = "expectedKeeperGeneration")]
        expected_keeper_generation: String,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "payloadHash")]
        payload_hash: String,
        input: String,
    },
    #[serde(rename = "surface.capture")]
    SurfaceCapture {
        #[serde(rename = "resourceKey")]
        resource_key: RemoteResourceKey,
        #[serde(rename = "expectedKeeperGeneration")]
        expected_keeper_generation: String,
        #[serde(rename = "captureId")]
        capture_id: String,
        #[serde(rename = "lineLimit")]
        line_limit: usize,
        #[serde(rename = "maxBytes")]
        max_bytes: usize,
    },
    #[serde(rename = "events.replay")]
    EventsReplay {
        #[serde(rename = "desktopInstallationId")]
        desktop_installation_id: String,
        #[serde(rename = "targetId")]
        target_id: String,
        #[serde(rename = "afterSequence")]
        after_sequence: String,
    },
    #[serde(rename = "events.ack")]
    EventsAck {
        #[serde(rename = "desktopInstallationId")]
        desktop_installation_id: String,
        #[serde(rename = "targetId")]
        target_id: String,
        #[serde(rename = "throughSequence")]
        through_sequence: String,
    },
    #[serde(rename = "conversion.prepare")]
    ConversionPrepare {
        #[serde(rename = "transactionId")]
        transaction_id: String,
        #[serde(rename = "workspaceCreateOperationId")]
        workspace_create_operation_id: String,
        #[serde(rename = "sessionCreateOperationId")]
        session_create_operation_id: String,
        #[serde(rename = "workspaceResourceKey")]
        workspace_resource_key: RemoteResourceKey,
        #[serde(rename = "sessionResourceKey")]
        session_resource_key: RemoteResourceKey,
        #[serde(rename = "sourceWorkspaceRevision")]
        source_workspace_revision: String,
        #[serde(rename = "remoteSnapshot")]
        remote_snapshot: String,
        #[serde(rename = "remoteSnapshotHash")]
        remote_snapshot_hash: String,
        launch: RemoteSessionLaunchPayload,
        #[serde(rename = "preparedAt")]
        prepared_at: String,
    },
    #[serde(rename = "conversion.promote")]
    ConversionPromote {
        #[serde(rename = "transactionId")]
        transaction_id: String,
        #[serde(rename = "workspaceCreateOperationId")]
        workspace_create_operation_id: String,
        #[serde(rename = "sessionCreateOperationId")]
        session_create_operation_id: String,
        #[serde(rename = "workspaceResourceKey")]
        workspace_resource_key: RemoteResourceKey,
        #[serde(rename = "sessionResourceKey")]
        session_resource_key: RemoteResourceKey,
        #[serde(rename = "remoteSnapshotHash")]
        remote_snapshot_hash: String,
    },
    #[serde(rename = "provisional.reclaim")]
    ProvisionalReclaim {
        #[serde(rename = "desktopInstallationId")]
        desktop_installation_id: String,
        #[serde(rename = "targetId")]
        target_id: String,
        #[serde(rename = "protectedTransactionIds")]
        protected_transaction_ids: Vec<String>,
        now: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentAccess {
    Read,
    Write,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteSessionStorageState {
    #[default]
    Normal,
    Degraded,
    Backpressured,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSessionStorageStatus {
    pub state: RemoteSessionStorageState,
    pub journal_admitted: String,
    pub journal_synced: String,
    pub emergency_bytes: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_duration_ms: Option<u64>,
}

impl Default for RemoteSessionStorageStatus {
    fn default() -> Self {
        Self {
            state: RemoteSessionStorageState::Normal,
            journal_admitted: "0".to_owned(),
            journal_synced: "0".to_owned(),
            emergency_bytes: 0,
            last_sync_duration_ms: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteOperationIntent {
    pub operation_id: String,
    pub kind: String,
    pub resource_key: RemoteResourceKey,
    pub expected_workspace_revision: String,
    pub expected_remote_resource_revision: String,
    pub next_remote_resource_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversion_transaction_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_operation_id: Option<String>,
    pub canonical_payload_hash: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSessionLaunchPayload {
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum RemoteOperationPayload {
    #[serde(rename = "workspace.create")]
    WorkspaceCreate {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(rename = "defaultCwd")]
        default_cwd: String,
    },
    #[serde(rename = "session.create")]
    SessionCreate {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "surfaceId")]
        surface_id: String,
        #[serde(rename = "paneId")]
        pane_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        direction: Option<String>,
        launch: RemoteSessionLaunchPayload,
    },
    #[serde(rename = "session.restart")]
    SessionRestart {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "surfaceId")]
        surface_id: String,
        launch: RemoteSessionLaunchPayload,
    },
    #[serde(rename = "session.adopt")]
    SessionAdopt {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "surfaceId")]
        surface_id: String,
        #[serde(rename = "paneId")]
        pane_id: String,
        launch: RemoteSessionLaunchPayload,
    },
    #[serde(rename = "session.terminate")]
    SessionTerminate {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "workspace.terminate")]
    WorkspaceTerminate {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    #[serde(rename = "worktree.create")]
    WorktreeCreate {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        cwd: String,
        path: String,
        #[serde(rename = "baseRef")]
        base_ref: String,
        branch: String,
    },
    #[serde(rename = "worktree.remove")]
    WorktreeRemove {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        cwd: String,
        path: String,
        force: bool,
        #[serde(rename = "expectedBranch")]
        expected_branch: String,
        #[serde(rename = "expectedCommonGitDir")]
        expected_common_git_dir: String,
    },
    #[serde(rename = "forward.ensure")]
    ForwardEnsure {
        #[serde(rename = "forwardId")]
        forward_id: String,
        #[serde(rename = "remoteHost")]
        remote_host: String,
        #[serde(rename = "remotePort")]
        remote_port: u16,
        #[serde(rename = "localBindHost")]
        local_bind_host: String,
        #[serde(rename = "localPort")]
        #[serde(skip_serializing_if = "Option::is_none")]
        local_port: Option<u16>,
    },
    #[serde(rename = "forward.remove")]
    ForwardRemove {
        #[serde(rename = "forwardId")]
        forward_id: String,
    },
    #[serde(rename = "launch-input")]
    LaunchInput {
        #[serde(rename = "sessionId")]
        session_id: String,
        input: String,
    },
}

impl RemoteOperationPayload {
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::WorkspaceCreate { .. } => "workspace.create",
            Self::SessionCreate { .. } => "session.create",
            Self::SessionRestart { .. } => "session.restart",
            Self::SessionAdopt { .. } => "session.adopt",
            Self::SessionTerminate { .. } => "session.terminate",
            Self::WorkspaceTerminate { .. } => "workspace.terminate",
            Self::WorktreeCreate { .. } => "worktree.create",
            Self::WorktreeRemove { .. } => "worktree.remove",
            Self::ForwardEnsure { .. } => "forward.ensure",
            Self::ForwardRemove { .. } => "forward.remove",
            Self::LaunchInput { .. } => "launch-input",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeResponseEnvelope {
    pub protocol_version: u16,
    pub request_id: String,
    pub status: BridgeResponseStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<BridgeResponseBody>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteControlError>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BridgeResponseStatus {
    Ok,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type")]
pub enum BridgeResponseBody {
    #[serde(rename = "hello")]
    Hello(HelloResponse),
    #[serde(rename = "operation.result")]
    OperationResult(OperationResult),
    #[serde(rename = "observed")]
    Observed(ObservedResponse),
    #[serde(rename = "git.inspected")]
    GitInspected(GitInspectedResponse),
    #[serde(rename = "ports.inspected")]
    PortsInspected(PortsInspectedResponse),
    #[serde(rename = "history.scanned")]
    HistoryScanned(HistoryScannedResponse),
    #[serde(rename = "usage.scanned")]
    UsageScanned(UsageScannedResponse),
    #[serde(rename = "forwards.observed")]
    ForwardsObserved(ForwardsObservedResponse),
    #[serde(rename = "attach.authorized")]
    AttachAuthorized(AttachAuthorizedResponse),
    #[serde(rename = "terminal.input-ack")]
    TerminalInputAck(TerminalInputAckResponse),
    #[serde(rename = "surface.capture-chunk")]
    SurfaceCaptureChunk(SurfaceCaptureChunkResponse),
    #[serde(rename = "surface.capture-completed")]
    SurfaceCaptureCompleted(SurfaceCaptureCompletedResponse),
    #[serde(rename = "events.replayed")]
    EventsReplayed(EventsReplayedResponse),
    #[serde(rename = "events.acknowledged")]
    EventsAcknowledged(EventsAcknowledgedResponse),
    #[serde(rename = "conversion.prepared")]
    ConversionPrepared(ConversionPreparedResponse),
    #[serde(rename = "conversion.promoted")]
    ConversionPromoted(ConversionPromotedResponse),
    #[serde(rename = "provisional.reclaimed")]
    ProvisionalReclaimed(ProvisionalReclaimedResponse),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResponse {
    pub protocol_version: u16,
    pub runtime_version: String,
    pub bridge_generation: String,
    pub capabilities: Vec<String>,
    pub authority: RemoteAuthority,
    pub platform: String,
    pub arch: String,
    pub abi: String,
    pub persistence_level: RemotePersistenceLevel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemotePersistenceLevel {
    SshDisconnect,
    UserLogout,
    HostReboot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAuthority {
    pub remote_installation_id: String,
    pub execution_node_id: String,
    pub authenticated_principal: RemotePrincipal,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePrincipal {
    pub uid: u32,
    pub account_name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub outcome: String,
    pub operation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_resource_revision: Option<String>,
    pub result_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keeper_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedResponse {
    pub target_id: String,
    pub bridge_generation: String,
    pub observed_at: String,
    pub workspaces: Vec<ObservedWorkspace>,
    pub keepers: Vec<ObservedKeeper>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedWorkspace {
    pub resource_key: RemoteResourceKey,
    pub state: String,
    pub remote_resource_revision: String,
    pub create_operation_id: String,
    pub canonical_create_payload_hash: String,
    pub last_operation_id: String,
    pub last_operation_payload_hash: String,
    pub last_result_digest: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedKeeper {
    pub resource_key: RemoteResourceKey,
    pub keeper_generation: String,
    pub descriptor_state: String,
    pub process_state: String,
    pub remote_resource_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub create_operation_id: String,
    pub canonical_create_payload_hash: String,
    pub last_operation_id: String,
    pub last_operation_payload_hash: String,
    pub last_result_digest: String,
    pub launch: RemoteSessionLaunchPayload,
    pub lifecycle_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversion_transaction_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_snapshot_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provisional_created_at: Option<String>,
    pub ever_granted_writer_lease: bool,
    pub storage_status: RemoteSessionStorageStatus,
    pub checkpoint_available: bool,
    pub retained_range_truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInspectedResponse {
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<GitRepositoryResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub dirty_entries: Vec<String>,
    pub dirty_entries_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_exists: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryResponse {
    pub root: String,
    pub git_dir: String,
    pub common_git_dir: String,
    pub linked_worktree: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortsInspectedResponse {
    pub resource_key: RemoteResourceKey,
    pub ports: Vec<u16>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryScannedResponse {
    pub target_id: String,
    pub principal: RemotePrincipal,
    pub records: Vec<RemoteHistoryRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHistoryRecord {
    pub vendor: String,
    pub session_id: String,
    pub updated_at_unix_ms: String,
    pub can_resume: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recent_conversation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageScannedResponse {
    pub target_id: String,
    pub principal: RemotePrincipal,
    pub truncated: bool,
    pub records: Vec<RemoteUsageRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUsageRecord {
    pub vendor: String,
    pub sample_id: String,
    pub timestamp_unix_ms: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub input_tokens: String,
    pub output_tokens: String,
    pub thinking_tokens: String,
    pub cache_read_tokens: String,
    pub cache_write_tokens: String,
    pub cache_write_tokens_known: bool,
    pub total_tokens: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardsObservedResponse {
    pub target_id: String,
    pub forwards: Vec<DesiredForwardResponse>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesiredForwardResponse {
    pub resource_key: RemoteResourceKey,
    pub forward_id: String,
    pub remote_host: String,
    pub remote_port: u16,
    pub local_bind_host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_port: Option<u16>,
    pub operation_id: String,
    pub remote_resource_revision: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionPreparedResponse {
    pub transaction_id: String,
    pub remote_snapshot_hash: String,
    pub workspace_descriptor_hash: String,
    pub session_descriptor_hash: String,
    pub keeper_generation: String,
    pub remote_resource_revision: String,
    pub remote_created_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionPromotedResponse {
    pub transaction_id: String,
    pub remote_snapshot_hash: String,
    pub remote_promotion_hash: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionalReclaimedResponse {
    pub protected_count: usize,
    pub terminated_transaction_ids: Vec<String>,
    pub skipped_ever_leased_transaction_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachAuthorizedResponse {
    pub resource_key: RemoteResourceKey,
    pub keeper_generation: String,
    pub attach_capability: String,
    pub expires_at: String,
    pub access: AttachmentAccess,
    pub terminal_proxy: TerminalProxyEndpoint,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInputAckResponse {
    pub resource_key: RemoteResourceKey,
    pub keeper_generation: String,
    pub operation_id: String,
    pub writer_lease_id: String,
    pub byte_length: usize,
    pub boundary: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceCaptureChunkResponse {
    pub capture_id: String,
    pub index: usize,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceCaptureCompletedResponse {
    pub capture_id: String,
    pub resource_key: RemoteResourceKey,
    pub keeper_generation: String,
    pub mutation_sequence: String,
    pub cols: u16,
    pub rows: u16,
    pub line_count: usize,
    pub byte_length: usize,
    pub chunk_count: usize,
    pub sha256: String,
    pub lines_truncated: bool,
    pub bytes_truncated: bool,
    pub retained_range_truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteSpoolEvent {
    pub version: u16,
    pub sequence: String,
    pub event_id: String,
    pub kind: String,
    pub name: String,
    pub resource_key: RemoteResourceKey,
    pub surface_id: String,
    pub keeper_generation: String,
    pub created_at_unix_ms: String,
    pub payload: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsReplayedResponse {
    pub target_id: String,
    pub events: Vec<RemoteSpoolEvent>,
    pub acknowledged_through: String,
    pub has_more: bool,
    pub admitted_count: String,
    pub dropped_low_value_count: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsAcknowledgedResponse {
    pub target_id: String,
    pub acknowledged_through: String,
    pub removed_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TerminalProxyEndpoint {
    Direct,
    Cohort {
        executable_path: String,
        socket_path: String,
        keeper_local_protocol_major: u16,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeeperAttachRequest {
    #[serde(rename = "type")]
    pub message_type: String,
    pub protocol_version: u16,
    pub roots: RemoteRuntimeRoots,
    pub resource_key: RemoteResourceKey,
    pub keeper_generation: String,
    pub attach_capability: String,
    pub attachment_id: String,
    pub access: AttachmentAccess,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_received_sequence: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CohortProxyRequest {
    Health {
        target_id: String,
        keeper_local_protocol_major: u16,
    },
    Authorize {
        roots: RemoteRuntimeRoots,
        resource_key: RemoteResourceKey,
        keeper_generation: String,
        attach_capability: String,
        expires_at_unix_ms: u64,
        access: AttachmentAccess,
    },
    Attach {
        request: KeeperAttachRequest,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CohortProxyResponse {
    Healthy {
        target_id: String,
        keeper_local_protocol_major: u16,
        executable_generation: String,
    },
    Authorized {},
    Attached {},
    Error {
        code: String,
        message: String,
        retryable: bool,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type")]
pub enum KeeperControlMessage {
    #[serde(rename = "attach.ready")]
    AttachReady {
        #[serde(rename = "keeperGeneration")]
        keeper_generation: String,
        #[serde(rename = "attachmentId")]
        attachment_id: String,
        #[serde(rename = "writerLeaseId", skip_serializing_if = "Option::is_none")]
        writer_lease_id: Option<String>,
        #[serde(rename = "checkpointAvailable")]
        checkpoint_available: bool,
        cols: u16,
        rows: u16,
        #[serde(rename = "earliestAvailableSequence")]
        earliest_available_sequence: String,
        #[serde(rename = "replayFromSequence")]
        replay_from_sequence: String,
        #[serde(rename = "liveStartsAfterSequence")]
        live_starts_after_sequence: String,
        #[serde(
            rename = "truncatedBeforeSequence",
            skip_serializing_if = "Option::is_none"
        )]
        truncated_before_sequence: Option<String>,
    },
    #[serde(rename = "checkpoint.begin")]
    CheckpointBegin {
        #[serde(rename = "checkpointId")]
        checkpoint_id: String,
        format: String,
        #[serde(rename = "parserVersion")]
        parser_version: String,
        #[serde(rename = "lastMutationSequence")]
        last_mutation_sequence: String,
        cols: u16,
        rows: u16,
        #[serde(rename = "byteLength")]
        byte_length: String,
    },
    #[serde(rename = "checkpoint.end")]
    CheckpointEnd {
        #[serde(rename = "checkpointId")]
        checkpoint_id: String,
        sha256: String,
    },
    #[serde(rename = "input.ack")]
    InputAck {
        #[serde(rename = "writerLeaseId")]
        writer_lease_id: String,
        #[serde(rename = "attachmentId")]
        attachment_id: String,
        #[serde(rename = "highestAppliedInputSequence")]
        highest_applied_input_sequence: String,
        boundary: String,
    },
    #[serde(rename = "resize.ack")]
    ResizeAck {
        #[serde(rename = "writerLeaseId")]
        writer_lease_id: String,
        #[serde(rename = "attachmentId")]
        attachment_id: String,
        #[serde(rename = "mutationSequence")]
        mutation_sequence: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "terminal.error")]
    TerminalError {
        code: String,
        message: String,
        retryable: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_terminal_messages_round_trip_losslessly() {
        let fixtures = [
            RemoteTerminalWireMessage::Output {
                sequence: u64::MAX,
                data: vec![0, 255, 10],
            },
            RemoteTerminalWireMessage::Input {
                writer_lease_id: "lease_1".to_owned(),
                attachment_id: "attachment_1".to_owned(),
                input_sequence: 9_007_199_254_740_993,
                data: vec![0, 255, 10],
            },
            RemoteTerminalWireMessage::ResizeRequest {
                writer_lease_id: "lease_1".to_owned(),
                attachment_id: "attachment_1".to_owned(),
                cols: 120,
                rows: 40,
            },
        ];
        for fixture in fixtures {
            assert_eq!(
                decode_terminal_message(&encode_terminal_message(&fixture).unwrap()).unwrap(),
                fixture
            );
        }
    }

    #[test]
    fn frame_decoder_rejects_unknown_and_oversized_before_payload_read() {
        assert!(matches!(
            read_remote_frame(&mut &[0, 0, 0, 1, 99][..]),
            Err(RemoteWireError::UnknownFrameKind(99))
        ));
        assert!(matches!(
            read_remote_frame(&mut &[0, 16, 0, 1][..]),
            Err(RemoteWireError::InvalidFrameLength)
        ));
    }

    #[test]
    fn control_json_rejects_surplus_fields() {
        let json = br#"{
          "protocolVersion":1,
          "requestId":"request_1",
          "token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "roots":{"installRoot":"/i","authorityRoot":"/a","stateRoot":"/s","runtimeRoot":"/r"},
          "request":{"type":"hello","fallback":true}
        }"#;
        assert!(serde_json::from_slice::<BridgeRequestEnvelope>(json).is_err());
    }

    #[test]
    fn retention_policy_uses_the_protocol_mib_field_spelling() {
        let policy = RemoteRetentionPolicy::default();
        assert_eq!(
            serde_json::to_value(policy).unwrap(),
            serde_json::json!({
                "sessionQuotaMiB": 256,
                "targetQuotaMiB": 2048
            })
        );
        assert_eq!(
            serde_json::from_value::<RemoteRetentionPolicy>(serde_json::json!({
                "sessionQuotaMiB": 64,
                "targetQuotaMiB": 256
            }))
            .unwrap(),
            RemoteRetentionPolicy {
                session_quota_mib: 64,
                target_quota_mib: 256
            }
        );
        assert!(
            serde_json::from_value::<RemoteRetentionPolicy>(serde_json::json!({
                "sessionQuotaMib": 64,
                "targetQuotaMib": 256
            }))
            .is_err()
        );
    }
}
