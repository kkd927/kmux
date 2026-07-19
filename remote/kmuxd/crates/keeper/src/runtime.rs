use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, TrySendError, bounded};
use kmux_compat::{
    AttachmentAccess, KeeperAttachRequest, KeeperControlMessage,
    REMOTE_CHECKPOINT_CHUNK_HARD_MAX_BYTES, REMOTE_CHECKPOINT_HARD_MAX_BYTES,
    REMOTE_PROTOCOL_VERSION, RemoteFrameKind, RemoteResourceKey, RemoteRetentionPolicy,
    RemoteRuntimeRoots, RemoteSessionStorageState, RemoteSessionStorageStatus,
    RemoteTerminalWireMessage, RemoteWireError, decode_terminal_message, encode_terminal_message,
    read_control, read_remote_frame, write_control, write_remote_frame,
};
use kmux_hook::{
    AdmitEventRequest, HookError, admit_event_from_endpoint, authorize_session_control_endpoint,
    record_low_value_drops_from_endpoint,
};
use kmux_journal::{JournalError, MutationJournal};
use kmux_platform::{PosixPtyBackend, PtyBackend, PtyError, PtySize, effective_uid};
use kmux_terminal::{
    HeadlessTerminalModel, ParserSideEffect, ParserSideEffectKind, ParserWorker,
    TerminalCheckpoint, TerminalMutation, TerminalSideEffectScanner, Utf8OutputNormalizer,
};
use nix::errno::Errno;
use nix::fcntl::{Flock, FlockArg, OFlag};
use nix::sys::signal::Signal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

pub const SESSION_DESCRIPTOR_VERSION: u16 = 1;
const MAX_DESCRIPTOR_BYTES: u64 = 256 * 1024;
const MAX_RETAINED_MUTATION_BYTES: usize = 16 * 1024 * 1024;
const OUTBOUND_QUEUE_CAPACITY: usize = 64;
const OWNER_COMMAND_CAPACITY: usize = 1024;
const PARSER_COMMAND_CAPACITY: usize = 4096;
const MAX_INPUT_RECORDS: usize = 4096;
const MAX_INPUT_SCOPES: usize = 4096;
const MAX_ATTACHMENTS_PER_KEEPER: usize = 1024;
const MAX_OPERATION_INPUT_RECORDS: usize = 4096;
const MAX_OPERATION_INPUT_RECORD_BYTES: u64 = 64 * 1024;
const MAX_PENDING_SIDE_EFFECTS: usize = 16 * 1024;
const MAX_EMERGENCY_MUTATION_BYTES: usize = 4 * 1024 * 1024;
const EMERGENCY_OUTPUT_RESERVE_BYTES: usize = 36;
const RETAINED_CHECKPOINT_VERSION: u16 = 1;
const RETENTION_GC_INTENT_VERSION: u16 = 1;
const RETENTION_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const RETENTION_CLEANUP_START_PERCENT: u64 = 90;
const RETENTION_CLEANUP_STOP_PERCENT: u64 = 75;
const MAX_RETENTION_SCAN_ENTRIES: usize = 16 * 1024;
pub const MAX_SURFACE_CAPTURE_BYTES: usize = 1024 * 1024;
pub const MAX_SURFACE_CAPTURE_LINES: usize = 65_536;
pub const SURFACE_CAPTURE_CHUNK_BYTES: usize = 32 * 1024;
pub const ATTACH_CAPABILITY_TTL: Duration = Duration::from_secs(30);
const DESCRIPTOR_LOCK_TIMEOUT: Duration = Duration::from_secs(10);
const BELL_ADMISSION_INTERVAL: Duration = Duration::from_secs(10);
const LOW_VALUE_DROP_FLUSH_INTERVAL: Duration = Duration::from_secs(5);
const LOW_VALUE_DROP_FLUSH_COUNT: u64 = 4_096;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeeperLaunchConfig {
    pub cwd: String,
    pub shell: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<BTreeMap<String, String>>,
    pub title: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionDescriptorState {
    Creating,
    Running,
    Exited,
    Terminated,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LaunchInputOutcome {
    Accepted,
    Written,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchInputRecord {
    pub operation_id: String,
    pub payload_hash: String,
    pub byte_length: usize,
    pub written_offset: usize,
    pub outcome: LaunchInputOutcome,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionDescriptor {
    pub version: u16,
    pub resource_key: RemoteResourceKey,
    pub keeper_generation: String,
    pub executable_generation: String,
    pub executable_path: String,
    pub keeper_local_protocol_major: u16,
    pub terminal_wire_version: u16,
    pub create_operation_id: String,
    pub canonical_create_payload_hash: String,
    pub create_result_digest: String,
    pub remote_resource_revision: String,
    pub last_operation_id: String,
    pub last_operation_payload_hash: String,
    pub last_result_digest: String,
    pub state: SessionDescriptorState,
    pub socket_path: String,
    pub journal_path: String,
    pub launch: KeeperLaunchConfig,
    pub keeper_pid: Option<u32>,
    pub child_pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub launch_input: Option<LaunchInputRecord>,
    pub updated_at: String,
    #[serde(default)]
    pub lifecycle_state: SessionLifecycleState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversion_transaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_snapshot_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provisional_created_at: Option<String>,
    #[serde(default)]
    pub ever_granted_writer_lease: bool,
    #[serde(default)]
    pub storage_status: RemoteSessionStorageStatus,
    #[serde(default)]
    pub retention_policy: RemoteRetentionPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_checkpoint: Option<RetainedCheckpointRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated_before_sequence: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedCheckpointRecord {
    pub version: u16,
    pub resource_key: RemoteResourceKey,
    pub keeper_generation: String,
    pub checkpoint_path: String,
    pub format: String,
    pub parser_version: String,
    pub mutation_sequence: String,
    pub cols: u16,
    pub rows: u16,
    pub byte_length: u64,
    pub sha256: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetentionGcIntent {
    version: u16,
    resource_key: RemoteResourceKey,
    keeper_generation: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionLifecycleState {
    #[default]
    Committed,
    Provisional,
    Abandoned,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachCapabilityRecord {
    resource_key: RemoteResourceKey,
    keeper_generation: String,
    access: AttachmentAccess,
    expires_at_unix_ms: u64,
}

#[derive(Debug, Error)]
pub enum KeeperRuntimeError {
    #[error("keeper runtime I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("keeper runtime JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("keeper remote wire failed: {0}")]
    Wire(#[from] RemoteWireError),
    #[error("keeper PTY failed: {0}")]
    Pty(#[from] PtyError),
    #[error("keeper journal failed: {0}")]
    Journal(#[from] kmux_journal::JournalError),
    #[error("keeper terminal model failed: {0}")]
    Terminal(#[from] kmux_terminal::TerminalModelError),
    #[error("keeper request is invalid: {0}")]
    Invalid(&'static str),
    #[error("keeper request was fenced: {0}")]
    Fenced(&'static str),
    #[error("keeper operation outcome is unknown: {0}")]
    OutcomeUnknown(&'static str),
    #[error("keeper operation is temporarily unavailable: {0}")]
    Retryable(&'static str),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum KeeperSocketRequest {
    #[serde(rename = "keeper.attach")]
    Attach {
        #[serde(rename = "protocolVersion")]
        protocol_version: u16,
        roots: RemoteRuntimeRoots,
        #[serde(rename = "resourceKey")]
        resource_key: RemoteResourceKey,
        #[serde(rename = "keeperGeneration")]
        keeper_generation: String,
        #[serde(rename = "attachCapability")]
        attach_capability: String,
        #[serde(rename = "attachmentId")]
        attachment_id: String,
        access: AttachmentAccess,
        #[serde(rename = "lastReceivedSequence")]
        last_received_sequence: Option<String>,
    },
    #[serde(rename = "keeper.launch-input")]
    LaunchInput {
        #[serde(rename = "keeperGeneration")]
        keeper_generation: String,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "payloadHash")]
        payload_hash: String,
        input: String,
    },
    #[serde(rename = "keeper.operation-input")]
    OperationInput {
        #[serde(rename = "resourceKey")]
        resource_key: RemoteResourceKey,
        #[serde(rename = "keeperGeneration")]
        keeper_generation: String,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "payloadHash")]
        payload_hash: String,
        input: String,
    },
    #[serde(rename = "keeper.capture")]
    Capture {
        #[serde(rename = "resourceKey")]
        resource_key: RemoteResourceKey,
        #[serde(rename = "keeperGeneration")]
        keeper_generation: String,
        #[serde(rename = "captureId")]
        capture_id: String,
        #[serde(rename = "lineLimit")]
        line_limit: usize,
        #[serde(rename = "maxBytes")]
        max_bytes: usize,
    },
    #[serde(rename = "keeper.terminate")]
    Terminate {
        #[serde(rename = "keeperGeneration")]
        keeper_generation: String,
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "payloadHash")]
        payload_hash: String,
        #[serde(rename = "nextRemoteResourceRevision")]
        next_remote_resource_revision: String,
        #[serde(rename = "resultDigest")]
        result_digest: String,
    },
    #[serde(rename = "keeper.health")]
    Health {
        #[serde(rename = "keeperGeneration")]
        keeper_generation: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum KeeperRpcResponse {
    #[serde(rename = "keeper.result")]
    Result {
        outcome: String,
        #[serde(rename = "writtenOffset", skip_serializing_if = "Option::is_none")]
        written_offset: Option<usize>,
        #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
    },
    #[serde(rename = "keeper.health")]
    Health {
        outcome: String,
        storage: RemoteSessionStorageStatus,
    },
    #[serde(rename = "keeper.input-ack")]
    InputAck {
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "keeperGeneration")]
        keeper_generation: String,
        #[serde(rename = "writerLeaseId")]
        writer_lease_id: String,
        #[serde(rename = "byteLength")]
        byte_length: usize,
        boundary: String,
    },
    #[serde(rename = "keeper.capture-chunk")]
    CaptureChunk {
        #[serde(rename = "captureId")]
        capture_id: String,
        index: usize,
        text: String,
    },
    #[serde(rename = "keeper.capture-completed")]
    CaptureCompleted {
        #[serde(rename = "captureId")]
        capture_id: String,
        #[serde(rename = "resourceKey")]
        resource_key: RemoteResourceKey,
        #[serde(rename = "keeperGeneration")]
        keeper_generation: String,
        #[serde(rename = "mutationSequence")]
        mutation_sequence: String,
        cols: u16,
        rows: u16,
        #[serde(rename = "lineCount")]
        line_count: usize,
        #[serde(rename = "byteLength")]
        byte_length: usize,
        #[serde(rename = "chunkCount")]
        chunk_count: usize,
        sha256: String,
        #[serde(rename = "linesTruncated")]
        lines_truncated: bool,
        #[serde(rename = "bytesTruncated")]
        bytes_truncated: bool,
        #[serde(rename = "retainedRangeTruncated")]
        retained_range_truncated: bool,
    },
    #[serde(rename = "keeper.error")]
    Error {
        code: String,
        message: String,
        retryable: bool,
    },
}

enum OwnerCommand {
    Attach {
        attachment_id: String,
        access: AttachmentAccess,
        last_received_sequence: Option<u64>,
        outbound: Sender<OutboundMessage>,
        closed: Arc<AtomicBool>,
        response: Sender<Result<AttachSnapshot, KeeperRuntimeError>>,
    },
    Input {
        writer_lease_id: String,
        attachment_id: String,
        input_sequence: u64,
        data: Vec<u8>,
        response: Sender<Result<KeeperControlMessage, KeeperRuntimeError>>,
    },
    Resize {
        writer_lease_id: String,
        attachment_id: String,
        cols: u16,
        rows: u16,
        response: Sender<Result<KeeperControlMessage, KeeperRuntimeError>>,
    },
    Detach {
        attachment_id: String,
    },
    LaunchInput {
        operation_id: String,
        payload_hash: String,
        data: Vec<u8>,
        response: Sender<Result<KeeperRpcResponse, KeeperRuntimeError>>,
    },
    OperationInput {
        operation_id: String,
        payload_hash: String,
        data: Vec<u8>,
        response: Sender<Result<KeeperRpcResponse, KeeperRuntimeError>>,
    },
    Capture {
        capture_id: String,
        line_limit: usize,
        max_bytes: usize,
        response: Sender<Result<KeeperCaptureSnapshot, KeeperRuntimeError>>,
    },
    Terminate {
        operation_id: String,
        payload_hash: String,
        next_remote_resource_revision: String,
        result_digest: String,
        accepted: Sender<Result<(), KeeperRuntimeError>>,
        response: Sender<Result<KeeperRpcResponse, KeeperRuntimeError>>,
    },
    Health {
        response: Sender<Result<KeeperRpcResponse, KeeperRuntimeError>>,
    },
}

#[derive(Clone)]
enum OutboundMessage {
    Control(KeeperControlMessage),
    Mutation(TerminalMutation),
}

struct Subscriber {
    outbound: Sender<OutboundMessage>,
    closed: Arc<AtomicBool>,
}

enum BufferedMutationCompletion {
    Control {
        response: Sender<Result<KeeperControlMessage, KeeperRuntimeError>>,
        value: KeeperControlMessage,
    },
}

struct BufferedMutation {
    mutation: TerminalMutation,
    bytes: usize,
    completion: Option<BufferedMutationCompletion>,
}

#[derive(Default)]
struct EmergencyMutationBuffer {
    entries: VecDeque<BufferedMutation>,
    bytes: usize,
}

impl EmergencyMutationBuffer {
    fn push(&mut self, mutation: TerminalMutation) -> Result<(), KeeperRuntimeError> {
        let bytes = mutation_bytes(&mutation);
        if self.bytes.saturating_add(bytes) > MAX_EMERGENCY_MUTATION_BYTES {
            return Err(KeeperRuntimeError::Retryable(
                "journal emergency mutation buffer is full",
            ));
        }
        self.bytes = self.bytes.saturating_add(bytes);
        self.entries.push_back(BufferedMutation {
            mutation,
            bytes,
            completion: None,
        });
        Ok(())
    }

    fn attach_last_completion(
        &mut self,
        sequence: u64,
        completion: BufferedMutationCompletion,
    ) -> Result<(), KeeperRuntimeError> {
        let entry = self
            .entries
            .back_mut()
            .filter(|entry| entry.mutation.sequence() == sequence)
            .ok_or(KeeperRuntimeError::OutcomeUnknown(
                "buffered mutation completion lost its sequence",
            ))?;
        if entry.completion.is_some() {
            return Err(KeeperRuntimeError::OutcomeUnknown(
                "buffered mutation already has a completion",
            ));
        }
        entry.completion = Some(completion);
        Ok(())
    }

    fn tail_sequence(&self, admitted_sequence: u64) -> u64 {
        self.entries
            .back()
            .map_or(admitted_sequence, |entry| entry.mutation.sequence())
    }

    fn available_bytes(&self) -> usize {
        MAX_EMERGENCY_MUTATION_BYTES.saturating_sub(self.bytes)
    }

    fn max_safe_output_read(&self, buffer_bytes: usize) -> usize {
        self.available_bytes()
            .saturating_sub(EMERGENCY_OUTPUT_RESERVE_BYTES)
            .min(buffer_bytes)
    }

    fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MutationCommit {
    Admitted,
    Buffered,
}

struct PendingTermination {
    operation_id: String,
    payload_hash: String,
    next_remote_resource_revision: String,
    result_digest: String,
    response: Option<Sender<Result<KeeperRpcResponse, KeeperRuntimeError>>>,
    signal_deadline: Instant,
    kill_sent: bool,
}

#[derive(Default)]
struct SideEffectAdmissionState {
    last_bell_admitted_at: Option<Duration>,
    dropped_bells: u64,
    last_drop_flush_at: Duration,
}

#[derive(Default)]
struct RetentionQuotaState {
    last_checked_at: Duration,
    pressure_active: bool,
    backpressured: bool,
    cleanup_failed: bool,
    last_compacted_sequence: u64,
}

impl RetentionQuotaState {
    fn check_is_due(&self, now: Duration) -> bool {
        now.saturating_sub(self.last_checked_at) >= RETENTION_CHECK_INTERVAL
    }

    fn observe_usage(
        &mut self,
        session_bytes: u64,
        target_bytes: u64,
        policy: RemoteRetentionPolicy,
    ) {
        let starts = session_bytes
            >= quota_percent(
                policy.session_quota_bytes(),
                RETENTION_CLEANUP_START_PERCENT,
            )
            || target_bytes
                >= quota_percent(policy.target_quota_bytes(), RETENTION_CLEANUP_START_PERCENT);
        let stopped = session_bytes
            <= quota_percent(policy.session_quota_bytes(), RETENTION_CLEANUP_STOP_PERCENT)
            && target_bytes
                <= quota_percent(policy.target_quota_bytes(), RETENTION_CLEANUP_STOP_PERCENT);
        if !self.pressure_active && starts {
            self.pressure_active = true;
        } else if self.pressure_active && stopped {
            self.pressure_active = false;
        }
        self.backpressured = self.pressure_active;
        if !self.pressure_active {
            self.cleanup_failed = false;
        }
    }
}

fn quota_percent(quota: u64, percent: u64) -> u64 {
    quota.saturating_mul(percent) / 100
}

impl PendingTermination {
    fn matches(
        &self,
        operation_id: &str,
        payload_hash: &str,
        next_remote_resource_revision: &str,
        result_digest: &str,
    ) -> bool {
        self.operation_id == operation_id
            && self.payload_hash == payload_hash
            && self.next_remote_resource_revision == next_remote_resource_revision
            && self.result_digest == result_digest
    }
}

struct AttachmentRegistration {
    commands: Sender<OwnerCommand>,
    attachment_id: String,
    closed: Arc<AtomicBool>,
    active: bool,
}

impl AttachmentRegistration {
    fn new(commands: Sender<OwnerCommand>, attachment_id: String, closed: Arc<AtomicBool>) -> Self {
        Self {
            commands,
            attachment_id,
            closed,
            active: true,
        }
    }

    fn detach(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;
        self.closed.store(true, Ordering::Release);
        let _ = self.commands.send(OwnerCommand::Detach {
            attachment_id: self.attachment_id.clone(),
        });
    }
}

impl Drop for AttachmentRegistration {
    fn drop(&mut self) {
        self.detach();
    }
}

struct AttachSnapshot {
    writer_lease_id: Option<String>,
    cols: u16,
    rows: u16,
    earliest_available_sequence: u64,
    replay_from_sequence: u64,
    live_starts_after_sequence: u64,
    truncated_before_sequence: Option<u64>,
    checkpoint: Option<TerminalCheckpoint>,
    replay: Vec<TerminalMutation>,
}

#[derive(Clone)]
struct InputRecord {
    payload_hash: [u8; 32],
    input_epoch: u64,
    written_offset: usize,
    completed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeeperOperationInputRequest<'a> {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub resource_key: &'a RemoteResourceKey,
    pub keeper_generation: &'a str,
    pub operation_id: &'a str,
    pub payload_hash: &'a str,
    pub input: &'a str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeeperCaptureRequest<'a> {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub resource_key: &'a RemoteResourceKey,
    pub keeper_generation: &'a str,
    pub capture_id: &'a str,
    pub line_limit: usize,
    pub max_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeeperCaptureResult {
    pub capture_id: String,
    pub resource_key: RemoteResourceKey,
    pub keeper_generation: String,
    pub mutation_sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub text: String,
    pub line_count: usize,
    pub lines_truncated: bool,
    pub bytes_truncated: bool,
    pub retained_range_truncated: bool,
}

struct KeeperCaptureSnapshot {
    result: KeeperCaptureResult,
    sha256: String,
}

#[derive(Clone)]
struct KeeperEventSpool {
    endpoint_path: PathBuf,
    token: String,
    keeper_generation: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationInputRecord {
    version: u16,
    keeper_generation: String,
    operation_id: String,
    payload_hash: String,
    writer_lease_id: String,
    temporary_lease: bool,
    input_epoch: u64,
    byte_length: usize,
    written_offset: usize,
    outcome: OperationInputOutcome,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum OperationInputOutcome {
    Accepted,
    Written,
    OutcomeUnknown,
}

pub fn session_descriptor_path(state_root: &Path, resource_key: &RemoteResourceKey) -> PathBuf {
    state_root
        .join("sessions")
        .join(format!("{}.json", resource_key_digest(resource_key)))
}

pub fn resource_key_digest(resource_key: &RemoteResourceKey) -> String {
    let mut digest = Sha256::new();
    for value in [
        &resource_key.desktop_installation_id,
        &resource_key.target_id,
        &resource_key.workspace_id,
        resource_key.session_id.as_deref().unwrap_or(""),
    ] {
        digest.update(value.as_bytes());
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}

pub fn session_journal_path(
    state_root: &Path,
    resource_key: &RemoteResourceKey,
    keeper_generation: &str,
) -> PathBuf {
    let key_digest = resource_key_digest(resource_key);
    let generation_suffix = keeper_generation
        .strip_prefix("keeper_")
        .unwrap_or(keeper_generation)
        .chars()
        .filter(|character| *character != '-')
        .take(8)
        .collect::<String>();
    state_root
        .join("journals")
        .join(format!("{}-{generation_suffix}.journal", &key_digest[..24]))
}

fn retained_checkpoint_directory(
    descriptor_path: &Path,
    descriptor: &SessionDescriptor,
) -> Result<PathBuf, KeeperRuntimeError> {
    Ok(
        retained_checkpoint_resource_directory(descriptor_path, descriptor)?
            .join(&descriptor.keeper_generation),
    )
}

fn retained_checkpoint_resource_directory(
    descriptor_path: &Path,
    descriptor: &SessionDescriptor,
) -> Result<PathBuf, KeeperRuntimeError> {
    let sessions_directory = descriptor_path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("descriptor path has no parent"))?;
    let state_root = sessions_directory
        .parent()
        .ok_or(KeeperRuntimeError::Invalid(
            "descriptor path has no state root",
        ))?;
    Ok(state_root
        .join("checkpoints")
        .join(resource_key_digest(&descriptor.resource_key)))
}

fn retained_checkpoint_path(
    descriptor_path: &Path,
    descriptor: &SessionDescriptor,
    sha256: &str,
) -> Result<PathBuf, KeeperRuntimeError> {
    Ok(retained_checkpoint_directory(descriptor_path, descriptor)?
        .join(format!("{sha256}.checkpoint")))
}

fn retained_checkpoint_metadata_path(
    descriptor_path: &Path,
    descriptor: &SessionDescriptor,
) -> Result<PathBuf, KeeperRuntimeError> {
    Ok(retained_checkpoint_directory(descriptor_path, descriptor)?.join("current.json"))
}

pub fn load_session_descriptor(path: &Path) -> Result<SessionDescriptor, KeeperRuntimeError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_DESCRIPTOR_BYTES
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != effective_uid()
    {
        return Err(KeeperRuntimeError::Invalid("session descriptor is unsafe"));
    }
    let file = File::open(path)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_DESCRIPTOR_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_DESCRIPTOR_BYTES {
        return Err(KeeperRuntimeError::Invalid(
            "session descriptor is oversized",
        ));
    }
    let descriptor: SessionDescriptor = serde_json::from_slice(&bytes)?;
    validate_descriptor(&descriptor)?;
    validate_retained_checkpoint_location(&descriptor, path)?;
    Ok(descriptor)
}

pub fn write_session_descriptor(
    path: &Path,
    descriptor: &SessionDescriptor,
) -> Result<(), KeeperRuntimeError> {
    validate_descriptor(descriptor)?;
    validate_retained_checkpoint_location(descriptor, path)?;
    write_private_json_atomic(path, descriptor)
}

fn refresh_live_descriptor(
    path: &Path,
    descriptor: &mut SessionDescriptor,
) -> Result<(), KeeperRuntimeError> {
    let current = load_session_descriptor(path)?;
    if current.resource_key != descriptor.resource_key
        || current.keeper_generation != descriptor.keeper_generation
        || current.executable_generation != descriptor.executable_generation
        || current.executable_path != descriptor.executable_path
        || current.socket_path != descriptor.socket_path
        || current.journal_path != descriptor.journal_path
        || current.keeper_pid != descriptor.keeper_pid
        || current.child_pid != descriptor.child_pid
        || current.state != SessionDescriptorState::Running
    {
        return Err(KeeperRuntimeError::Fenced(
            "live session descriptor identity changed",
        ));
    }
    *descriptor = current;
    Ok(())
}

fn persist_first_writer_safety_bit(
    descriptor_path: &Path,
    descriptor: &mut SessionDescriptor,
) -> Result<(), KeeperRuntimeError> {
    let _descriptor_lock = acquire_descriptor_lock(descriptor_path)?;
    let mut refreshed = descriptor.clone();
    refresh_live_descriptor(descriptor_path, &mut refreshed)?;
    commit_first_writer_safety_bit(descriptor, refreshed, |updated| {
        write_session_descriptor(descriptor_path, updated)
    })
}

fn commit_first_writer_safety_bit(
    descriptor: &mut SessionDescriptor,
    mut refreshed: SessionDescriptor,
    persist: impl FnOnce(&SessionDescriptor) -> Result<(), KeeperRuntimeError>,
) -> Result<(), KeeperRuntimeError> {
    if !refreshed.ever_granted_writer_lease {
        refreshed.ever_granted_writer_lease = true;
        refreshed.updated_at = now_rfc3339();
        persist(&refreshed)?;
    }
    *descriptor = refreshed;
    Ok(())
}

struct DescriptorLock {
    _lock: Flock<File>,
}

fn acquire_descriptor_lock(path: &Path) -> Result<DescriptorLock, KeeperRuntimeError> {
    let parent = path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("descriptor path has no parent"))?;
    let lock_path = path.with_extension("lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(OFlag::O_NOFOLLOW.bits())
        .open(&lock_path)?;
    fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != effective_uid() || metadata.mode() & 0o077 != 0 {
        return Err(KeeperRuntimeError::Invalid(
            "descriptor operation lock is unsafe",
        ));
    }
    File::open(parent)?.sync_all()?;
    let deadline = Instant::now() + DESCRIPTOR_LOCK_TIMEOUT;
    let mut file = file;
    loop {
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => return Ok(DescriptorLock { _lock: lock }),
            Err((returned, Errno::EAGAIN)) => {
                file = returned;
                if Instant::now() >= deadline {
                    return Err(KeeperRuntimeError::OutcomeUnknown(
                        "descriptor operation lock is busy",
                    ));
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err((_returned, error)) => {
                return Err(io::Error::from_raw_os_error(error as i32).into());
            }
        }
    }
}

fn try_acquire_descriptor_lock(path: &Path) -> Result<Option<DescriptorLock>, KeeperRuntimeError> {
    let parent = path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("descriptor path has no parent"))?;
    let lock_path = path.with_extension("lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(OFlag::O_NOFOLLOW.bits())
        .open(&lock_path)?;
    fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != effective_uid() || metadata.mode() & 0o077 != 0 {
        return Err(KeeperRuntimeError::Invalid(
            "descriptor operation lock is unsafe",
        ));
    }
    File::open(parent)?.sync_all()?;
    match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
        Ok(lock) => Ok(Some(DescriptorLock { _lock: lock })),
        Err((_returned, Errno::EAGAIN)) => Ok(None),
        Err((_returned, error)) => Err(io::Error::from_raw_os_error(error as i32).into()),
    }
}

pub fn prepare_runtime_directories(roots: &RemoteRuntimeRoots) -> Result<(), KeeperRuntimeError> {
    for root in [&roots.state_root, &roots.runtime_root] {
        let path = Path::new(root);
        if !path.is_absolute() {
            return Err(KeeperRuntimeError::Invalid(
                "runtime roots must be absolute",
            ));
        }
        ensure_private_directory(path)?;
    }
    ensure_private_directory(&Path::new(&roots.state_root).join("sessions"))?;
    ensure_private_directory(&Path::new(&roots.state_root).join("journals"))?;
    ensure_private_directory(&Path::new(&roots.state_root).join("checkpoints"))?;
    ensure_private_directory(&Path::new(&roots.state_root).join("retention-gc"))?;
    ensure_private_directory(&Path::new(&roots.runtime_root).join("keepers"))?;
    ensure_private_directory(&Path::new(&roots.runtime_root).join("attach-caps"))?;
    Ok(())
}

pub fn write_attach_capability(
    roots: &RemoteRuntimeRoots,
    resource_key: &RemoteResourceKey,
    keeper_generation: &str,
    access: AttachmentAccess,
) -> Result<(String, String), KeeperRuntimeError> {
    prepare_runtime_directories(roots)?;
    let (capability, expires_at_unix_ms, expires_at) = new_attach_capability()?;
    let record = AttachCapabilityRecord {
        resource_key: resource_key.clone(),
        keeper_generation: keeper_generation.to_owned(),
        access,
        expires_at_unix_ms,
    };
    let path = attach_capability_path(roots, &capability);
    write_private_json_create_new(&path, &record)?;
    Ok((capability, expires_at))
}

pub fn new_attach_capability() -> Result<(String, u64, String), KeeperRuntimeError> {
    let capability = format!(
        "{:x}",
        Sha256::digest(format!("{}:{}", Uuid::new_v4(), Uuid::new_v4()).as_bytes())
    );
    let expires_at_unix_ms = unix_millis()
        .checked_add(ATTACH_CAPABILITY_TTL.as_millis() as u64)
        .ok_or(KeeperRuntimeError::Invalid("capability deadline overflow"))?;
    Ok((
        capability,
        expires_at_unix_ms,
        format_rfc3339(expires_at_unix_ms),
    ))
}

pub fn run_keeper_server(
    descriptor_path: &Path,
    expected_generation: &str,
) -> Result<(), KeeperRuntimeError> {
    let mut descriptor = load_session_descriptor(descriptor_path)?;
    if descriptor.keeper_generation != expected_generation
        || descriptor.state != SessionDescriptorState::Creating
        || descriptor.keeper_local_protocol_major != kmux_compat::KEEPER_LOCAL_PROTOCOL_MAJOR
        || descriptor.terminal_wire_version != kmux_compat::TERMINAL_WIRE_VERSION
    {
        return Err(KeeperRuntimeError::Fenced("descriptor generation changed"));
    }
    let socket_path = PathBuf::from(&descriptor.socket_path);
    let journal_path = PathBuf::from(&descriptor.journal_path);
    ensure_private_directory(
        socket_path
            .parent()
            .ok_or(KeeperRuntimeError::Invalid("socket has no parent"))?,
    )?;
    let listener = UnixListener::bind(&socket_path)?;
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    let journal_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&journal_path)?;

    let launch = descriptor.launch.clone();
    validate_launch(&launch)?;
    let event_spool = load_keeper_event_spool(&descriptor, descriptor_path)?;
    let shell = launch
        .shell
        .clone()
        .or_else(|| std::env::var("SHELL").ok())
        .filter(|value| Path::new(value).is_absolute())
        .unwrap_or_else(|| "/bin/sh".to_owned());
    let args = launch.args.clone().unwrap_or_default();
    let env = keeper_launch_env(launch.env.as_ref());
    let backend = PosixPtyBackend;
    let mut child = backend.spawn_configured(
        &shell,
        &args,
        Path::new(&launch.cwd),
        &env,
        PtySize {
            cols: launch.cols,
            rows: launch.rows,
        },
    )?;
    child.set_nonblocking(true)?;
    let child_pid = child.process_id();
    descriptor.state = SessionDescriptorState::Running;
    descriptor.keeper_pid = Some(std::process::id());
    descriptor.child_pid = Some(child_pid);
    descriptor.updated_at = now_rfc3339();
    write_session_descriptor(descriptor_path, &descriptor)?;

    let (commands, receiver) = bounded(OWNER_COMMAND_CAPACITY);
    let shutdown = Arc::new(AtomicBool::new(false));
    let accept_shutdown = Arc::clone(&shutdown);
    let accept_descriptor = descriptor.clone();
    let accept_descriptor_path = descriptor_path.to_owned();
    let accept_thread = thread::Builder::new()
        .name("kmux-keeper-socket".to_owned())
        .spawn(move || {
            accept_connections(
                listener,
                commands,
                accept_descriptor,
                accept_descriptor_path,
                accept_shutdown,
            );
        })?;

    let outcome = owner_loop(
        receiver,
        &mut child,
        MutationJournal::new(journal_file, Duration::ZERO),
        descriptor,
        descriptor_path,
        &shutdown,
        event_spool,
    );
    shutdown.store(true, Ordering::Release);
    let _ = accept_thread.join();
    let _ = fs::remove_file(&socket_path);
    if let Some(parent) = socket_path.parent() {
        let _ = File::open(parent).and_then(|directory| directory.sync_all());
    }
    outcome
}

fn keeper_launch_env(env: Option<&BTreeMap<String, String>>) -> BTreeMap<String, String> {
    let mut resolved = env.cloned().unwrap_or_default();
    if let Some(bin_directory) = resolved.get("KMUX_AGENT_BIN_DIR").cloned() {
        let inherited_path = resolved
            .get("PATH")
            .cloned()
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".to_owned());
        resolved.insert(
            "PATH".to_owned(),
            format!("{bin_directory}:{inherited_path}"),
        );
    }
    resolved
}

pub fn invoke_keeper_rpc(
    descriptor: &SessionDescriptor,
    request: &impl Serialize,
) -> Result<KeeperRpcResponse, KeeperRuntimeError> {
    let mut stream = UnixStream::connect(&descriptor.socket_path)?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    write_control(&mut stream, request)?;
    read_control(&mut stream)?.ok_or(KeeperRuntimeError::Invalid(
        "keeper closed without response",
    ))
}

pub fn invoke_keeper_capture(
    descriptor: &SessionDescriptor,
    request: &KeeperCaptureRequest<'_>,
) -> Result<KeeperCaptureResult, KeeperRuntimeError> {
    let mut stream = UnixStream::connect(&descriptor.socket_path)?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    write_control(&mut stream, request)?;
    let mut chunks = Vec::new();
    let mut chunk_bytes = 0_usize;
    loop {
        let message: KeeperRpcResponse = read_control(&mut stream)?
            .ok_or(KeeperRuntimeError::Invalid("keeper closed during capture"))?;
        match message {
            KeeperRpcResponse::CaptureChunk {
                capture_id,
                index,
                text,
            } => {
                append_capture_chunk(
                    &mut chunks,
                    &mut chunk_bytes,
                    request.capture_id,
                    request.max_bytes,
                    capture_id,
                    index,
                    text,
                )?;
            }
            KeeperRpcResponse::CaptureCompleted {
                capture_id,
                resource_key,
                keeper_generation,
                mutation_sequence,
                cols,
                rows,
                line_count,
                byte_length,
                chunk_count,
                sha256,
                lines_truncated,
                bytes_truncated,
                retained_range_truncated,
            } => {
                if capture_id != request.capture_id
                    || resource_key != *request.resource_key
                    || keeper_generation != request.keeper_generation
                    || chunk_count != chunks.len()
                {
                    return Err(KeeperRuntimeError::Invalid(
                        "keeper capture completion is invalid",
                    ));
                }
                let text = chunks.concat();
                let expected_line_count = if text.is_empty() {
                    0
                } else {
                    text.split('\n').count()
                };
                if text.len() != byte_length
                    || text.len() != chunk_bytes
                    || text.len() > request.max_bytes
                    || line_count != expected_line_count
                    || line_count > request.line_limit
                    || cols == 0
                    || rows == 0
                    || format!("{:x}", Sha256::digest(text.as_bytes())) != sha256
                {
                    return Err(KeeperRuntimeError::Invalid(
                        "keeper capture digest or bound is invalid",
                    ));
                }
                return Ok(KeeperCaptureResult {
                    capture_id,
                    resource_key,
                    keeper_generation,
                    mutation_sequence: parse_u64(&mutation_sequence)?,
                    cols,
                    rows,
                    text,
                    line_count,
                    lines_truncated,
                    bytes_truncated,
                    retained_range_truncated,
                });
            }
            KeeperRpcResponse::Error {
                code,
                message: _,
                retryable: _,
            } => {
                return Err(match code.as_str() {
                    "fenced" | "generation-mismatch" => {
                        KeeperRuntimeError::Fenced("keeper capture was fenced")
                    }
                    _ => KeeperRuntimeError::Invalid("keeper capture failed"),
                });
            }
            _ => {
                return Err(KeeperRuntimeError::Invalid(
                    "keeper returned an unexpected capture response",
                ));
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn append_capture_chunk(
    chunks: &mut Vec<String>,
    byte_length: &mut usize,
    expected_capture_id: &str,
    max_bytes: usize,
    capture_id: String,
    index: usize,
    text: String,
) -> Result<(), KeeperRuntimeError> {
    let next_byte_length =
        byte_length
            .checked_add(text.len())
            .ok_or(KeeperRuntimeError::Invalid(
                "keeper capture byte length overflowed",
            ))?;
    if capture_id != expected_capture_id
        || index != chunks.len()
        || text.is_empty()
        || text.len() > SURFACE_CAPTURE_CHUNK_BYTES
        || next_byte_length > max_bytes
        // Empty chunks are rejected, so this also hard-bounds container
        // overhead even if a peer fragments every byte separately.
        || chunks.len() >= max_bytes
    {
        return Err(KeeperRuntimeError::Invalid(
            "keeper capture chunk is invalid",
        ));
    }
    *byte_length = next_byte_length;
    chunks.push(text);
    Ok(())
}

fn load_keeper_event_spool(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
) -> Result<KeeperEventSpool, KeeperRuntimeError> {
    let env = descriptor
        .launch
        .env
        .as_ref()
        .ok_or(KeeperRuntimeError::Invalid(
            "remote keeper event spool environment is missing",
        ))?;
    let endpoint_path = env
        .get("KMUX_AGENT_HOOK_ENDPOINT")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or(KeeperRuntimeError::Invalid(
            "remote keeper hook endpoint is invalid",
        ))?;
    let token = env
        .get("KMUX_AUTH_TOKEN")
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or(KeeperRuntimeError::Invalid(
            "remote keeper hook token is missing",
        ))?;
    let surface_id = env
        .get("KMUX_SURFACE_ID")
        .ok_or(KeeperRuntimeError::Invalid(
            "remote keeper surface identity is missing",
        ))?;
    let endpoint = authorize_session_control_endpoint(&endpoint_path, &token)
        .map_err(|_| KeeperRuntimeError::Invalid("remote keeper hook endpoint is unauthorized"))?;
    if endpoint.resource_key != descriptor.resource_key
        || endpoint.keeper_generation != descriptor.keeper_generation
        || endpoint.surface_id != *surface_id
        || Path::new(&endpoint.descriptor_path) != descriptor_path
    {
        return Err(KeeperRuntimeError::Fenced(
            "remote keeper hook endpoint scope changed",
        ));
    }
    Ok(KeeperEventSpool {
        endpoint_path,
        token,
        keeper_generation: descriptor.keeper_generation.clone(),
    })
}

fn drain_pending_side_effects(
    spool: &KeeperEventSpool,
    pending: &mut VecDeque<ParserSideEffect>,
    state: &mut SideEffectAdmissionState,
    now: Duration,
) -> Result<bool, KeeperRuntimeError> {
    while let Some(effect) = pending.front() {
        let is_bell = matches!(&effect.kind, ParserSideEffectKind::Bell);
        if is_bell
            && state
                .last_bell_admitted_at
                .is_some_and(|last| now.saturating_sub(last) < BELL_ADMISSION_INTERVAL)
        {
            state.dropped_bells =
                state
                    .dropped_bells
                    .checked_add(1)
                    .ok_or(KeeperRuntimeError::Invalid(
                        "low-value bell counter exhausted",
                    ))?;
            pending.pop_front();
            continue;
        }
        let event_id = terminal_side_effect_event_id(&spool.keeper_generation, effect);
        let (kind, name, payload) = match &effect.kind {
            ParserSideEffectKind::Bell => (
                "notification".to_owned(),
                "terminal.bell".to_owned(),
                serde_json::json!({
                    "kind": "bell",
                    "mutationSequence": effect.mutation_sequence.to_string(),
                    "actionIndex": effect.action_index,
                }),
            ),
            ParserSideEffectKind::Notification {
                protocol,
                title,
                message,
            } => (
                "osc-notification".to_owned(),
                format!("terminal.osc.{protocol}"),
                serde_json::json!({
                    "protocol": protocol,
                    "title": title,
                    "message": message,
                    "mutationSequence": effect.mutation_sequence.to_string(),
                    "actionIndex": effect.action_index,
                }),
            ),
        };
        match admit_event_from_endpoint(
            &spool.endpoint_path,
            &spool.token,
            AdmitEventRequest {
                event_id: Some(event_id),
                kind,
                name,
                payload,
            },
        ) {
            Ok(_) => {
                if is_bell {
                    state.last_bell_admitted_at = Some(now);
                }
                pending.pop_front();
            }
            Err(HookError::SpoolFull | HookError::LockTimedOut | HookError::Io(_)) => {
                if is_bell {
                    // Bells are explicitly low-value and may be compacted with
                    // an observable counter. Important OSC notifications stay
                    // queued until their durable admission succeeds.
                    state.dropped_bells =
                        state
                            .dropped_bells
                            .checked_add(1)
                            .ok_or(KeeperRuntimeError::Invalid(
                                "low-value bell counter exhausted",
                            ))?;
                    pending.pop_front();
                } else {
                    return Ok(false);
                }
            }
            Err(_) => {
                return Err(KeeperRuntimeError::Invalid(
                    "terminal side-effect spool is invalid or unauthorized",
                ));
            }
        }
    }
    if state.dropped_bells > 0
        && (state.dropped_bells >= LOW_VALUE_DROP_FLUSH_COUNT
            || now.saturating_sub(state.last_drop_flush_at) >= LOW_VALUE_DROP_FLUSH_INTERVAL)
    {
        match record_low_value_drops_from_endpoint(
            &spool.endpoint_path,
            &spool.token,
            state.dropped_bells,
        ) {
            Ok(()) => {
                state.dropped_bells = 0;
                state.last_drop_flush_at = now;
            }
            Err(HookError::SpoolFull | HookError::LockTimedOut | HookError::Io(_)) => {
                // Counter persistence is retried, but it cannot stall the PTY
                // owner or control socket. A crash replays the journal side
                // effects and accounts for them on the next keeper run.
            }
            Err(_) => {
                return Err(KeeperRuntimeError::Invalid(
                    "terminal low-value counter is invalid or unauthorized",
                ));
            }
        }
    }
    Ok(true)
}

fn terminal_side_effect_event_id(keeper_generation: &str, effect: &ParserSideEffect) -> String {
    let kind = match &effect.kind {
        ParserSideEffectKind::Bell => "bell".to_owned(),
        ParserSideEffectKind::Notification { protocol, .. } => {
            format!("notification-{protocol}")
        }
    };
    let digest = Sha256::digest(
        format!(
            "{keeper_generation}\0{}\0{}\0{kind}",
            effect.mutation_sequence, effect.action_index
        )
        .as_bytes(),
    );
    format!("terminal-event_{digest:x}")
}

fn owner_loop(
    receiver: Receiver<OwnerCommand>,
    child: &mut kmux_platform::PtyChild,
    mut journal: MutationJournal<File>,
    mut descriptor: SessionDescriptor,
    descriptor_path: &Path,
    shutdown: &AtomicBool,
    event_spool: KeeperEventSpool,
) -> Result<(), KeeperRuntimeError> {
    let started = Instant::now();
    let parser = ParserWorker::start(
        descriptor.launch.cols,
        descriptor.launch.rows,
        PARSER_COMMAND_CAPACITY,
    );
    let mut sequence = 0_u64;
    let mut retained = VecDeque::new();
    let mut retained_bytes = 0_usize;
    let mut truncated_before_sequence = None;
    let mut subscribers: HashMap<String, Subscriber> = HashMap::new();
    let mut writer: Option<(String, String)> = None;
    let mut input_deduplication = InputDeduplication::default();
    let mut uncertain_operation_inputs = HashMap::new();
    let mut input_epoch = 0_u64;
    let mut launch_input_fenced = false;
    let mut output_normalizer = Utf8OutputNormalizer::default();
    let mut side_effect_scanner = TerminalSideEffectScanner::default();
    let mut pending_side_effects = VecDeque::new();
    let mut side_effect_admission = SideEffectAdmissionState::default();
    let mut emergency = EmergencyMutationBuffer::default();
    let mut pending_exit_code: Option<Option<i32>> = None;
    let mut pending_exit_output_flushed = false;
    let mut pending_exit_sequence = None;
    let mut pending_termination: Option<PendingTermination> = None;
    let mut pty_eof = false;
    let mut retention = RetentionQuotaState::default();

    commit_mutation(
        TerminalMutation::Resize {
            sequence: 1,
            cols: descriptor.launch.cols,
            rows: descriptor.launch.rows,
        },
        &mut sequence,
        &mut journal,
        &mut emergency,
        &parser,
        &mut retained,
        &mut retained_bytes,
        &mut truncated_before_sequence,
        &mut subscribers,
        &mut side_effect_scanner,
        &mut pending_side_effects,
        started.elapsed(),
    )?;

    let mut buffer = [0_u8; 16 * 1024];
    loop {
        retry_emergency_mutations(
            &mut sequence,
            &mut journal,
            &mut emergency,
            &parser,
            &mut retained,
            &mut retained_bytes,
            &mut truncated_before_sequence,
            &mut subscribers,
            &mut side_effect_scanner,
            &mut pending_side_effects,
            started.elapsed(),
        )?;
        let _side_effects_drained = drain_pending_side_effects(
            &event_spool,
            &mut pending_side_effects,
            &mut side_effect_admission,
            started.elapsed(),
        )?;
        let retention_check_was_due = retention.check_is_due(started.elapsed());
        let force_storage_cleanup = !emergency.is_empty() || journal.admission().storage_degraded;
        if let Err(_error) = maintain_retention(
            &mut descriptor,
            descriptor_path,
            &mut journal,
            &parser,
            &mut retained,
            &mut retained_bytes,
            &mut truncated_before_sequence,
            &mut retention,
            force_storage_cleanup,
            started.elapsed(),
        ) {
            retention.cleanup_failed = true;
            if retention_check_was_due || retention.pressure_active {
                retention.backpressured = true;
            }
        }
        while let Ok(command) = receiver.try_recv() {
            match command {
                OwnerCommand::Attach {
                    attachment_id,
                    access,
                    last_received_sequence,
                    outbound,
                    closed,
                    response,
                } => {
                    subscribers.retain(|_, subscriber| !subscriber.closed.load(Ordering::Acquire));
                    if pending_termination.is_some() {
                        let _ = response.send(Err(KeeperRuntimeError::Retryable(
                            "session termination is in progress",
                        )));
                        continue;
                    }
                    if let Err(error) = validate_attachment_admission(&subscribers, &attachment_id)
                    {
                        let _ = response.send(Err(error));
                        continue;
                    }
                    if last_received_sequence.is_some_and(|cursor| cursor > sequence) {
                        let _ = response.send(Err(KeeperRuntimeError::Fenced(
                            "attachment cursor is ahead of the keeper",
                        )));
                        continue;
                    }
                    if !emergency.is_empty() {
                        let _ = response.send(Err(KeeperRuntimeError::Retryable(
                            "journal emergency mutations are not durable yet",
                        )));
                        continue;
                    }
                    let admission = match journal.force_sync(started.elapsed()) {
                        Ok(admission) => admission,
                        Err(error) if is_storage_admission_error(&error) => {
                            let _ = response.send(Err(KeeperRuntimeError::Retryable(
                                "journal storage is degraded",
                            )));
                            continue;
                        }
                        Err(error) => return Err(error.into()),
                    };
                    let writer_lease_id = if access == AttachmentAccess::Write {
                        if !descriptor.ever_granted_writer_lease {
                            // Persist this safety bit before granting the first
                            // writer. A crash can therefore never make an
                            // interacted-with provisional keeper TTL-eligible.
                            // The bridge may have advanced conversion or
                            // operation metadata since this keeper started, so
                            // merge the current durable descriptor before the
                            // keeper becomes its next writer.
                            if let Err(error) =
                                persist_first_writer_safety_bit(descriptor_path, &mut descriptor)
                            {
                                // Admission is request-scoped. Failing to
                                // persist the safety bit must reject this
                                // writer, but it must not terminate the PTY
                                // owner or make a later retry skip durable
                                // persistence because of mutated memory.
                                let _ = response.send(Err(error));
                                continue;
                            }
                        }
                        // The first ordinary writer permanently fences the
                        // reserved launch writer. A completed launch operation
                        // remains queryable by ID, but no pending launch bytes
                        // can be injected after interactive input begins.
                        launch_input_fenced = true;
                        let lease = format!("lease_{}", Uuid::new_v4());
                        // A newly granted lease permanently fences every older
                        // attachment, so its generation-local retry records no
                        // longer need to consume the bounded live maps.
                        input_deduplication.clear();
                        writer = Some((lease.clone(), attachment_id.clone()));
                        Some(lease)
                    } else {
                        None
                    };
                    let boundary = sequence;
                    let earliest = retained
                        .front()
                        .map_or(sequence.saturating_add(1), TerminalMutation::sequence);
                    let checkpoint = if attach_needs_checkpoint(last_received_sequence, earliest) {
                        parser
                            .checkpoint(admission.journal_synced)
                            .ok()
                            .filter(|value| {
                                value.restore_stream.len() <= REMOTE_CHECKPOINT_HARD_MAX_BYTES
                            })
                    } else {
                        None
                    };
                    let checkpoint_sequence = checkpoint
                        .as_ref()
                        .map_or(0, |checkpoint| checkpoint.last_mutation_sequence);
                    let replay_start = last_received_sequence
                        .map_or(earliest, |cursor| cursor.saturating_add(1))
                        .max(checkpoint_sequence.saturating_add(1));
                    let replay = retained
                        .iter()
                        .filter(|mutation| {
                            mutation.sequence() >= replay_start && mutation.sequence() <= boundary
                        })
                        .cloned()
                        .collect();
                    let size = child.size();
                    subscribers.insert(attachment_id.clone(), Subscriber { outbound, closed });
                    let _ = response.send(Ok(AttachSnapshot {
                        writer_lease_id,
                        cols: size.cols,
                        rows: size.rows,
                        earliest_available_sequence: earliest,
                        replay_from_sequence: replay_start,
                        live_starts_after_sequence: boundary,
                        truncated_before_sequence,
                        checkpoint,
                        replay,
                    }));
                }
                OwnerCommand::Input {
                    writer_lease_id,
                    attachment_id,
                    input_sequence,
                    data,
                    response,
                } => {
                    let result = if pending_termination.is_some() {
                        Err(KeeperRuntimeError::Retryable(
                            "session termination is in progress",
                        ))
                    } else if storage_write_backpressured(&journal, &emergency, &retention) {
                        Err(KeeperRuntimeError::Retryable(
                            "journal storage is applying PTY backpressure",
                        ))
                    } else {
                        apply_input(
                            child,
                            &writer,
                            &writer_lease_id,
                            &attachment_id,
                            input_sequence,
                            &data,
                            &mut input_deduplication,
                            &mut input_epoch,
                        )
                        .map(|highest_applied| {
                            KeeperControlMessage::InputAck {
                                writer_lease_id,
                                attachment_id,
                                highest_applied_input_sequence: highest_applied.to_string(),
                                boundary: "pty-write".to_owned(),
                            }
                        })
                    };
                    let _ = response.send(result);
                }
                OwnerCommand::Resize {
                    writer_lease_id,
                    attachment_id,
                    cols,
                    rows,
                    response,
                } => {
                    let result = (|| {
                        if pending_termination.is_some() {
                            return Err(KeeperRuntimeError::Retryable(
                                "session termination is in progress",
                            ));
                        }
                        require_writer(&writer, &writer_lease_id, &attachment_id)?;
                        let pending_output = output_normalizer.flush();
                        if !pending_output.is_empty() {
                            commit_output(
                                pending_output,
                                &mut sequence,
                                &mut journal,
                                &mut emergency,
                                &parser,
                                &mut retained,
                                &mut retained_bytes,
                                &mut truncated_before_sequence,
                                &mut subscribers,
                                &mut side_effect_scanner,
                                &mut pending_side_effects,
                                started.elapsed(),
                            )?;
                        }
                        child.resize(PtySize { cols, rows })?;
                        let next = emergency
                            .tail_sequence(sequence)
                            .checked_add(1)
                            .ok_or(KeeperRuntimeError::Invalid("mutation sequence exhausted"))?;
                        let commit = commit_mutation(
                            TerminalMutation::Resize {
                                sequence: next,
                                cols,
                                rows,
                            },
                            &mut sequence,
                            &mut journal,
                            &mut emergency,
                            &parser,
                            &mut retained,
                            &mut retained_bytes,
                            &mut truncated_before_sequence,
                            &mut subscribers,
                            &mut side_effect_scanner,
                            &mut pending_side_effects,
                            started.elapsed(),
                        )?;
                        Ok((
                            KeeperControlMessage::ResizeAck {
                                writer_lease_id,
                                attachment_id,
                                mutation_sequence: next.to_string(),
                                cols,
                                rows,
                            },
                            commit,
                            next,
                        ))
                    })();
                    match result {
                        Ok((value, MutationCommit::Admitted, _)) => {
                            let _ = response.send(Ok(value));
                        }
                        Ok((value, MutationCommit::Buffered, sequence)) => {
                            emergency.attach_last_completion(
                                sequence,
                                BufferedMutationCompletion::Control { response, value },
                            )?;
                        }
                        Err(error) => {
                            let _ = response.send(Err(error));
                        }
                    }
                }
                OwnerCommand::Detach { attachment_id } => {
                    subscribers.remove(&attachment_id);
                    if writer
                        .as_ref()
                        .is_some_and(|(_, owner)| owner == &attachment_id)
                    {
                        writer = None;
                    }
                }
                OwnerCommand::LaunchInput {
                    operation_id,
                    payload_hash,
                    data,
                    response,
                } => {
                    let result = if pending_termination.is_some() {
                        Err(KeeperRuntimeError::Retryable(
                            "session termination is in progress",
                        ))
                    } else if storage_write_backpressured(&journal, &emergency, &retention) {
                        Err(KeeperRuntimeError::Retryable(
                            "journal storage is applying PTY backpressure",
                        ))
                    } else {
                        apply_launch_input(
                            child,
                            &mut descriptor,
                            descriptor_path,
                            &operation_id,
                            &payload_hash,
                            &data,
                            launch_input_fenced,
                        )
                    };
                    let _ = response.send(result);
                }
                OwnerCommand::OperationInput {
                    operation_id,
                    payload_hash,
                    data,
                    response,
                } => {
                    let result = if pending_termination.is_some() {
                        Err(KeeperRuntimeError::Retryable(
                            "session termination is in progress",
                        ))
                    } else if storage_write_backpressured(&journal, &emergency, &retention) {
                        Err(KeeperRuntimeError::Retryable(
                            "journal storage is applying PTY backpressure",
                        ))
                    } else {
                        apply_operation_input(
                            child,
                            &mut descriptor,
                            descriptor_path,
                            &writer,
                            &operation_id,
                            &payload_hash,
                            &data,
                            &mut input_epoch,
                            &mut uncertain_operation_inputs,
                        )
                    };
                    // Any accepted one-shot operation permanently fences the
                    // reserved launch writer, just like ordinary interactive
                    // input. This prevents delayed launch input from being
                    // interleaved after a CLI command.
                    if !matches!(
                        &result,
                        Err(KeeperRuntimeError::Invalid(_)) | Err(KeeperRuntimeError::Fenced(_))
                    ) {
                        launch_input_fenced = true;
                    }
                    let _ = response.send(result);
                }
                OwnerCommand::Capture {
                    capture_id,
                    line_limit,
                    max_bytes,
                    response,
                } => {
                    let result = if pending_termination.is_some() {
                        Err(KeeperRuntimeError::Retryable(
                            "session termination is in progress",
                        ))
                    } else if !emergency.is_empty() {
                        Err(KeeperRuntimeError::Retryable(
                            "journal emergency mutations are not durable yet",
                        ))
                    } else {
                        capture_surface(
                            &descriptor,
                            &capture_id,
                            line_limit,
                            max_bytes,
                            sequence,
                            &mut journal,
                            &parser,
                            truncated_before_sequence,
                            started.elapsed(),
                        )
                    };
                    let _ = response.send(result);
                }
                OwnerCommand::Terminate {
                    operation_id,
                    payload_hash,
                    next_remote_resource_revision,
                    result_digest,
                    accepted,
                    response,
                } => {
                    if let Some(pending) = pending_termination.as_ref() {
                        let error = if pending.matches(
                            &operation_id,
                            &payload_hash,
                            &next_remote_resource_revision,
                            &result_digest,
                        ) {
                            KeeperRuntimeError::Retryable("session termination is in progress")
                        } else {
                            KeeperRuntimeError::Fenced(
                                "a different session termination is already in progress",
                            )
                        };
                        let _ = accepted.send(Err(error));
                        continue;
                    }
                    if pending_exit_code.is_some() {
                        let _ = accepted.send(Err(KeeperRuntimeError::Retryable(
                            "session exit is already being finalized",
                        )));
                        continue;
                    }
                    if !pending_side_effects.is_empty()
                        || !emergency.is_empty()
                        || journal.admission().storage_degraded
                    {
                        let _ = accepted.send(Err(KeeperRuntimeError::Retryable(
                            "terminal events or journal storage are not durable yet",
                        )));
                        continue;
                    }
                    if let Err(error) = refresh_live_descriptor(descriptor_path, &mut descriptor) {
                        let _ = accepted.send(Err(error));
                        continue;
                    }
                    if descriptor.state != SessionDescriptorState::Running {
                        let _ = accepted.send(Err(KeeperRuntimeError::Fenced(
                            "session is no longer running",
                        )));
                        continue;
                    }
                    match child.terminate_process_group(Signal::SIGTERM) {
                        Ok(()) | Err(PtyError::System(Errno::ESRCH)) => {}
                        Err(error) => {
                            let _ = accepted.send(Err(error.into()));
                            continue;
                        }
                    }
                    writer = None;
                    launch_input_fenced = true;
                    pending_termination = Some(PendingTermination {
                        operation_id,
                        payload_hash,
                        next_remote_resource_revision,
                        result_digest,
                        response: Some(response),
                        signal_deadline: Instant::now() + Duration::from_secs(2),
                        kill_sent: false,
                    });
                    // Publish acceptance only after the owner has fenced every
                    // later command and signalled the process group. Bridge
                    // callers retain only their bridge-private operation lock,
                    // never the descriptor lock needed for final replacement.
                    let _ = accepted.send(Ok(()));
                }
                OwnerCommand::Health { response } => {
                    let result = if pending_termination.is_some() {
                        Err(KeeperRuntimeError::Retryable(
                            "session termination is in progress",
                        ))
                    } else {
                        Ok(KeeperRpcResponse::Health {
                            outcome: "running".to_owned(),
                            storage: current_storage_status(
                                &journal,
                                &emergency,
                                &retention,
                                buffer.len(),
                            ),
                        })
                    };
                    let _ = response.send(result);
                }
            }
            if pending_side_effects.is_empty()
                && !drain_pending_side_effects(
                    &event_spool,
                    &mut pending_side_effects,
                    &mut side_effect_admission,
                    started.elapsed(),
                )?
            {
                break;
            }
        }

        if pending_exit_code.is_none()
            && let Some(status) = child.try_wait()?
        {
            pending_exit_code = Some(status.code());
        }
        if pending_exit_code.is_none()
            && let Some(pending) = pending_termination.as_mut()
            && Instant::now() >= pending.signal_deadline
        {
            if !pending.kill_sent {
                match child.terminate_process_group(Signal::SIGKILL) {
                    Ok(()) | Err(PtyError::System(Errno::ESRCH)) => {
                        pending.kill_sent = true;
                        pending.signal_deadline = Instant::now() + Duration::from_secs(2);
                    }
                    Err(_) => {
                        if let Some(response) = pending.response.take() {
                            let _ = response.send(Err(KeeperRuntimeError::OutcomeUnknown(
                                "keeper could not escalate session termination",
                            )));
                        }
                        pending.kill_sent = true;
                        pending.signal_deadline = Instant::now() + Duration::from_secs(60);
                    }
                }
            } else {
                if let Some(response) = pending.response.take() {
                    let _ = response.send(Err(KeeperRuntimeError::OutcomeUnknown(
                        "keeper child did not exit after termination",
                    )));
                }
                pending.signal_deadline = Instant::now() + Duration::from_secs(60);
            }
        }

        if !pending_side_effects.is_empty() {
            if let Err(error) = journal.sync_if_due(started.elapsed())
                && !is_storage_admission_error(&error)
            {
                return Err(error.into());
            }
            thread::sleep(Duration::from_millis(10));
            continue;
        }

        loop {
            if pty_eof {
                break;
            }
            let max_read = if retention.backpressured {
                0
            } else if emergency.is_empty() {
                if journal.admission().storage_degraded {
                    0
                } else {
                    buffer.len()
                }
            } else {
                emergency.max_safe_output_read(buffer.len())
            };
            if max_read == 0 {
                break;
            }
            match child.try_read_chunk(&mut buffer[..max_read])? {
                Some(0) => {
                    pty_eof = true;
                    break;
                }
                None => break,
                Some(bytes) => {
                    let output = output_normalizer.push(&buffer[..bytes]);
                    if !output.is_empty() {
                        commit_output(
                            output,
                            &mut sequence,
                            &mut journal,
                            &mut emergency,
                            &parser,
                            &mut retained,
                            &mut retained_bytes,
                            &mut truncated_before_sequence,
                            &mut subscribers,
                            &mut side_effect_scanner,
                            &mut pending_side_effects,
                            started.elapsed(),
                        )?;
                        if !drain_pending_side_effects(
                            &event_spool,
                            &mut pending_side_effects,
                            &mut side_effect_admission,
                            started.elapsed(),
                        )? {
                            break;
                        }
                    }
                }
            }
        }
        if let Err(error) = journal.sync_if_due(started.elapsed())
            && !is_storage_admission_error(&error)
        {
            return Err(error.into());
        }
        if let Some(exit_code) = pending_exit_code {
            if pty_eof
                && !pending_exit_output_flushed
                && emergency.available_bytes() >= EMERGENCY_OUTPUT_RESERVE_BYTES
            {
                let pending_output = output_normalizer.flush();
                if !pending_output.is_empty() {
                    commit_output(
                        pending_output,
                        &mut sequence,
                        &mut journal,
                        &mut emergency,
                        &parser,
                        &mut retained,
                        &mut retained_bytes,
                        &mut truncated_before_sequence,
                        &mut subscribers,
                        &mut side_effect_scanner,
                        &mut pending_side_effects,
                        started.elapsed(),
                    )?;
                }
                pending_exit_output_flushed = true;
            }
            if pending_exit_output_flushed
                && pending_exit_sequence.is_none()
                && emergency.available_bytes()
                    >= mutation_bytes(&TerminalMutation::Exit {
                        sequence: 0,
                        exit_code,
                    })
            {
                let next = emergency
                    .tail_sequence(sequence)
                    .checked_add(1)
                    .ok_or(KeeperRuntimeError::Invalid("mutation sequence exhausted"))?;
                commit_mutation(
                    TerminalMutation::Exit {
                        sequence: next,
                        exit_code,
                    },
                    &mut sequence,
                    &mut journal,
                    &mut emergency,
                    &parser,
                    &mut retained,
                    &mut retained_bytes,
                    &mut truncated_before_sequence,
                    &mut subscribers,
                    &mut side_effect_scanner,
                    &mut pending_side_effects,
                    started.elapsed(),
                )?;
                pending_exit_sequence = Some(next);
            }
            if let Some(exit_sequence) = pending_exit_sequence
                && emergency.is_empty()
                && sequence == exit_sequence
                && pending_side_effects.is_empty()
            {
                match journal.force_sync(started.elapsed()) {
                    Ok(admission) if admission.journal_synced >= exit_sequence => {
                        if pending_termination.is_none()
                            && let Err(_error) = maintain_retention(
                                &mut descriptor,
                                descriptor_path,
                                &mut journal,
                                &parser,
                                &mut retained,
                                &mut retained_bytes,
                                &mut truncated_before_sequence,
                                &mut retention,
                                true,
                                started.elapsed(),
                            )
                        {
                            // The fully synced journal remains authoritative if
                            // the final checkpoint cannot be materialized.
                            retention.cleanup_failed = true;
                        }
                        let _descriptor_lock = acquire_descriptor_lock(descriptor_path)?;
                        refresh_live_descriptor(descriptor_path, &mut descriptor)?;
                        if let Some(pending) = pending_termination.as_ref() {
                            descriptor.state = SessionDescriptorState::Terminated;
                            descriptor.remote_resource_revision =
                                pending.next_remote_resource_revision.clone();
                            descriptor.last_operation_id = pending.operation_id.clone();
                            descriptor.last_operation_payload_hash = pending.payload_hash.clone();
                            descriptor.last_result_digest = pending.result_digest.clone();
                            let unavailable_before =
                                exit_sequence
                                    .checked_add(1)
                                    .ok_or(KeeperRuntimeError::Invalid(
                                        "mutation sequence exhausted",
                                    ))?;
                            descriptor.retained_checkpoint = None;
                            descriptor.truncated_before_sequence =
                                Some(unavailable_before.to_string());
                        } else {
                            descriptor.state = SessionDescriptorState::Exited;
                            descriptor.truncated_before_sequence =
                                truncated_before_sequence.map(|sequence| sequence.to_string());
                        }
                        descriptor.exit_code = exit_code;
                        descriptor.storage_status =
                            current_storage_status(&journal, &emergency, &retention, buffer.len());
                        descriptor.updated_at = now_rfc3339();
                        write_session_descriptor(descriptor_path, &descriptor)?;
                        if pending_termination.is_some()
                            && cleanup_terminated_retained_data(&descriptor, descriptor_path)
                                .is_err()
                        {
                            // Termination identity is already durable and must
                            // not become ambiguous because eligible byte GC
                            // failed. Surface the cleanup failure and let the
                            // bounded target retention sweep retry it.
                            descriptor.storage_status.state = RemoteSessionStorageState::Degraded;
                            descriptor.updated_at = now_rfc3339();
                            let _ = write_session_descriptor(descriptor_path, &descriptor);
                        }
                        if let Some(mut pending) = pending_termination.take()
                            && let Some(response) = pending.response.take()
                        {
                            let _ = response.send(Ok(KeeperRpcResponse::Result {
                                outcome: "terminated".to_owned(),
                                written_offset: None,
                                exit_code,
                            }));
                        }
                        shutdown.store(true, Ordering::Release);
                        return Ok(());
                    }
                    Ok(_) => {}
                    Err(error) if is_storage_admission_error(&error) => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        thread::sleep(Duration::from_millis(1));
    }
}

#[allow(clippy::too_many_arguments)]
fn commit_output(
    data: Vec<u8>,
    sequence: &mut u64,
    journal: &mut MutationJournal<File>,
    emergency: &mut EmergencyMutationBuffer,
    parser: &ParserWorker,
    retained: &mut VecDeque<TerminalMutation>,
    retained_bytes: &mut usize,
    truncated_before_sequence: &mut Option<u64>,
    subscribers: &mut HashMap<String, Subscriber>,
    side_effect_scanner: &mut TerminalSideEffectScanner,
    pending_side_effects: &mut VecDeque<ParserSideEffect>,
    now: Duration,
) -> Result<MutationCommit, KeeperRuntimeError> {
    if data.is_empty() || std::str::from_utf8(&data).is_err() {
        return Err(KeeperRuntimeError::Invalid(
            "output mutation must contain valid non-empty UTF-8",
        ));
    }
    let next = emergency
        .tail_sequence(*sequence)
        .checked_add(1)
        .ok_or(KeeperRuntimeError::Invalid("mutation sequence exhausted"))?;
    let mutation = TerminalMutation::Output {
        sequence: next,
        data,
    };
    commit_mutation(
        mutation,
        sequence,
        journal,
        emergency,
        parser,
        retained,
        retained_bytes,
        truncated_before_sequence,
        subscribers,
        side_effect_scanner,
        pending_side_effects,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn commit_mutation(
    mutation: TerminalMutation,
    sequence: &mut u64,
    journal: &mut MutationJournal<File>,
    emergency: &mut EmergencyMutationBuffer,
    parser: &ParserWorker,
    retained: &mut VecDeque<TerminalMutation>,
    retained_bytes: &mut usize,
    truncated_before_sequence: &mut Option<u64>,
    subscribers: &mut HashMap<String, Subscriber>,
    side_effect_scanner: &mut TerminalSideEffectScanner,
    pending_side_effects: &mut VecDeque<ParserSideEffect>,
    now: Duration,
) -> Result<MutationCommit, KeeperRuntimeError> {
    let expected = emergency
        .tail_sequence(*sequence)
        .checked_add(1)
        .ok_or(KeeperRuntimeError::Invalid("mutation sequence exhausted"))?;
    if mutation.sequence() != expected {
        return Err(KeeperRuntimeError::Invalid(
            "mutation sequence is not contiguous",
        ));
    }
    if !emergency.is_empty() || journal.admission().storage_degraded {
        emergency.push(mutation)?;
        return Ok(MutationCommit::Buffered);
    }
    match journal.append(&mutation, now) {
        Ok(_) => {}
        Err(error) if is_storage_admission_error(&error) => {
            emergency.push(mutation)?;
            return Ok(MutationCommit::Buffered);
        }
        Err(error) => return Err(error.into()),
    }
    publish_admitted_mutation(
        mutation,
        sequence,
        parser,
        retained,
        retained_bytes,
        truncated_before_sequence,
        subscribers,
        side_effect_scanner,
        pending_side_effects,
    )?;
    Ok(MutationCommit::Admitted)
}

#[allow(clippy::too_many_arguments)]
fn publish_admitted_mutation(
    mutation: TerminalMutation,
    sequence: &mut u64,
    parser: &ParserWorker,
    retained: &mut VecDeque<TerminalMutation>,
    retained_bytes: &mut usize,
    truncated_before_sequence: &mut Option<u64>,
    subscribers: &mut HashMap<String, Subscriber>,
    side_effect_scanner: &mut TerminalSideEffectScanner,
    pending_side_effects: &mut VecDeque<ParserSideEffect>,
) -> Result<(), KeeperRuntimeError> {
    let effects = side_effect_scanner.scan(&mutation);
    if pending_side_effects
        .len()
        .checked_add(effects.len())
        .is_none_or(|length| length > MAX_PENDING_SIDE_EFFECTS)
    {
        return Err(KeeperRuntimeError::OutcomeUnknown(
            "terminal side-effect queue reached its hard limit",
        ));
    }
    *sequence = mutation.sequence();
    parser.try_submit(mutation.clone());
    let bytes = mutation_bytes(&mutation);
    while retained_bytes.saturating_add(bytes) > MAX_RETAINED_MUTATION_BYTES {
        let Some(removed) = retained.pop_front() else {
            break;
        };
        *retained_bytes = retained_bytes.saturating_sub(mutation_bytes(&removed));
        *truncated_before_sequence = Some(removed.sequence().saturating_add(1));
    }
    if bytes <= MAX_RETAINED_MUTATION_BYTES {
        *retained_bytes = retained_bytes.saturating_add(bytes);
        retained.push_back(mutation.clone());
    } else {
        *truncated_before_sequence = Some(mutation.sequence().saturating_add(1));
    }
    subscribers.retain(|_, subscriber| {
        match subscriber
            .outbound
            .try_send(OutboundMessage::Mutation(mutation.clone()))
        {
            Ok(()) => true,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                subscriber.closed.store(true, Ordering::Release);
                false
            }
        }
    });
    pending_side_effects.extend(effects);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn retry_emergency_mutations(
    sequence: &mut u64,
    journal: &mut MutationJournal<File>,
    emergency: &mut EmergencyMutationBuffer,
    parser: &ParserWorker,
    retained: &mut VecDeque<TerminalMutation>,
    retained_bytes: &mut usize,
    truncated_before_sequence: &mut Option<u64>,
    subscribers: &mut HashMap<String, Subscriber>,
    side_effect_scanner: &mut TerminalSideEffectScanner,
    pending_side_effects: &mut VecDeque<ParserSideEffect>,
    now: Duration,
) -> Result<(), KeeperRuntimeError> {
    if journal.admission().storage_degraded && journal.force_sync(now).is_err() {
        return Ok(());
    }
    while let Some(entry) = emergency.entries.front() {
        match journal.append(&entry.mutation, now) {
            Ok(_) => {}
            Err(error) if is_storage_admission_error(&error) => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        let mut entry = emergency.entries.pop_front().expect("front entry existed");
        emergency.bytes = emergency.bytes.saturating_sub(entry.bytes);
        publish_admitted_mutation(
            entry.mutation,
            sequence,
            parser,
            retained,
            retained_bytes,
            truncated_before_sequence,
            subscribers,
            side_effect_scanner,
            pending_side_effects,
        )?;
        if let Some(completion) = entry.completion.take() {
            match completion {
                BufferedMutationCompletion::Control { response, value } => {
                    let _ = response.send(Ok(value));
                }
            }
        }
        if journal.admission().storage_degraded {
            break;
        }
    }
    Ok(())
}

fn is_storage_admission_error(error: &JournalError) -> bool {
    matches!(
        error,
        JournalError::Storage(_)
            | JournalError::StorageUnavailable
            | JournalError::StorageRollback { .. }
    )
}

fn retained_file_len(path: &Path) -> Result<u64, KeeperRuntimeError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(KeeperRuntimeError::Invalid("retained file is unsafe"));
    }
    Ok(metadata.len())
}

fn require_private_owned_directory(path: &Path) -> Result<(), KeeperRuntimeError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(KeeperRuntimeError::Invalid(
            "retained data directory is unsafe",
        ));
    }
    Ok(())
}

fn remove_private_owned_file(path: &Path) -> Result<bool, KeeperRuntimeError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(KeeperRuntimeError::Invalid("retained file is unsafe"));
    }
    fs::remove_file(path)?;
    Ok(true)
}

fn cleanup_resource_journals(
    state_root: &Path,
    resource_key: &RemoteResourceKey,
) -> Result<(), KeeperRuntimeError> {
    let directory = state_root.join("journals");
    require_private_owned_directory(&directory)?;
    let prefix = format!("{}-", &resource_key_digest(resource_key)[..24]);
    let entries = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
    if entries.len() > MAX_RETENTION_SCAN_ENTRIES {
        return Err(KeeperRuntimeError::Invalid(
            "journal cleanup exceeds its hard entry bound",
        ));
    }
    let mut removed = false;
    for entry in entries {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !name.starts_with(&prefix) || !name.ends_with(".journal") {
            continue;
        }
        removed |= remove_private_owned_file(&entry.path())?;
    }
    if removed {
        File::open(directory)?.sync_all()?;
    }
    Ok(())
}

fn cleanup_checkpoint_resource_directory(directory: &Path) -> Result<(), KeeperRuntimeError> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(KeeperRuntimeError::Invalid(
            "checkpoint resource directory is unsafe",
        ));
    }
    let generations = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    let mut visited = generations.len();
    if visited > MAX_RETENTION_SCAN_ENTRIES {
        return Err(KeeperRuntimeError::Invalid(
            "checkpoint cleanup exceeds its hard entry bound",
        ));
    }
    for generation in generations {
        let generation_path = generation.path();
        require_private_owned_directory(&generation_path)?;
        let files = fs::read_dir(&generation_path)?.collect::<Result<Vec<_>, _>>()?;
        visited = visited
            .checked_add(files.len())
            .ok_or(KeeperRuntimeError::Invalid("checkpoint cleanup overflowed"))?;
        if visited > MAX_RETENTION_SCAN_ENTRIES {
            return Err(KeeperRuntimeError::Invalid(
                "checkpoint cleanup exceeds its hard entry bound",
            ));
        }
        for file in files {
            remove_private_owned_file(&file.path())?;
        }
        File::open(&generation_path)?.sync_all()?;
        fs::remove_dir(&generation_path)?;
    }
    File::open(directory)?.sync_all()?;
    let parent = directory.parent().ok_or(KeeperRuntimeError::Invalid(
        "checkpoint resource directory has no parent",
    ))?;
    fs::remove_dir(directory)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn cleanup_operation_input_records(descriptor_path: &Path) -> Result<(), KeeperRuntimeError> {
    let directory = operation_input_directory(descriptor_path)?;
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(KeeperRuntimeError::Invalid(
            "operation input directory is unsafe",
        ));
    }
    let records = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
    if records.len() > MAX_RETENTION_SCAN_ENTRIES {
        return Err(KeeperRuntimeError::Invalid(
            "operation input cleanup exceeds its hard entry bound",
        ));
    }
    for record in records {
        remove_private_owned_file(&record.path())?;
    }
    File::open(&directory)?.sync_all()?;
    fs::remove_dir(&directory)?;
    File::open(directory.parent().ok_or(KeeperRuntimeError::Invalid(
        "operation input directory has no parent",
    ))?)?
    .sync_all()?;
    Ok(())
}

pub fn cleanup_terminated_retained_data(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
) -> Result<(), KeeperRuntimeError> {
    if descriptor.state != SessionDescriptorState::Terminated
        || descriptor.retained_checkpoint.is_some()
        || descriptor.truncated_before_sequence.is_none()
    {
        return Err(KeeperRuntimeError::Invalid(
            "retained data is not eligible for terminated-session cleanup",
        ));
    }
    cleanup_finalized_retained_data(descriptor, descriptor_path)?;
    remove_retention_gc_intent(descriptor, descriptor_path)
}

fn cleanup_pruned_exited_retained_data(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
) -> Result<(), KeeperRuntimeError> {
    if descriptor.state != SessionDescriptorState::Exited
        || descriptor.retained_checkpoint.is_some()
        || descriptor.truncated_before_sequence.is_none()
    {
        return Err(KeeperRuntimeError::Invalid(
            "retained data is not eligible for exited-session cleanup",
        ));
    }
    cleanup_finalized_retained_data(descriptor, descriptor_path)
}

fn retained_data_cleanup_locations(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
) -> Result<(PathBuf, PathBuf), KeeperRuntimeError> {
    validate_retained_checkpoint_location(descriptor, descriptor_path)?;
    let sessions_directory = descriptor_path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("descriptor path has no parent"))?;
    let state_root = sessions_directory
        .parent()
        .ok_or(KeeperRuntimeError::Invalid(
            "descriptor path has no state root",
        ))?;
    let expected_journal = session_journal_path(
        state_root,
        &descriptor.resource_key,
        &descriptor.keeper_generation,
    );
    if Path::new(&descriptor.journal_path) != expected_journal {
        return Err(KeeperRuntimeError::Invalid(
            "finalized session journal path is outside its managed location",
        ));
    }
    Ok((
        state_root.to_path_buf(),
        retained_checkpoint_resource_directory(descriptor_path, descriptor)?,
    ))
}

fn retention_gc_intent_path(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
) -> Result<PathBuf, KeeperRuntimeError> {
    let sessions_directory = descriptor_path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("descriptor path has no parent"))?;
    let state_root = sessions_directory
        .parent()
        .ok_or(KeeperRuntimeError::Invalid(
            "descriptor path has no state root",
        ))?;
    let mut digest = Sha256::new();
    digest.update(resource_key_digest(&descriptor.resource_key));
    digest.update([0]);
    digest.update(descriptor.keeper_generation.as_bytes());
    Ok(state_root
        .join("retention-gc")
        .join(format!("{:x}.json", digest.finalize())))
}

fn write_retention_gc_intent(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
) -> Result<(), KeeperRuntimeError> {
    let path = retention_gc_intent_path(descriptor, descriptor_path)?;
    ensure_private_directory(
        path.parent()
            .ok_or(KeeperRuntimeError::Invalid("GC intent path has no parent"))?,
    )?;
    write_private_json_atomic(
        &path,
        &RetentionGcIntent {
            version: RETENTION_GC_INTENT_VERSION,
            resource_key: descriptor.resource_key.clone(),
            keeper_generation: descriptor.keeper_generation.clone(),
        },
    )
}

fn has_retention_gc_intent(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
) -> Result<bool, KeeperRuntimeError> {
    let path = retention_gc_intent_path(descriptor, descriptor_path)?;
    let parent = path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("GC intent path has no parent"))?;
    match fs::symlink_metadata(parent) {
        Ok(_) => require_private_owned_directory(parent)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    }
    match fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    }
    let intent: RetentionGcIntent = read_private_json(&path, MAX_DESCRIPTOR_BYTES)?;
    if intent.version != RETENTION_GC_INTENT_VERSION
        || intent.resource_key != descriptor.resource_key
        || intent.keeper_generation != descriptor.keeper_generation
    {
        return Err(KeeperRuntimeError::Invalid(
            "retention GC intent does not match its descriptor",
        ));
    }
    Ok(true)
}

fn remove_retention_gc_intent(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
) -> Result<(), KeeperRuntimeError> {
    let path = retention_gc_intent_path(descriptor, descriptor_path)?;
    let parent = path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("GC intent path has no parent"))?;
    match fs::symlink_metadata(parent) {
        Ok(_) => require_private_owned_directory(parent)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    if remove_private_owned_file(&path)? {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn cleanup_finalized_retained_data(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
) -> Result<(), KeeperRuntimeError> {
    let (state_root, checkpoint_resource_directory) =
        retained_data_cleanup_locations(descriptor, descriptor_path)?;
    cleanup_resource_journals(&state_root, &descriptor.resource_key)?;
    cleanup_checkpoint_resource_directory(&checkpoint_resource_directory)?;
    cleanup_operation_input_records(descriptor_path)?;
    Ok(())
}

fn bounded_directory_file_bytes(directory: &Path) -> Result<u64, KeeperRuntimeError> {
    if !directory.exists() {
        return Ok(0);
    }
    let metadata = fs::symlink_metadata(directory)?;
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(KeeperRuntimeError::Invalid(
            "retained checkpoint directory is unsafe",
        ));
    }
    let mut total = 0_u64;
    let mut count = 0_usize;
    for entry in fs::read_dir(directory)? {
        count = count
            .checked_add(1)
            .ok_or(KeeperRuntimeError::Invalid("retention scan overflowed"))?;
        if count > MAX_RETENTION_SCAN_ENTRIES {
            return Err(KeeperRuntimeError::Invalid(
                "retention scan exceeds its hard entry bound",
            ));
        }
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink()
            || (!metadata.file_type().is_file() && !metadata.file_type().is_dir())
            || metadata.uid() != effective_uid()
            || metadata.mode() & 0o077 != 0
        {
            return Err(KeeperRuntimeError::Invalid(
                "retained checkpoint entry is unsafe",
            ));
        }
        if metadata.file_type().is_file() {
            total = total
                .checked_add(metadata.len())
                .ok_or(KeeperRuntimeError::Invalid(
                    "retained byte count overflowed",
                ))?;
        }
    }
    Ok(total)
}

fn bounded_checkpoint_resource_bytes(directory: &Path) -> Result<u64, KeeperRuntimeError> {
    if !directory.exists() {
        return Ok(0);
    }
    require_private_owned_directory(directory)?;
    let generations = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    let mut visited = generations.len();
    if visited > MAX_RETENTION_SCAN_ENTRIES {
        return Err(KeeperRuntimeError::Invalid(
            "checkpoint resource scan exceeds its hard entry bound",
        ));
    }
    let mut total = 0_u64;
    for generation in generations {
        let generation_path = generation.path();
        require_private_owned_directory(&generation_path)?;
        let files = fs::read_dir(&generation_path)?.collect::<Result<Vec<_>, _>>()?;
        visited = visited
            .checked_add(files.len())
            .ok_or(KeeperRuntimeError::Invalid(
                "checkpoint resource scan overflowed",
            ))?;
        if visited > MAX_RETENTION_SCAN_ENTRIES {
            return Err(KeeperRuntimeError::Invalid(
                "checkpoint resource scan exceeds its hard entry bound",
            ));
        }
        for file in files {
            total = total.checked_add(retained_file_len(&file.path())?).ok_or(
                KeeperRuntimeError::Invalid("checkpoint resource byte count overflowed"),
            )?;
        }
    }
    Ok(total)
}

fn session_retained_bytes(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
    journal: &MutationJournal<File>,
) -> Result<u64, KeeperRuntimeError> {
    journal
        .storage_len()?
        .checked_add(bounded_directory_file_bytes(
            &retained_checkpoint_directory(descriptor_path, descriptor)?,
        )?)
        .ok_or(KeeperRuntimeError::Invalid(
            "session retained byte count overflowed",
        ))
}

fn target_retained_bytes(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
) -> Result<u64, KeeperRuntimeError> {
    let sessions_directory = descriptor_path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("descriptor path has no parent"))?;
    let entries = fs::read_dir(sessions_directory)?.collect::<Result<Vec<_>, _>>()?;
    if entries.len() > MAX_RETENTION_SCAN_ENTRIES {
        return Err(KeeperRuntimeError::Invalid(
            "target retention scan exceeds its hard entry bound",
        ));
    }
    let state_root = sessions_directory
        .parent()
        .ok_or(KeeperRuntimeError::Invalid(
            "descriptor path has no state root",
        ))?;
    let mut resource_digests = HashSet::new();
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let mut candidate = load_session_descriptor(&path)?;
        if candidate.resource_key.desktop_installation_id
            != descriptor.resource_key.desktop_installation_id
            || candidate.resource_key.target_id != descriptor.resource_key.target_id
        {
            continue;
        }
        let has_gc_intent = candidate.state == SessionDescriptorState::Exited
            && has_retention_gc_intent(&candidate, &path)?;
        let terminated_cleanup_is_due = candidate.state == SessionDescriptorState::Terminated
            && candidate.retained_checkpoint.is_none()
            && candidate.truncated_before_sequence.is_some();
        if (has_gc_intent || terminated_cleanup_is_due)
            && let Some(_lock) = try_acquire_descriptor_lock(&path)?
        {
            candidate = load_session_descriptor(&path)?;
            let has_gc_intent = candidate.state == SessionDescriptorState::Exited
                && has_retention_gc_intent(&candidate, &path)?;
            if has_gc_intent && candidate.retained_checkpoint.is_some() {
                retained_data_cleanup_locations(&candidate, &path)?;
                candidate.retained_checkpoint = None;
                candidate.storage_status.state = RemoteSessionStorageState::Degraded;
                candidate.updated_at = now_rfc3339();
                write_session_descriptor(&path, &candidate)?;
            }
            let cleanup_result = match candidate.state {
                SessionDescriptorState::Terminated
                    if candidate.retained_checkpoint.is_none()
                        && candidate.truncated_before_sequence.is_some() =>
                {
                    cleanup_terminated_retained_data(&candidate, &path)
                }
                SessionDescriptorState::Exited
                    if candidate.retained_checkpoint.is_none()
                        && candidate.truncated_before_sequence.is_some()
                        && has_gc_intent =>
                {
                    cleanup_pruned_exited_retained_data(&candidate, &path)
                }
                _ => continue,
            };
            if cleanup_result.is_ok()
                && candidate.retained_checkpoint.is_none()
                && candidate.storage_status.state != RemoteSessionStorageState::Normal
            {
                candidate.storage_status.state = RemoteSessionStorageState::Normal;
                candidate.updated_at = now_rfc3339();
                write_session_descriptor(&path, &candidate)?;
                remove_retention_gc_intent(&candidate, &path)?;
            }
        }
        resource_digests.insert(resource_key_digest(&candidate.resource_key));
    }

    let mut total = 0_u64;
    let journal_directory = state_root.join("journals");
    require_private_owned_directory(&journal_directory)?;
    let journal_entries = fs::read_dir(&journal_directory)?.collect::<Result<Vec<_>, _>>()?;
    if journal_entries.len() > MAX_RETENTION_SCAN_ENTRIES {
        return Err(KeeperRuntimeError::Invalid(
            "target journal scan exceeds its hard entry bound",
        ));
    }
    let journal_prefixes = resource_digests
        .iter()
        .map(|digest| format!("{}-", &digest[..24]))
        .collect::<Vec<_>>();
    for entry in journal_entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.ends_with(".journal")
            && journal_prefixes
                .iter()
                .any(|prefix| name.starts_with(prefix))
        {
            total = total.checked_add(retained_file_len(&entry.path())?).ok_or(
                KeeperRuntimeError::Invalid("target retained byte count overflowed"),
            )?;
        }
    }
    for digest in resource_digests {
        total = total
            .checked_add(bounded_checkpoint_resource_bytes(
                &state_root.join("checkpoints").join(digest),
            )?)
            .ok_or(KeeperRuntimeError::Invalid(
                "target retained byte count overflowed",
            ))?;
    }
    Ok(total)
}

fn prune_oldest_eligible_target_retention(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
    force_one: bool,
) -> Result<u64, KeeperRuntimeError> {
    let mut total = target_retained_bytes(descriptor, descriptor_path)?;
    let cleanup_start = quota_percent(
        descriptor.retention_policy.target_quota_bytes(),
        RETENTION_CLEANUP_START_PERCENT,
    );
    let cleanup_stop = quota_percent(
        descriptor.retention_policy.target_quota_bytes(),
        RETENTION_CLEANUP_STOP_PERCENT,
    );
    let quota_pressure = total >= cleanup_start;
    if !quota_pressure && !force_one {
        return Ok(total);
    }

    let sessions_directory = descriptor_path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("descriptor path has no parent"))?;
    let entries = fs::read_dir(sessions_directory)?.collect::<Result<Vec<_>, _>>()?;
    if entries.len() > MAX_RETENTION_SCAN_ENTRIES {
        return Err(KeeperRuntimeError::Invalid(
            "target retention cleanup exceeds its hard entry bound",
        ));
    }
    let mut candidates = Vec::new();
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json")
            || path == descriptor_path
        {
            continue;
        }
        let candidate = load_session_descriptor(&path)?;
        if candidate.resource_key.desktop_installation_id
            != descriptor.resource_key.desktop_installation_id
            || candidate.resource_key.target_id != descriptor.resource_key.target_id
            || candidate.state != SessionDescriptorState::Exited
        {
            continue;
        }
        let Some(checkpoint) = candidate.retained_checkpoint.as_ref() else {
            continue;
        };
        retained_data_cleanup_locations(&candidate, &path)?;
        candidates.push((checkpoint.created_at.clone(), path));
    }
    candidates.sort();

    let mut removed_one = false;
    for (_, path) in candidates {
        if (quota_pressure && total <= cleanup_stop) || (!quota_pressure && removed_one) {
            break;
        }
        let Some(_lock) = try_acquire_descriptor_lock(&path)? else {
            continue;
        };
        let mut candidate = load_session_descriptor(&path)?;
        if candidate.resource_key.desktop_installation_id
            != descriptor.resource_key.desktop_installation_id
            || candidate.resource_key.target_id != descriptor.resource_key.target_id
            || candidate.state != SessionDescriptorState::Exited
            || candidate.retained_checkpoint.is_none()
            || candidate.truncated_before_sequence.is_none()
        {
            continue;
        }
        retained_data_cleanup_locations(&candidate, &path)?;
        write_retention_gc_intent(&candidate, &path)?;
        candidate.retained_checkpoint = None;
        candidate.storage_status.state = RemoteSessionStorageState::Degraded;
        candidate.updated_at = now_rfc3339();
        write_session_descriptor(&path, &candidate)?;
        cleanup_pruned_exited_retained_data(&candidate, &path)?;
        candidate.storage_status.state = RemoteSessionStorageState::Normal;
        candidate.updated_at = now_rfc3339();
        write_session_descriptor(&path, &candidate)?;
        remove_retention_gc_intent(&candidate, &path)?;
        removed_one = true;
        drop(_lock);
        total = target_retained_bytes(descriptor, descriptor_path)?;
    }
    Ok(total)
}

fn load_retained_checkpoint(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
    record: &RetainedCheckpointRecord,
) -> Result<TerminalCheckpoint, KeeperRuntimeError> {
    validate_retained_checkpoint_location(descriptor, descriptor_path)?;
    let metadata: RetainedCheckpointRecord = read_private_json(
        &retained_checkpoint_metadata_path(descriptor_path, descriptor)?,
        MAX_DESCRIPTOR_BYTES,
    )?;
    if metadata != *record {
        return Err(KeeperRuntimeError::Invalid(
            "retained checkpoint metadata does not match the descriptor",
        ));
    }
    let restore_stream = read_private_checkpoint(Path::new(&record.checkpoint_path))?;
    if restore_stream.len() as u64 != record.byte_length
        || format!("{:x}", Sha256::digest(&restore_stream)) != record.sha256
    {
        return Err(KeeperRuntimeError::Invalid(
            "retained checkpoint bytes do not match their metadata",
        ));
    }
    let checkpoint = TerminalCheckpoint {
        format: record.format.clone(),
        parser_version: record.parser_version.clone(),
        last_mutation_sequence: parse_u64(&record.mutation_sequence)?,
        cols: record.cols,
        rows: record.rows,
        restore_stream,
        sha256: record.sha256.clone(),
    };
    HeadlessTerminalModel::from_checkpoint(&checkpoint)?;
    Ok(checkpoint)
}

fn cleanup_superseded_checkpoints(
    directory: &Path,
    current_path: &Path,
) -> Result<(), KeeperRuntimeError> {
    let mut removed = false;
    let entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    if entries.len() > MAX_RETENTION_SCAN_ENTRIES {
        return Err(KeeperRuntimeError::Invalid(
            "checkpoint cleanup exceeds its hard entry bound",
        ));
    }
    for entry in entries {
        let path = entry.path();
        if path == current_path
            || path.file_name().and_then(|name| name.to_str()) == Some("current.json")
        {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_file()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == effective_uid()
            && metadata.mode() & 0o077 == 0
        {
            fs::remove_file(path)?;
            removed = true;
        }
    }
    if removed {
        File::open(directory)?.sync_all()?;
    }
    Ok(())
}

fn compact_synced_journal(
    descriptor: &mut SessionDescriptor,
    descriptor_path: &Path,
    journal: &mut MutationJournal<File>,
    checkpoint: &TerminalCheckpoint,
    now: Duration,
) -> Result<(), KeeperRuntimeError> {
    let admission = journal.admission();
    if checkpoint.last_mutation_sequence != admission.journal_admitted
        || admission.journal_synced != admission.journal_admitted
        || journal.pending_bytes() != 0
    {
        return Err(KeeperRuntimeError::Retryable(
            "journal is not fully synced for checkpoint compaction",
        ));
    }
    HeadlessTerminalModel::from_checkpoint(checkpoint)?;
    ensure_private_directory(&retained_checkpoint_resource_directory(
        descriptor_path,
        descriptor,
    )?)?;
    ensure_private_directory(&retained_checkpoint_directory(descriptor_path, descriptor)?)?;
    let checkpoint_path =
        retained_checkpoint_path(descriptor_path, descriptor, &checkpoint.sha256)?;
    let record = RetainedCheckpointRecord {
        version: RETAINED_CHECKPOINT_VERSION,
        resource_key: descriptor.resource_key.clone(),
        keeper_generation: descriptor.keeper_generation.clone(),
        checkpoint_path: checkpoint_path.to_string_lossy().into_owned(),
        format: checkpoint.format.clone(),
        parser_version: checkpoint.parser_version.clone(),
        mutation_sequence: checkpoint.last_mutation_sequence.to_string(),
        cols: checkpoint.cols,
        rows: checkpoint.rows,
        byte_length: checkpoint.restore_stream.len() as u64,
        sha256: checkpoint.sha256.clone(),
        created_at: now_rfc3339(),
    };
    write_private_checkpoint_atomic(&checkpoint_path, &checkpoint.restore_stream)?;
    write_private_json_atomic(
        &retained_checkpoint_metadata_path(descriptor_path, descriptor)?,
        &record,
    )?;

    let Some(_descriptor_lock) = try_acquire_descriptor_lock(descriptor_path)? else {
        return Err(KeeperRuntimeError::Retryable(
            "descriptor operation is busy; checkpoint compaction was deferred",
        ));
    };
    refresh_live_descriptor(descriptor_path, descriptor)?;
    descriptor.retained_checkpoint = Some(record.clone());
    descriptor.truncated_before_sequence = Some(
        checkpoint
            .last_mutation_sequence
            .checked_add(1)
            .ok_or(KeeperRuntimeError::Invalid(
                "checkpoint sequence is exhausted",
            ))?
            .to_string(),
    );
    descriptor.updated_at = now_rfc3339();
    write_session_descriptor(descriptor_path, descriptor)?;
    load_retained_checkpoint(descriptor, descriptor_path, &record)?;

    let replacement = replace_journal_with_empty_file(Path::new(&descriptor.journal_path))?;
    journal.replace_with_compacted_storage(replacement, checkpoint.last_mutation_sequence, now)?;
    cleanup_superseded_checkpoints(
        checkpoint_path
            .parent()
            .ok_or(KeeperRuntimeError::Invalid("checkpoint path has no parent"))?,
        &checkpoint_path,
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn maintain_retention(
    descriptor: &mut SessionDescriptor,
    descriptor_path: &Path,
    journal: &mut MutationJournal<File>,
    parser: &ParserWorker,
    retained: &mut VecDeque<TerminalMutation>,
    retained_bytes: &mut usize,
    truncated_before_sequence: &mut Option<u64>,
    state: &mut RetentionQuotaState,
    force_storage_cleanup: bool,
    now: Duration,
) -> Result<(), KeeperRuntimeError> {
    let periodic = state.check_is_due(now);
    if !periodic && !force_storage_cleanup {
        return Ok(());
    }
    if periodic || force_storage_cleanup {
        state.last_checked_at = now;
        let session_bytes = session_retained_bytes(descriptor, descriptor_path, journal)?;
        let target_bytes = prune_oldest_eligible_target_retention(
            descriptor,
            descriptor_path,
            force_storage_cleanup,
        )?;
        state.observe_usage(session_bytes, target_bytes, descriptor.retention_policy);
    }
    if !state.pressure_active && !force_storage_cleanup {
        return Ok(());
    }

    let admission = journal.force_sync(now)?;
    if admission.journal_admitted == 0
        || admission.journal_synced != admission.journal_admitted
        || journal.storage_len()? == 0
        || state.last_compacted_sequence == admission.journal_synced
    {
        return Ok(());
    }
    let checkpoint = parser.checkpoint(admission.journal_synced)?;
    compact_synced_journal(descriptor, descriptor_path, journal, &checkpoint, now)?;
    state.last_compacted_sequence = checkpoint.last_mutation_sequence;
    state.cleanup_failed = false;

    while retained
        .front()
        .is_some_and(|mutation| mutation.sequence() <= checkpoint.last_mutation_sequence)
    {
        let removed = retained.pop_front().expect("front entry was checked");
        *retained_bytes = retained_bytes.saturating_sub(mutation_bytes(&removed));
    }
    let boundary =
        checkpoint
            .last_mutation_sequence
            .checked_add(1)
            .ok_or(KeeperRuntimeError::Invalid(
                "checkpoint sequence is exhausted",
            ))?;
    *truncated_before_sequence =
        Some((*truncated_before_sequence).map_or(boundary, |current| current.max(boundary)));

    if periodic || state.pressure_active {
        let session_bytes = session_retained_bytes(descriptor, descriptor_path, journal)?;
        let target_bytes =
            prune_oldest_eligible_target_retention(descriptor, descriptor_path, false)?;
        state.observe_usage(session_bytes, target_bytes, descriptor.retention_policy);
    }
    Ok(())
}

fn storage_write_backpressured(
    journal: &MutationJournal<File>,
    emergency: &EmergencyMutationBuffer,
    retention: &RetentionQuotaState,
) -> bool {
    retention.backpressured
        || (emergency.is_empty() && journal.admission().storage_degraded)
        || emergency.max_safe_output_read(1) == 0
}

fn current_storage_status(
    journal: &MutationJournal<File>,
    emergency: &EmergencyMutationBuffer,
    retention: &RetentionQuotaState,
    pty_read_chunk_bytes: usize,
) -> RemoteSessionStorageStatus {
    let admission = journal.admission();
    let state = if retention.backpressured {
        RemoteSessionStorageState::Backpressured
    } else if emergency.is_empty() && !admission.storage_degraded && !retention.cleanup_failed {
        RemoteSessionStorageState::Normal
    } else if (emergency.is_empty() && admission.storage_degraded)
        || emergency.max_safe_output_read(pty_read_chunk_bytes) == 0
    {
        RemoteSessionStorageState::Backpressured
    } else {
        RemoteSessionStorageState::Degraded
    };
    RemoteSessionStorageStatus {
        state,
        journal_admitted: admission.journal_admitted.to_string(),
        journal_synced: admission.journal_synced.to_string(),
        emergency_bytes: emergency.bytes,
        last_sync_duration_ms: journal
            .last_sync_duration()
            .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)),
    }
}

fn mutation_bytes(mutation: &TerminalMutation) -> usize {
    match mutation {
        TerminalMutation::Output { data, .. } => data.len().saturating_add(32),
        TerminalMutation::Resize { .. } | TerminalMutation::Exit { .. } => 32,
    }
}

fn attach_needs_checkpoint(last_received_sequence: Option<u64>, earliest: u64) -> bool {
    last_received_sequence.is_none_or(|cursor| cursor < earliest.saturating_sub(1))
}

fn validate_attachment_admission(
    subscribers: &HashMap<String, Subscriber>,
    attachment_id: &str,
) -> Result<(), KeeperRuntimeError> {
    if subscribers.contains_key(attachment_id) {
        return Err(KeeperRuntimeError::Fenced(
            "attachment identity is already active",
        ));
    }
    if subscribers.len() >= MAX_ATTACHMENTS_PER_KEEPER {
        return Err(KeeperRuntimeError::Invalid(
            "keeper attachment limit is full",
        ));
    }
    Ok(())
}

trait PtyInputWriter {
    fn write_input(&mut self, data: &[u8]) -> Result<usize, PtyError>;
}

impl PtyInputWriter for kmux_platform::PtyChild {
    fn write_input(&mut self, data: &[u8]) -> Result<usize, PtyError> {
        self.write(data)
    }
}

#[derive(Default)]
struct InputDeduplication {
    records: HashMap<(String, String, u64), InputRecord>,
    order: VecDeque<(String, String, u64)>,
    highest_applied: HashMap<(String, String), u64>,
}

impl InputDeduplication {
    fn clear(&mut self) {
        self.records.clear();
        self.order.clear();
        self.highest_applied.clear();
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_input<W: PtyInputWriter>(
    child: &mut W,
    writer: &Option<(String, String)>,
    writer_lease_id: &str,
    attachment_id: &str,
    input_sequence: u64,
    data: &[u8],
    deduplication: &mut InputDeduplication,
    input_epoch: &mut u64,
) -> Result<u64, KeeperRuntimeError> {
    require_writer(writer, writer_lease_id, attachment_id)?;
    if data.len() > kmux_compat::REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES {
        return Err(KeeperRuntimeError::Invalid("input exceeds 64 KiB"));
    }
    let key = (
        writer_lease_id.to_owned(),
        attachment_id.to_owned(),
        input_sequence,
    );
    let scope = (writer_lease_id.to_owned(), attachment_id.to_owned());
    let payload_hash: [u8; 32] = Sha256::digest(data).into();
    if let Some(record) = deduplication.records.get_mut(&key) {
        if record.payload_hash != payload_hash {
            return Err(KeeperRuntimeError::Fenced("input sequence payload changed"));
        }
        if record.completed {
            return Ok(deduplication
                .highest_applied
                .get(&scope)
                .copied()
                .unwrap_or(input_sequence));
        }
        if record.input_epoch != *input_epoch {
            return Err(KeeperRuntimeError::OutcomeUnknown(
                "input retry was fenced by a later accepted input",
            ));
        }
        write_pty_suffix(child, data, &mut record.written_offset)?;
        record.completed = true;
        deduplication.highest_applied.insert(scope, input_sequence);
        return Ok(input_sequence);
    }
    if deduplication
        .highest_applied
        .get(&scope)
        .is_some_and(|highest| input_sequence <= *highest)
    {
        return Err(KeeperRuntimeError::Fenced(
            "input sequence is no longer retryable",
        ));
    }
    if deduplication
        .records
        .iter()
        .any(|((lease, attachment, _), record)| {
            lease == writer_lease_id && attachment == attachment_id && !record.completed
        })
    {
        return Err(KeeperRuntimeError::Fenced(
            "an earlier input write has an unknown outcome",
        ));
    }
    if !deduplication.highest_applied.contains_key(&scope)
        && deduplication.highest_applied.len() >= MAX_INPUT_SCOPES
    {
        return Err(KeeperRuntimeError::Invalid(
            "input deduplication scope limit reached",
        ));
    }
    if deduplication.records.len() >= MAX_INPUT_RECORDS
        && let Some(oldest) = deduplication.order.pop_front()
    {
        deduplication.records.remove(&oldest);
    }
    let accepted_epoch = input_epoch
        .checked_add(1)
        .ok_or(KeeperRuntimeError::Invalid("input epoch exhausted"))?;
    *input_epoch = accepted_epoch;
    deduplication.order.push_back(key.clone());
    deduplication.records.insert(
        key.clone(),
        InputRecord {
            payload_hash,
            input_epoch: accepted_epoch,
            written_offset: 0,
            completed: false,
        },
    );
    let record = deduplication
        .records
        .get_mut(&key)
        .expect("record was inserted");
    write_pty_suffix(child, data, &mut record.written_offset)?;
    record.completed = true;
    deduplication.highest_applied.insert(scope, input_sequence);
    Ok(input_sequence)
}

fn require_writer(
    writer: &Option<(String, String)>,
    writer_lease_id: &str,
    attachment_id: &str,
) -> Result<(), KeeperRuntimeError> {
    if writer
        .as_ref()
        .is_none_or(|(lease, attachment)| lease != writer_lease_id || attachment != attachment_id)
    {
        return Err(KeeperRuntimeError::Fenced("writer lease is stale"));
    }
    Ok(())
}

fn write_pty_suffix<W: PtyInputWriter>(
    child: &mut W,
    data: &[u8],
    written_offset: &mut usize,
) -> Result<(), KeeperRuntimeError> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while *written_offset < data.len() {
        match child.write_input(&data[*written_offset..]) {
            Ok(0) => {
                return Err(KeeperRuntimeError::OutcomeUnknown(
                    "PTY accepted zero bytes",
                ));
            }
            Ok(bytes) => *written_offset = written_offset.saturating_add(bytes),
            Err(PtyError::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(KeeperRuntimeError::OutcomeUnknown("PTY write timed out"));
                }
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => return Err(KeeperRuntimeError::Pty(error)),
        }
    }
    Ok(())
}

fn apply_launch_input<W: PtyInputWriter>(
    child: &mut W,
    descriptor: &mut SessionDescriptor,
    descriptor_path: &Path,
    operation_id: &str,
    payload_hash: &str,
    data: &[u8],
    launch_input_fenced: bool,
) -> Result<KeeperRpcResponse, KeeperRuntimeError> {
    if !is_valid_id(operation_id)
        || !is_sha256(payload_hash)
        || data.len() > kmux_compat::REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES
        || format!("{:x}", Sha256::digest(data)) != payload_hash
    {
        return Err(KeeperRuntimeError::Invalid("launch-input is invalid"));
    }
    // Bridge operations are serialized by a bridge-only operation lock, but
    // callers never retain the shared descriptor lock while waiting on this
    // owner loop. The keeper therefore owns descriptor serialization for the
    // complete acceptance, PTY-write, and durable-completion transaction.
    let _descriptor_lock = acquire_descriptor_lock(descriptor_path)?;
    let in_memory_progress = descriptor.launch_input.clone();
    if let Some(record) = in_memory_progress.as_ref() {
        validate_launch_input_identity(record, operation_id, payload_hash, data.len())?;
        if record.outcome == LaunchInputOutcome::Written {
            return Ok(KeeperRpcResponse::Result {
                outcome: "written".to_owned(),
                written_offset: Some(record.written_offset),
                exit_code: None,
            });
        }
        if record.outcome == LaunchInputOutcome::Accepted {
            return Err(KeeperRuntimeError::OutcomeUnknown(
                "persisted launch-input acceptance may already have reached the PTY",
            ));
        }
    }
    refresh_live_descriptor(descriptor_path, descriptor)?;
    if let Some(in_memory) = in_memory_progress {
        validate_launch_input_identity(&in_memory, operation_id, payload_hash, data.len())?;
        match descriptor.launch_input.as_ref() {
            Some(durable) => {
                validate_launch_input_identity(durable, operation_id, payload_hash, data.len())?;
                if in_memory.written_offset > durable.written_offset
                    || (in_memory.written_offset == durable.written_offset
                        && launch_input_outcome_rank(&in_memory.outcome)
                            > launch_input_outcome_rank(&durable.outcome))
                {
                    descriptor.launch_input = Some(in_memory);
                }
            }
            None => descriptor.launch_input = Some(in_memory),
        }
    }
    if let Some(record) = descriptor.launch_input.as_mut() {
        validate_launch_input_identity(record, operation_id, payload_hash, data.len())?;
        if record.outcome == LaunchInputOutcome::Written {
            return Ok(KeeperRpcResponse::Result {
                outcome: "written".to_owned(),
                written_offset: Some(record.written_offset),
                exit_code: None,
            });
        }
    }
    if launch_input_fenced {
        return Err(KeeperRuntimeError::OutcomeUnknown(
            "launch-input was fenced by an interactive writer",
        ));
    }
    if descriptor.launch_input.is_none() {
        let mut accepted = descriptor.clone();
        accepted.launch_input = Some(LaunchInputRecord {
            operation_id: operation_id.to_owned(),
            payload_hash: payload_hash.to_owned(),
            byte_length: data.len(),
            written_offset: 0,
            outcome: LaunchInputOutcome::Accepted,
        });
        accepted.updated_at = now_rfc3339();
        write_session_descriptor(descriptor_path, &accepted)?;
        *descriptor = accepted;
    }
    let current_offset = descriptor
        .launch_input
        .as_ref()
        .expect("launch record exists")
        .written_offset;
    let mut offset = current_offset;
    let result = write_pty_suffix(child, data, &mut offset);
    let record = descriptor
        .launch_input
        .as_mut()
        .expect("launch record exists");
    record.written_offset = offset;
    record.outcome = if result.is_ok() {
        LaunchInputOutcome::Written
    } else {
        LaunchInputOutcome::OutcomeUnknown
    };
    descriptor.updated_at = now_rfc3339();
    write_session_descriptor(descriptor_path, descriptor)?;
    result?;
    Ok(KeeperRpcResponse::Result {
        outcome: "written".to_owned(),
        written_offset: Some(offset),
        exit_code: None,
    })
}

fn validate_launch_input_identity(
    record: &LaunchInputRecord,
    operation_id: &str,
    payload_hash: &str,
    byte_length: usize,
) -> Result<(), KeeperRuntimeError> {
    if record.operation_id != operation_id
        || record.payload_hash != payload_hash
        || record.byte_length != byte_length
    {
        return Err(KeeperRuntimeError::Fenced("launch-input identity changed"));
    }
    Ok(())
}

fn launch_input_outcome_rank(outcome: &LaunchInputOutcome) -> u8 {
    match outcome {
        LaunchInputOutcome::Accepted => 0,
        LaunchInputOutcome::OutcomeUnknown => 1,
        LaunchInputOutcome::Written => 2,
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_operation_input<W: PtyInputWriter>(
    child: &mut W,
    descriptor: &mut SessionDescriptor,
    descriptor_path: &Path,
    writer: &Option<(String, String)>,
    operation_id: &str,
    payload_hash: &str,
    data: &[u8],
    input_epoch: &mut u64,
    uncertain_records: &mut HashMap<String, OperationInputRecord>,
) -> Result<KeeperRpcResponse, KeeperRuntimeError> {
    if !is_valid_id(operation_id)
        || !is_sha256(payload_hash)
        || data.len() > kmux_compat::REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES
        || format!("{:x}", Sha256::digest(data)) != payload_hash
    {
        return Err(KeeperRuntimeError::Invalid("operation input is invalid"));
    }
    if let Some(record) = uncertain_records.get(operation_id).cloned() {
        validate_operation_input_identity(
            &record,
            descriptor,
            operation_id,
            payload_hash,
            data.len(),
        )?;
        if record.outcome == OperationInputOutcome::Written {
            return Ok(operation_input_ack(descriptor, &record));
        }
        validate_operation_input_lease(&record, writer, *input_epoch)?;
        return resume_uncertain_operation_input(
            child,
            descriptor,
            descriptor_path,
            data,
            uncertain_records,
            record,
        );
    }
    let operation_directory = operation_input_directory(descriptor_path)?;
    ensure_private_directory(&operation_directory)?;
    let record_path = operation_input_record_path(
        &operation_directory,
        &descriptor.keeper_generation,
        operation_id,
    );
    let mut record = match load_operation_input_record(&record_path)? {
        Some(record) => {
            validate_operation_input_identity(
                &record,
                descriptor,
                operation_id,
                payload_hash,
                data.len(),
            )?;
            if record.outcome == OperationInputOutcome::Written {
                return Ok(operation_input_ack(descriptor, &record));
            }
            if record.outcome == OperationInputOutcome::Accepted {
                return Err(KeeperRuntimeError::OutcomeUnknown(
                    "persisted operation input acceptance may already have reached the PTY",
                ));
            }
            validate_operation_input_lease(&record, writer, *input_epoch)?;
            record
        }
        None => {
            ensure_operation_input_capacity(&operation_directory, &descriptor.keeper_generation)?;
            let (writer_lease_id, temporary_lease) = writer
                .as_ref()
                .map(|(lease, _)| (lease.clone(), false))
                .unwrap_or_else(|| (format!("operation-lease_{}", Uuid::new_v4()), true));
            let accepted_epoch = input_epoch
                .checked_add(1)
                .ok_or(KeeperRuntimeError::Invalid("input epoch exhausted"))?;
            let record = OperationInputRecord {
                version: 1,
                keeper_generation: descriptor.keeper_generation.clone(),
                operation_id: operation_id.to_owned(),
                payload_hash: payload_hash.to_owned(),
                writer_lease_id,
                temporary_lease,
                input_epoch: accepted_epoch,
                byte_length: data.len(),
                written_offset: 0,
                outcome: OperationInputOutcome::Accepted,
            };
            validate_operation_input_record(&record)?;
            // Persist both the user-interaction safety bit and request
            // acceptance before touching the PTY. A crash can therefore never
            // make the provisional session reclaimable or make an accepted
            // request look new. Keeper RPC callers never retain the descriptor
            // lock while waiting on this single-threaded owner loop, so the
            // keeper takes ownership of the descriptor mutation here.
            if !descriptor.ever_granted_writer_lease {
                persist_first_writer_safety_bit(descriptor_path, descriptor)?;
            }
            write_private_json_atomic(&record_path, &record)?;
            *input_epoch = accepted_epoch;
            record
        }
    };

    let mut offset = record.written_offset;
    let result = write_pty_suffix(child, data, &mut offset);
    record.written_offset = offset;
    record.outcome = if result.is_ok() {
        OperationInputOutcome::Written
    } else {
        OperationInputOutcome::OutcomeUnknown
    };
    if write_private_json_atomic(&record_path, &record).is_err() {
        uncertain_records.insert(operation_id.to_owned(), record);
        return Err(KeeperRuntimeError::OutcomeUnknown(
            "operation input completion could not be durably recorded",
        ));
    }
    result?;
    Ok(operation_input_ack(descriptor, &record))
}

fn resume_uncertain_operation_input<W: PtyInputWriter>(
    child: &mut W,
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
    data: &[u8],
    uncertain_records: &mut HashMap<String, OperationInputRecord>,
    mut record: OperationInputRecord,
) -> Result<KeeperRpcResponse, KeeperRuntimeError> {
    let mut offset = record.written_offset;
    let result = write_pty_suffix(child, data, &mut offset);
    record.written_offset = offset;
    record.outcome = if result.is_ok() {
        OperationInputOutcome::Written
    } else {
        OperationInputOutcome::OutcomeUnknown
    };
    uncertain_records.insert(record.operation_id.clone(), record.clone());
    let operation_directory = operation_input_directory(descriptor_path)?;
    ensure_private_directory(&operation_directory)?;
    let record_path = operation_input_record_path(
        &operation_directory,
        &descriptor.keeper_generation,
        &record.operation_id,
    );
    if write_private_json_atomic(&record_path, &record).is_err() {
        return Err(KeeperRuntimeError::OutcomeUnknown(
            "operation input completion could not be durably recorded",
        ));
    }
    uncertain_records.remove(&record.operation_id);
    result?;
    Ok(operation_input_ack(descriptor, &record))
}

fn operation_input_ack(
    descriptor: &SessionDescriptor,
    record: &OperationInputRecord,
) -> KeeperRpcResponse {
    KeeperRpcResponse::InputAck {
        operation_id: record.operation_id.clone(),
        keeper_generation: descriptor.keeper_generation.clone(),
        writer_lease_id: record.writer_lease_id.clone(),
        byte_length: record.byte_length,
        boundary: "pty-write".to_owned(),
    }
}

fn validate_operation_input_identity(
    record: &OperationInputRecord,
    descriptor: &SessionDescriptor,
    operation_id: &str,
    payload_hash: &str,
    byte_length: usize,
) -> Result<(), KeeperRuntimeError> {
    validate_operation_input_record(record)?;
    if record.keeper_generation != descriptor.keeper_generation
        || record.operation_id != operation_id
        || record.payload_hash != payload_hash
        || record.byte_length != byte_length
    {
        return Err(KeeperRuntimeError::Fenced(
            "operation input identity changed",
        ));
    }
    Ok(())
}

fn validate_operation_input_lease(
    record: &OperationInputRecord,
    writer: &Option<(String, String)>,
    input_epoch: u64,
) -> Result<(), KeeperRuntimeError> {
    if record.temporary_lease {
        // There is no durable writer-lease epoch to prove that a no-writer
        // one-shot request has not been interleaved with a writer that attached
        // and detached after the ambiguous write. Never reissue it.
        return Err(KeeperRuntimeError::OutcomeUnknown(
            "accepted temporary-lease input cannot be retried safely",
        ));
    }
    let lease_is_current = writer
        .as_ref()
        .is_some_and(|(lease, _)| lease == &record.writer_lease_id);
    if !lease_is_current {
        return Err(KeeperRuntimeError::OutcomeUnknown(
            "accepted operation input was fenced by a writer lease change",
        ));
    }
    if record.input_epoch != input_epoch {
        return Err(KeeperRuntimeError::OutcomeUnknown(
            "accepted operation input was fenced by a later input",
        ));
    }
    Ok(())
}

fn validate_operation_input_record(
    record: &OperationInputRecord,
) -> Result<(), KeeperRuntimeError> {
    let offset_is_invalid = match record.outcome {
        OperationInputOutcome::Accepted => record.written_offset != 0,
        OperationInputOutcome::Written => record.written_offset != record.byte_length,
        OperationInputOutcome::OutcomeUnknown => record.written_offset > record.byte_length,
    };
    if record.version != 1
        || !is_valid_id(&record.keeper_generation)
        || !is_valid_id(&record.operation_id)
        || !is_sha256(&record.payload_hash)
        || !is_valid_id(&record.writer_lease_id)
        || record.input_epoch == 0
        || record.byte_length > kmux_compat::REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES
        || offset_is_invalid
    {
        return Err(KeeperRuntimeError::Invalid(
            "operation input record is invalid",
        ));
    }
    Ok(())
}

fn operation_input_directory(descriptor_path: &Path) -> Result<PathBuf, KeeperRuntimeError> {
    let parent = descriptor_path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("descriptor path has no parent"))?;
    let file_name = descriptor_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(KeeperRuntimeError::Invalid(
            "descriptor file name is invalid",
        ))?;
    Ok(parent.join(format!("{file_name}.input-ops")))
}

fn operation_input_record_path(
    directory: &Path,
    keeper_generation: &str,
    operation_id: &str,
) -> PathBuf {
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("{keeper_generation}\0{operation_id}").as_bytes())
    );
    directory.join(format!("{digest}.json"))
}

fn load_operation_input_record(
    path: &Path,
) -> Result<Option<OperationInputRecord>, KeeperRuntimeError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > MAX_OPERATION_INPUT_RECORD_BYTES
    {
        return Err(KeeperRuntimeError::Invalid(
            "operation input record is unsafe",
        ));
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_OPERATION_INPUT_RECORD_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_OPERATION_INPUT_RECORD_BYTES {
        return Err(KeeperRuntimeError::Invalid(
            "operation input record is oversized",
        ));
    }
    let record = serde_json::from_slice(&bytes)?;
    validate_operation_input_record(&record)?;
    Ok(Some(record))
}

fn ensure_operation_input_capacity(
    directory: &Path,
    keeper_generation: &str,
) -> Result<(), KeeperRuntimeError> {
    ensure_operation_input_capacity_with_limit(
        directory,
        keeper_generation,
        MAX_OPERATION_INPUT_RECORDS,
    )
}

fn ensure_operation_input_capacity_with_limit(
    directory: &Path,
    keeper_generation: &str,
    limit: usize,
) -> Result<(), KeeperRuntimeError> {
    if limit == 0 || !is_valid_id(keeper_generation) {
        return Err(KeeperRuntimeError::Invalid(
            "operation input capacity scope is invalid",
        ));
    }
    let mut total = 0_usize;
    let mut stale = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let record = load_operation_input_record(&entry.path())?.ok_or(
            KeeperRuntimeError::Invalid("operation input record disappeared"),
        )?;
        if record.keeper_generation == keeper_generation {
            total = total.checked_add(1).ok_or(KeeperRuntimeError::Invalid(
                "operation input record count overflowed",
            ))?;
        } else {
            stale.push(entry.path());
        }
    }
    for path in &stale {
        fs::remove_file(path)?;
    }
    if !stale.is_empty() {
        File::open(directory)?.sync_all()?;
    }
    if total >= limit {
        return Err(KeeperRuntimeError::OutcomeUnknown(
            "operation input deduplication limit is full for this keeper generation",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn capture_surface(
    descriptor: &SessionDescriptor,
    capture_id: &str,
    line_limit: usize,
    max_bytes: usize,
    sequence: u64,
    journal: &mut MutationJournal<File>,
    parser: &ParserWorker,
    truncated_before_sequence: Option<u64>,
    now: Duration,
) -> Result<KeeperCaptureSnapshot, KeeperRuntimeError> {
    if !is_valid_id(capture_id)
        || line_limit == 0
        || line_limit > MAX_SURFACE_CAPTURE_LINES
        || max_bytes == 0
        || max_bytes > MAX_SURFACE_CAPTURE_BYTES
    {
        return Err(KeeperRuntimeError::Invalid("surface capture is invalid"));
    }
    let admission = journal.force_sync(now)?;
    let checkpoint = parser.checkpoint(admission.journal_synced)?;
    if checkpoint.last_mutation_sequence != sequence {
        return Err(KeeperRuntimeError::OutcomeUnknown(
            "surface capture parser is behind the keeper",
        ));
    }
    let model = HeadlessTerminalModel::from_checkpoint(&checkpoint)?;
    let all_text = model.plain_text();
    let all_lines = all_text.split('\n').collect::<Vec<_>>();
    let lines_truncated = all_lines.len() > line_limit;
    let retained_lines = if lines_truncated {
        &all_lines[all_lines.len() - line_limit..]
    } else {
        &all_lines[..]
    };
    let line_bounded = retained_lines.join("\n");
    let (text, bytes_truncated) = truncate_utf8_tail(&line_bounded, max_bytes);
    let line_count = if text.is_empty() {
        0
    } else {
        text.split('\n').count()
    };
    let sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
    Ok(KeeperCaptureSnapshot {
        result: KeeperCaptureResult {
            capture_id: capture_id.to_owned(),
            resource_key: descriptor.resource_key.clone(),
            keeper_generation: descriptor.keeper_generation.clone(),
            mutation_sequence: checkpoint.last_mutation_sequence,
            cols: checkpoint.cols,
            rows: checkpoint.rows,
            text,
            line_count,
            lines_truncated,
            bytes_truncated,
            retained_range_truncated: truncated_before_sequence.is_some(),
        },
        sha256,
    })
}

fn truncate_utf8_tail(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_owned(), false);
    }
    let mut start = value.len().saturating_sub(max_bytes);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    (value[start..].to_owned(), true)
}

fn accept_connections(
    listener: UnixListener,
    commands: Sender<OwnerCommand>,
    descriptor: SessionDescriptor,
    descriptor_path: PathBuf,
    shutdown: Arc<AtomicBool>,
) {
    while !shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let worker_commands = commands.clone();
                let worker_descriptor = descriptor.clone();
                let worker_descriptor_path = descriptor_path.clone();
                let worker_shutdown = Arc::clone(&shutdown);
                thread::spawn(move || {
                    let _ = handle_connection(
                        stream,
                        worker_commands,
                        worker_descriptor,
                        worker_descriptor_path,
                        worker_shutdown,
                    );
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }
    drop(commands);
}

fn handle_connection(
    mut stream: UnixStream,
    commands: Sender<OwnerCommand>,
    descriptor: SessionDescriptor,
    _descriptor_path: PathBuf,
    shutdown: Arc<AtomicBool>,
) -> Result<(), KeeperRuntimeError> {
    // macOS may preserve O_NONBLOCK from the nonblocking listener on an
    // accepted Unix stream. Keeper workers use bounded blocking I/O; make the
    // contract explicit before applying their initial handshake deadlines.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let request: KeeperSocketRequest = read_control(&mut stream)?
        .ok_or(KeeperRuntimeError::Invalid("keeper request is missing"))?;
    match request {
        KeeperSocketRequest::Attach {
            protocol_version,
            roots,
            resource_key,
            keeper_generation,
            attach_capability,
            attachment_id,
            access,
            last_received_sequence,
        } => handle_attachment(
            stream,
            commands,
            &descriptor,
            KeeperAttachRequest {
                message_type: "keeper.attach".to_owned(),
                protocol_version,
                roots,
                resource_key,
                keeper_generation,
                attach_capability,
                attachment_id,
                access,
                last_received_sequence,
            },
            shutdown,
        ),
        KeeperSocketRequest::LaunchInput {
            keeper_generation,
            operation_id,
            payload_hash,
            input,
        } => {
            if keeper_generation != descriptor.keeper_generation {
                return write_rpc_error(&mut stream, "generation-mismatch", false);
            }
            let (response, receiver) = bounded(1);
            commands
                .send(OwnerCommand::LaunchInput {
                    operation_id,
                    payload_hash,
                    data: input.into_bytes(),
                    response,
                })
                .map_err(|_| KeeperRuntimeError::OutcomeUnknown("keeper owner stopped"))?;
            write_rpc_result(&mut stream, receiver.recv())
        }
        KeeperSocketRequest::OperationInput {
            resource_key,
            keeper_generation,
            operation_id,
            payload_hash,
            input,
        } => {
            if resource_key != descriptor.resource_key {
                return write_rpc_error(&mut stream, "resource-mismatch", false);
            }
            if keeper_generation != descriptor.keeper_generation {
                return write_rpc_error(&mut stream, "generation-mismatch", false);
            }
            let (response, receiver) = bounded(1);
            commands
                .send(OwnerCommand::OperationInput {
                    operation_id,
                    payload_hash,
                    data: input.into_bytes(),
                    response,
                })
                .map_err(|_| KeeperRuntimeError::OutcomeUnknown("keeper owner stopped"))?;
            write_rpc_result(&mut stream, receiver.recv())
        }
        KeeperSocketRequest::Capture {
            resource_key,
            keeper_generation,
            capture_id,
            line_limit,
            max_bytes,
        } => {
            if resource_key != descriptor.resource_key {
                return write_rpc_error(&mut stream, "resource-mismatch", false);
            }
            if keeper_generation != descriptor.keeper_generation {
                return write_rpc_error(&mut stream, "generation-mismatch", false);
            }
            let (response, receiver) = bounded(1);
            commands
                .send(OwnerCommand::Capture {
                    capture_id,
                    line_limit,
                    max_bytes,
                    response,
                })
                .map_err(|_| KeeperRuntimeError::OutcomeUnknown("keeper owner stopped"))?;
            match receiver.recv() {
                Ok(Ok(snapshot)) => write_capture_result(&mut stream, snapshot),
                Ok(Err(error)) => write_runtime_error(&mut stream, error),
                Err(_) => write_rpc_error(&mut stream, "keeper-owner-stopped", true),
            }
        }
        KeeperSocketRequest::Terminate {
            keeper_generation,
            operation_id,
            payload_hash,
            next_remote_resource_revision,
            result_digest,
        } => {
            if keeper_generation != descriptor.keeper_generation {
                return write_rpc_error(&mut stream, "generation-mismatch", false);
            }
            let (accepted, accepted_receiver) = bounded(1);
            let (response, receiver) = bounded(1);
            commands
                .send(OwnerCommand::Terminate {
                    operation_id,
                    payload_hash,
                    next_remote_resource_revision,
                    result_digest,
                    accepted,
                    response,
                })
                .map_err(|_| KeeperRuntimeError::OutcomeUnknown("keeper owner stopped"))?;
            match accepted_receiver.recv() {
                Ok(Ok(())) => {
                    write_control(
                        &mut stream,
                        &KeeperRpcResponse::Result {
                            outcome: "termination-accepted".to_owned(),
                            written_offset: None,
                            exit_code: None,
                        },
                    )?;
                    write_rpc_result(&mut stream, receiver.recv())
                }
                Ok(Err(error)) => write_runtime_error(&mut stream, error),
                Err(_) => write_rpc_error(&mut stream, "keeper-owner-stopped", true),
            }
        }
        KeeperSocketRequest::Health { keeper_generation } => {
            if keeper_generation != descriptor.keeper_generation {
                return write_rpc_error(&mut stream, "generation-mismatch", false);
            }
            let (response, receiver) = bounded(1);
            commands
                .send(OwnerCommand::Health { response })
                .map_err(|_| KeeperRuntimeError::OutcomeUnknown("keeper owner stopped"))?;
            write_rpc_result(&mut stream, receiver.recv())
        }
    }
}

fn write_capture_result(
    writer: &mut impl Write,
    snapshot: KeeperCaptureSnapshot,
) -> Result<(), KeeperRuntimeError> {
    let chunks = utf8_chunks(&snapshot.result.text, SURFACE_CAPTURE_CHUNK_BYTES);
    for (index, text) in chunks.iter().enumerate() {
        write_control(
            writer,
            &KeeperRpcResponse::CaptureChunk {
                capture_id: snapshot.result.capture_id.clone(),
                index,
                text: (*text).to_owned(),
            },
        )?;
    }
    write_control(
        writer,
        &KeeperRpcResponse::CaptureCompleted {
            capture_id: snapshot.result.capture_id,
            resource_key: snapshot.result.resource_key,
            keeper_generation: snapshot.result.keeper_generation,
            mutation_sequence: snapshot.result.mutation_sequence.to_string(),
            cols: snapshot.result.cols,
            rows: snapshot.result.rows,
            line_count: snapshot.result.line_count,
            byte_length: snapshot.result.text.len(),
            chunk_count: chunks.len(),
            sha256: snapshot.sha256,
            lines_truncated: snapshot.result.lines_truncated,
            bytes_truncated: snapshot.result.bytes_truncated,
            retained_range_truncated: snapshot.result.retained_range_truncated,
        },
    )?;
    Ok(())
}

fn utf8_chunks(value: &str, max_bytes: usize) -> Vec<&str> {
    if value.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let mut end = start.saturating_add(max_bytes).min(value.len());
        while end > start && !value.is_char_boundary(end) {
            end -= 1;
        }
        debug_assert!(end > start);
        chunks.push(&value[start..end]);
        start = end;
    }
    chunks
}

fn handle_attachment(
    mut stream: UnixStream,
    commands: Sender<OwnerCommand>,
    descriptor: &SessionDescriptor,
    request: KeeperAttachRequest,
    shutdown: Arc<AtomicBool>,
) -> Result<(), KeeperRuntimeError> {
    if request.message_type != "keeper.attach"
        || request.protocol_version != REMOTE_PROTOCOL_VERSION
        || request.resource_key != descriptor.resource_key
        || request.keeper_generation != descriptor.keeper_generation
        || request.resource_key.session_id.is_none()
    {
        return Err(KeeperRuntimeError::Fenced("attachment scope is invalid"));
    }
    consume_attach_capability(&request)?;
    // The initial request is deadline-bound, but a healthy interactive
    // attachment may be idle indefinitely.
    stream.set_read_timeout(None)?;
    let last_received_sequence = request
        .last_received_sequence
        .as_deref()
        .map(parse_u64)
        .transpose()?;
    let (outbound, outbound_receiver) = bounded(OUTBOUND_QUEUE_CAPACITY);
    let attachment_closed = Arc::new(AtomicBool::new(false));
    let (response, response_receiver) = bounded(1);
    commands
        .send(OwnerCommand::Attach {
            attachment_id: request.attachment_id.clone(),
            access: request.access,
            last_received_sequence,
            outbound: outbound.clone(),
            closed: Arc::clone(&attachment_closed),
            response,
        })
        .map_err(|_| KeeperRuntimeError::OutcomeUnknown("keeper owner stopped"))?;
    let snapshot = response_receiver
        .recv()
        .map_err(|_| KeeperRuntimeError::OutcomeUnknown("attach response was lost"))??;
    let mut registration = AttachmentRegistration::new(
        commands.clone(),
        request.attachment_id.clone(),
        Arc::clone(&attachment_closed),
    );
    let ready = KeeperControlMessage::AttachReady {
        keeper_generation: descriptor.keeper_generation.clone(),
        attachment_id: request.attachment_id.clone(),
        writer_lease_id: snapshot.writer_lease_id,
        checkpoint_available: snapshot.checkpoint.is_some(),
        cols: snapshot.cols,
        rows: snapshot.rows,
        earliest_available_sequence: snapshot.earliest_available_sequence.to_string(),
        replay_from_sequence: snapshot.replay_from_sequence.to_string(),
        live_starts_after_sequence: snapshot.live_starts_after_sequence.to_string(),
        truncated_before_sequence: snapshot
            .truncated_before_sequence
            .map(|value| value.to_string()),
    };
    write_control(&mut stream, &ready)?;
    if let Some(checkpoint) = snapshot.checkpoint {
        let checkpoint_id = format!("checkpoint_{}", Uuid::new_v4());
        write_control(
            &mut stream,
            &KeeperControlMessage::CheckpointBegin {
                checkpoint_id: checkpoint_id.clone(),
                format: checkpoint.format,
                parser_version: checkpoint.parser_version,
                last_mutation_sequence: checkpoint.last_mutation_sequence.to_string(),
                cols: checkpoint.cols,
                rows: checkpoint.rows,
                byte_length: checkpoint.restore_stream.len().to_string(),
            },
        )?;
        for (index, chunk) in checkpoint
            .restore_stream
            .chunks(REMOTE_CHECKPOINT_CHUNK_HARD_MAX_BYTES.saturating_sub(8))
            .enumerate()
        {
            let offset = index
                .checked_mul(REMOTE_CHECKPOINT_CHUNK_HARD_MAX_BYTES.saturating_sub(8))
                .ok_or(KeeperRuntimeError::Invalid("checkpoint offset overflow"))?;
            let mut payload = Vec::with_capacity(chunk.len() + 8);
            payload.extend_from_slice(&(offset as u64).to_be_bytes());
            payload.extend_from_slice(chunk);
            write_remote_frame(&mut stream, RemoteFrameKind::Checkpoint, &payload)?;
        }
        write_control(
            &mut stream,
            &KeeperControlMessage::CheckpointEnd {
                checkpoint_id,
                sha256: checkpoint.sha256,
            },
        )?;
    }
    for mutation in snapshot.replay {
        write_mutation(&mut stream, &mutation)?;
    }

    let mut writer = stream.try_clone()?;
    let writer_thread = thread::spawn(move || {
        loop {
            if attachment_closed.load(Ordering::Acquire) || shutdown.load(Ordering::Acquire) {
                break;
            }
            let message = match outbound_receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(message) => message,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            let result = match message {
                OutboundMessage::Control(control) => write_control(&mut writer, &control),
                OutboundMessage::Mutation(mutation) => write_mutation(&mut writer, &mutation),
            };
            if result.is_err() {
                break;
            }
        }
        let _ = writer.shutdown(Shutdown::Both);
    });

    loop {
        let frame = match read_remote_frame(&mut stream) {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(RemoteWireError::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionReset
                        | io::ErrorKind::BrokenPipe
                        | io::ErrorKind::UnexpectedEof
                ) =>
            {
                break;
            }
            Err(error) => return Err(error.into()),
        };
        if frame.kind != RemoteFrameKind::Terminal {
            outbound
                .send(OutboundMessage::Control(terminal_error(
                    "protocol-error",
                    "attachment accepts only terminal frames after attach",
                    false,
                )))
                .ok();
            break;
        }
        match decode_terminal_message(&frame.payload)? {
            RemoteTerminalWireMessage::Input {
                writer_lease_id,
                attachment_id,
                input_sequence,
                data,
            } => {
                let (response, receiver) = bounded(1);
                commands
                    .send(OwnerCommand::Input {
                        writer_lease_id,
                        attachment_id,
                        input_sequence,
                        data,
                        response,
                    })
                    .map_err(|_| KeeperRuntimeError::OutcomeUnknown("keeper owner stopped"))?;
                enqueue_control_result(&outbound, receiver.recv());
            }
            RemoteTerminalWireMessage::ResizeRequest {
                writer_lease_id,
                attachment_id,
                cols,
                rows,
            } => {
                let (response, receiver) = bounded(1);
                commands
                    .send(OwnerCommand::Resize {
                        writer_lease_id,
                        attachment_id,
                        cols,
                        rows,
                        response,
                    })
                    .map_err(|_| KeeperRuntimeError::OutcomeUnknown("keeper owner stopped"))?;
                enqueue_control_result(&outbound, receiver.recv());
            }
            RemoteTerminalWireMessage::Output { .. }
            | RemoteTerminalWireMessage::Resize { .. }
            | RemoteTerminalWireMessage::Exit { .. } => {
                outbound
                    .send(OutboundMessage::Control(terminal_error(
                        "protocol-error",
                        "client cannot send terminal mutations",
                        false,
                    )))
                    .ok();
                break;
            }
        }
    }
    registration.detach();
    drop(outbound);
    let _ = writer_thread.join();
    Ok(())
}

fn enqueue_control_result(
    outbound: &Sender<OutboundMessage>,
    result: Result<Result<KeeperControlMessage, KeeperRuntimeError>, crossbeam_channel::RecvError>,
) {
    let control = match result {
        Ok(Ok(control)) => control,
        Ok(Err(KeeperRuntimeError::Fenced(message))) => {
            terminal_error("writer-fenced", message, false)
        }
        Ok(Err(KeeperRuntimeError::OutcomeUnknown(message))) => {
            terminal_error("outcome-unknown", message, false)
        }
        Ok(Err(KeeperRuntimeError::Retryable(message))) => {
            terminal_error("temporarily-unavailable", message, true)
        }
        Ok(Err(error)) => terminal_error("terminal-failed", &error.to_string(), false),
        Err(_) => terminal_error("owner-unavailable", "keeper owner stopped", true),
    };
    let _ = outbound.send(OutboundMessage::Control(control));
}

fn terminal_error(code: &str, message: &str, retryable: bool) -> KeeperControlMessage {
    KeeperControlMessage::TerminalError {
        code: code.to_owned(),
        message: message.to_owned(),
        retryable,
    }
}

fn write_mutation(
    stream: &mut UnixStream,
    mutation: &TerminalMutation,
) -> Result<(), RemoteWireError> {
    let message = match mutation {
        TerminalMutation::Output { sequence, data } => RemoteTerminalWireMessage::Output {
            sequence: *sequence,
            data: data.clone(),
        },
        TerminalMutation::Resize {
            sequence,
            cols,
            rows,
        } => RemoteTerminalWireMessage::Resize {
            sequence: *sequence,
            cols: *cols,
            rows: *rows,
        },
        TerminalMutation::Exit {
            sequence,
            exit_code,
        } => RemoteTerminalWireMessage::Exit {
            sequence: *sequence,
            exit_code: *exit_code,
        },
    };
    let payload = encode_terminal_message(&message)?;
    write_remote_frame(stream, RemoteFrameKind::Terminal, &payload)
}

fn consume_attach_capability(request: &KeeperAttachRequest) -> Result<(), KeeperRuntimeError> {
    let source = attach_capability_path(&request.roots, &request.attach_capability);
    let consumed = source.with_extension(format!("redeeming-{}", Uuid::new_v4()));
    fs::rename(&source, &consumed)?;
    sync_parent_directory(&consumed)?;
    let record = read_private_json(&consumed, 64 * 1024);
    let removal = fs::remove_file(&consumed);
    sync_parent_directory(&consumed)?;
    removal?;
    let record: AttachCapabilityRecord = record?;
    if record.resource_key != request.resource_key
        || record.keeper_generation != request.keeper_generation
        || record.access != request.access
        || record.expires_at_unix_ms < unix_millis()
    {
        return Err(KeeperRuntimeError::Fenced("attach capability is invalid"));
    }
    Ok(())
}

fn attach_capability_path(roots: &RemoteRuntimeRoots, capability: &str) -> PathBuf {
    let digest = format!("{:x}", Sha256::digest(capability.as_bytes()));
    Path::new(&roots.runtime_root)
        .join("attach-caps")
        .join(format!("{digest}.json"))
}

fn write_rpc_result(
    stream: &mut UnixStream,
    result: Result<Result<KeeperRpcResponse, KeeperRuntimeError>, crossbeam_channel::RecvError>,
) -> Result<(), KeeperRuntimeError> {
    let response = match result {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return write_runtime_error(stream, error),
        Err(_) => KeeperRpcResponse::Error {
            code: "keeper-unavailable".to_owned(),
            message: "keeper owner stopped".to_owned(),
            retryable: true,
        },
    };
    write_control(stream, &response)?;
    Ok(())
}

fn write_runtime_error(
    writer: &mut impl Write,
    error: KeeperRuntimeError,
) -> Result<(), KeeperRuntimeError> {
    let response = match error {
        KeeperRuntimeError::Fenced(message) => KeeperRpcResponse::Error {
            code: "fenced".to_owned(),
            message: message.to_owned(),
            retryable: false,
        },
        KeeperRuntimeError::OutcomeUnknown(message) => KeeperRpcResponse::Error {
            code: "outcome-unknown".to_owned(),
            message: message.to_owned(),
            retryable: false,
        },
        KeeperRuntimeError::Retryable(message) => KeeperRpcResponse::Error {
            code: "temporarily-unavailable".to_owned(),
            message: message.to_owned(),
            retryable: true,
        },
        error => KeeperRpcResponse::Error {
            code: "keeper-failed".to_owned(),
            message: error.to_string(),
            retryable: false,
        },
    };
    write_control(writer, &response)?;
    Ok(())
}

fn write_rpc_error(
    stream: &mut UnixStream,
    code: &str,
    retryable: bool,
) -> Result<(), KeeperRuntimeError> {
    write_control(
        stream,
        &KeeperRpcResponse::Error {
            code: code.to_owned(),
            message: code.to_owned(),
            retryable,
        },
    )?;
    Ok(())
}

fn validate_retained_checkpoint_location(
    descriptor: &SessionDescriptor,
    descriptor_path: &Path,
) -> Result<(), KeeperRuntimeError> {
    match (
        descriptor.retained_checkpoint.as_ref(),
        descriptor.truncated_before_sequence.as_deref(),
    ) {
        (None, None) => Ok(()),
        (None, Some(truncated_before)) => {
            if parse_u64(truncated_before)? == 0 {
                return Err(KeeperRuntimeError::Invalid(
                    "retained truncation boundary is invalid",
                ));
            }
            Ok(())
        }
        (Some(checkpoint), Some(truncated_before)) => {
            let checkpoint_sequence = parse_u64(&checkpoint.mutation_sequence)?;
            let expected_truncation =
                checkpoint_sequence
                    .checked_add(1)
                    .ok_or(KeeperRuntimeError::Invalid(
                        "retained checkpoint sequence is exhausted",
                    ))?;
            if checkpoint.version != RETAINED_CHECKPOINT_VERSION
                || checkpoint.resource_key != descriptor.resource_key
                || checkpoint.keeper_generation != descriptor.keeper_generation
                || checkpoint.checkpoint_path
                    != retained_checkpoint_path(descriptor_path, descriptor, &checkpoint.sha256)?
                        .to_string_lossy()
                || checkpoint.format.is_empty()
                || checkpoint.format.len() > 256
                || checkpoint.format.chars().any(char::is_control)
                || checkpoint.parser_version.is_empty()
                || checkpoint.parser_version.len() > 256
                || checkpoint.parser_version.chars().any(char::is_control)
                || checkpoint_sequence == 0
                || checkpoint.cols == 0
                || checkpoint.rows == 0
                || checkpoint.cols > 32_767
                || checkpoint.rows > 32_767
                || checkpoint.byte_length > REMOTE_CHECKPOINT_HARD_MAX_BYTES as u64
                || !is_sha256(&checkpoint.sha256)
                || checkpoint.created_at.len() < 24
                || checkpoint.created_at.len() > 64
                || !checkpoint.created_at.ends_with('Z')
                || checkpoint.created_at.chars().any(char::is_control)
                || parse_u64(truncated_before)? != expected_truncation
            {
                return Err(KeeperRuntimeError::Invalid(
                    "retained checkpoint descriptor is invalid",
                ));
            }
            Ok(())
        }
        (Some(_), None) => Err(KeeperRuntimeError::Invalid(
            "retained checkpoint requires a truncation boundary",
        )),
    }
}

fn validate_descriptor(descriptor: &SessionDescriptor) -> Result<(), KeeperRuntimeError> {
    let resource_key_is_valid = is_valid_id(&descriptor.resource_key.desktop_installation_id)
        && is_valid_id(&descriptor.resource_key.target_id)
        && is_valid_id(&descriptor.resource_key.workspace_id)
        && descriptor
            .resource_key
            .session_id
            .as_deref()
            .is_some_and(is_valid_id);
    let process_identity_is_valid = match descriptor.state {
        SessionDescriptorState::Creating => {
            descriptor.keeper_pid.is_none()
                && descriptor.child_pid.is_none()
                && descriptor.exit_code.is_none()
                && descriptor.launch_input.is_none()
        }
        SessionDescriptorState::Running => {
            descriptor.keeper_pid.is_some_and(|pid| pid > 0)
                && descriptor.child_pid.is_some_and(|pid| pid > 0)
                && descriptor.exit_code.is_none()
        }
        SessionDescriptorState::Exited | SessionDescriptorState::Terminated => {
            descriptor.keeper_pid.is_some_and(|pid| pid > 0)
                && descriptor.child_pid.is_some_and(|pid| pid > 0)
        }
    };
    let conversion_metadata_is_valid = match (
        descriptor.conversion_transaction_id.as_deref(),
        descriptor.remote_snapshot_hash.as_deref(),
        descriptor.provisional_created_at.as_deref(),
    ) {
        (None, None, None) => descriptor.lifecycle_state == SessionLifecycleState::Committed,
        (Some(transaction_id), Some(snapshot_hash), Some(created_at)) => {
            is_valid_id(transaction_id)
                && is_sha256(snapshot_hash)
                && (24..=64).contains(&created_at.len())
                && created_at.ends_with('Z')
                && !created_at.chars().any(char::is_control)
        }
        _ => false,
    };
    if descriptor.version != SESSION_DESCRIPTOR_VERSION
        || !resource_key_is_valid
        || !is_valid_id(&descriptor.keeper_generation)
        || !is_sha256(&descriptor.executable_generation)
        || !is_valid_descriptor_path(&descriptor.executable_path)
        || descriptor.keeper_local_protocol_major == 0
        || descriptor.terminal_wire_version != kmux_compat::TERMINAL_WIRE_VERSION
        || !is_valid_id(&descriptor.create_operation_id)
        || !is_valid_id(&descriptor.last_operation_id)
        || !is_sha256(&descriptor.canonical_create_payload_hash)
        || !is_sha256(&descriptor.create_result_digest)
        || !is_sha256(&descriptor.last_operation_payload_hash)
        || !is_sha256(&descriptor.last_result_digest)
        || parse_u64(&descriptor.remote_resource_revision).is_err()
        || !is_valid_descriptor_path(&descriptor.socket_path)
        || !is_valid_descriptor_path(&descriptor.journal_path)
        || descriptor.socket_path == descriptor.journal_path
        || descriptor.updated_at.len() < 24
        || descriptor.updated_at.len() > 64
        || !descriptor.updated_at.ends_with('Z')
        || descriptor.updated_at.chars().any(char::is_control)
        || !process_identity_is_valid
        || !conversion_metadata_is_valid
        || !descriptor.retention_policy.is_valid()
    {
        return Err(KeeperRuntimeError::Invalid("session descriptor is invalid"));
    }
    validate_launch(&descriptor.launch)?;
    if let Some(record) = &descriptor.launch_input {
        let outcome_offset_is_invalid = match record.outcome {
            LaunchInputOutcome::Accepted => record.written_offset != 0,
            LaunchInputOutcome::Written => record.written_offset != record.byte_length,
            LaunchInputOutcome::OutcomeUnknown => record.written_offset > record.byte_length,
        };
        if !is_valid_id(&record.operation_id)
            || !is_sha256(&record.payload_hash)
            || record.byte_length > kmux_compat::REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES
            || record.written_offset > record.byte_length
            || outcome_offset_is_invalid
        {
            return Err(KeeperRuntimeError::Invalid(
                "launch-input descriptor is invalid",
            ));
        }
    }
    Ok(())
}

fn validate_launch(launch: &KeeperLaunchConfig) -> Result<(), KeeperRuntimeError> {
    let shell_is_invalid = launch.shell.as_ref().is_some_and(|shell| {
        !Path::new(shell).is_absolute() || shell.len() > 32 * 1024 || shell.contains('\0')
    });
    let args_are_invalid = launch.args.as_ref().is_some_and(|args| {
        args.len() > 256
            || args
                .iter()
                .any(|value| value.len() > 32 * 1024 || value.contains('\0'))
    });
    let env_is_invalid = launch.env.as_ref().is_some_and(|env| {
        env.len() > 256
            || env.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > 4 * 1024
                    || key.contains('\0')
                    || key.contains('=')
                    || value.len() > 64 * 1024
                    || value.contains('\0')
            })
    });
    let title_is_invalid = launch
        .title
        .as_ref()
        .is_some_and(|title| title.is_empty() || title.len() > 4 * 1024 || title.contains('\0'));
    if !Path::new(&launch.cwd).is_absolute()
        || launch.cwd.len() > 32 * 1024
        || launch.cwd.contains('\0')
        || launch.cols == 0
        || launch.rows == 0
        || launch.cols > 32_767
        || launch.rows > 32_767
        || shell_is_invalid
        || args_are_invalid
        || env_is_invalid
        || title_is_invalid
    {
        return Err(KeeperRuntimeError::Invalid("keeper launch is invalid"));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn is_valid_descriptor_path(value: &str) -> bool {
    Path::new(value).is_absolute() && value.len() <= 32 * 1024 && !value.contains('\0')
}

fn parse_u64(value: &str) -> Result<u64, KeeperRuntimeError> {
    if value == "0" || (!value.starts_with('0') && value.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return value
            .parse()
            .map_err(|_| KeeperRuntimeError::Invalid("uint64 is invalid"));
    }
    Err(KeeperRuntimeError::Invalid("uint64 is not canonical"))
}

fn ensure_private_directory(path: &Path) -> Result<(), KeeperRuntimeError> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(KeeperRuntimeError::Invalid("runtime directory is unsafe"));
    }
    Ok(())
}

fn sync_parent_directory(path: &Path) -> Result<(), KeeperRuntimeError> {
    let parent = path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("path has no parent"))?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn write_private_json_atomic(
    path: &Path,
    value: &impl Serialize,
) -> Result<(), KeeperRuntimeError> {
    let parent = path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("durable path has no parent"))?;
    ensure_private_directory(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("record"),
        Uuid::new_v4()
    ));
    write_private_json_create_new(&temporary, value)?;
    fs::rename(&temporary, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn write_private_json_create_new(
    path: &Path,
    value: &impl Serialize,
) -> Result<(), KeeperRuntimeError> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() as u64 > MAX_DESCRIPTOR_BYTES {
        return Err(KeeperRuntimeError::Invalid("durable JSON is oversized"));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    use std::io::Write;
    file.write_all(&bytes)?;
    file.sync_all()?;
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn write_private_checkpoint_atomic(path: &Path, bytes: &[u8]) -> Result<(), KeeperRuntimeError> {
    if bytes.len() > REMOTE_CHECKPOINT_HARD_MAX_BYTES {
        return Err(KeeperRuntimeError::Invalid(
            "retained checkpoint exceeds its hard byte limit",
        ));
    }
    let parent = path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("checkpoint path has no parent"))?;
    ensure_private_directory(parent)?;
    if path.exists() {
        let existing = read_private_checkpoint(path)?;
        if existing != bytes {
            return Err(KeeperRuntimeError::Invalid(
                "content-addressed checkpoint conflicts with existing bytes",
            ));
        }
        return Ok(());
    }
    let temporary = parent.join(format!(".checkpoint-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(OFlag::O_NOFOLLOW.bits())
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_private_checkpoint(path: &Path) -> Result<Vec<u8>, KeeperRuntimeError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > REMOTE_CHECKPOINT_HARD_MAX_BYTES as u64
    {
        return Err(KeeperRuntimeError::Invalid(
            "retained checkpoint file is unsafe",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(REMOTE_CHECKPOINT_HARD_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > REMOTE_CHECKPOINT_HARD_MAX_BYTES {
        return Err(KeeperRuntimeError::Invalid(
            "retained checkpoint file is oversized",
        ));
    }
    Ok(bytes)
}

fn replace_journal_with_empty_file(path: &Path) -> Result<File, KeeperRuntimeError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(KeeperRuntimeError::Invalid("journal file is unsafe"));
    }
    let parent = path
        .parent()
        .ok_or(KeeperRuntimeError::Invalid("journal path has no parent"))?;
    let temporary = parent.join(format!(".journal-{}.tmp", Uuid::new_v4()));
    let replacement = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(OFlag::O_NOFOLLOW.bits())
        .open(&temporary)?;
    let result = (|| {
        replacement.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        return result.map(|()| replacement);
    }
    Ok(replacement)
}

fn read_private_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
    maximum: u64,
) -> Result<T, KeeperRuntimeError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > maximum
    {
        return Err(KeeperRuntimeError::Invalid("private JSON record is unsafe"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(KeeperRuntimeError::Invalid(
            "private JSON record is oversized",
        ));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn now_rfc3339() -> String {
    format_rfc3339(unix_millis())
}

fn format_rfc3339(unix_ms: u64) -> String {
    let seconds = (unix_ms / 1000) as i64;
    let milliseconds = unix_ms % 1000;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milliseconds:03}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    enum InputWriteStep {
        Accept(usize),
        Fail,
    }

    struct ScriptedInputWriter {
        steps: VecDeque<InputWriteStep>,
        accepted: Vec<u8>,
        attempted: Vec<Vec<u8>>,
    }

    impl PtyInputWriter for ScriptedInputWriter {
        fn write_input(&mut self, data: &[u8]) -> Result<usize, PtyError> {
            self.attempted.push(data.to_vec());
            match self.steps.pop_front().expect("scripted write step") {
                InputWriteStep::Accept(bytes) => {
                    let accepted = bytes.min(data.len());
                    self.accepted.extend_from_slice(&data[..accepted]);
                    Ok(accepted)
                }
                InputWriteStep::Fail => Err(PtyError::Io(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "injected partial write failure",
                ))),
            }
        }
    }

    enum InputPersistenceSabotage {
        DirectoryToFile { path: PathBuf, backup: PathBuf },
        FileToDirectory { path: PathBuf, backup: PathBuf },
    }

    struct SabotagingInputWriter {
        sabotage: Option<InputPersistenceSabotage>,
        accepted: Vec<u8>,
        attempted: Vec<Vec<u8>>,
    }

    impl PtyInputWriter for SabotagingInputWriter {
        fn write_input(&mut self, data: &[u8]) -> Result<usize, PtyError> {
            self.attempted.push(data.to_vec());
            self.accepted.extend_from_slice(data);
            match self.sabotage.take() {
                Some(InputPersistenceSabotage::DirectoryToFile { path, backup }) => {
                    fs::rename(&path, backup).unwrap();
                    fs::write(path, b"blocked").unwrap();
                }
                Some(InputPersistenceSabotage::FileToDirectory { path, backup }) => {
                    fs::rename(&path, backup).unwrap();
                    fs::create_dir(path).unwrap();
                }
                None => {}
            }
            Ok(data.len())
        }
    }

    fn test_session_descriptor(root: &Path) -> SessionDescriptor {
        SessionDescriptor {
            version: SESSION_DESCRIPTOR_VERSION,
            resource_key: RemoteResourceKey {
                desktop_installation_id: "desktop_1".to_owned(),
                target_id: "target_1".to_owned(),
                workspace_id: "workspace_1".to_owned(),
                session_id: Some("session_1".to_owned()),
            },
            keeper_generation: "keeper_1".to_owned(),
            executable_generation: "d".repeat(64),
            executable_path: "/tmp/kmuxd".to_owned(),
            keeper_local_protocol_major: kmux_compat::KEEPER_LOCAL_PROTOCOL_MAJOR,
            terminal_wire_version: kmux_compat::TERMINAL_WIRE_VERSION,
            create_operation_id: "create_1".to_owned(),
            canonical_create_payload_hash: "a".repeat(64),
            create_result_digest: "b".repeat(64),
            remote_resource_revision: "1".to_owned(),
            last_operation_id: "create_1".to_owned(),
            last_operation_payload_hash: "a".repeat(64),
            last_result_digest: "b".repeat(64),
            state: SessionDescriptorState::Running,
            socket_path: root.join("keeper.sock").to_string_lossy().into_owned(),
            journal_path: root.join("terminal.journal").to_string_lossy().into_owned(),
            launch: KeeperLaunchConfig {
                cwd: "/tmp".to_owned(),
                shell: Some("/bin/sh".to_owned()),
                args: None,
                env: None,
                title: None,
                cols: 80,
                rows: 24,
            },
            keeper_pid: Some(std::process::id()),
            child_pid: Some(std::process::id()),
            exit_code: None,
            launch_input: None,
            updated_at: now_rfc3339(),
            lifecycle_state: SessionLifecycleState::Committed,
            conversion_transaction_id: None,
            remote_snapshot_hash: None,
            provisional_created_at: None,
            ever_granted_writer_lease: false,
            storage_status: RemoteSessionStorageStatus::default(),
            retention_policy: RemoteRetentionPolicy::default(),
            retained_checkpoint: None,
            truncated_before_sequence: None,
        }
    }

    fn write_retained_exited_session(
        state_root: &Path,
        workspace_id: &str,
        session_id: &str,
        keeper_generation: &str,
        checkpoint_created_at: &str,
        orphan_checkpoint_bytes: u64,
        retention_policy: RemoteRetentionPolicy,
    ) -> (PathBuf, PathBuf, PathBuf) {
        let sessions = state_root.join("sessions");
        let mut descriptor = test_session_descriptor(&sessions);
        descriptor.resource_key.workspace_id = workspace_id.to_owned();
        descriptor.resource_key.session_id = Some(session_id.to_owned());
        descriptor.keeper_generation = keeper_generation.to_owned();
        descriptor.state = SessionDescriptorState::Exited;
        descriptor.exit_code = Some(0);
        descriptor.retention_policy = retention_policy;
        descriptor.journal_path = session_journal_path(
            state_root,
            &descriptor.resource_key,
            &descriptor.keeper_generation,
        )
        .to_string_lossy()
        .into_owned();
        let descriptor_path = session_descriptor_path(state_root, &descriptor.resource_key);
        let checkpoint_sha = format!("{:x}", Sha256::digest(b"checkpoint"));
        let checkpoint_path =
            retained_checkpoint_path(&descriptor_path, &descriptor, &checkpoint_sha).unwrap();
        let checkpoint = RetainedCheckpointRecord {
            version: RETAINED_CHECKPOINT_VERSION,
            resource_key: descriptor.resource_key.clone(),
            keeper_generation: descriptor.keeper_generation.clone(),
            checkpoint_path: checkpoint_path.to_string_lossy().into_owned(),
            format: "xterm-vt/1".to_owned(),
            parser_version: kmux_terminal::CHECKPOINT_PARSER_VERSION.to_owned(),
            mutation_sequence: "1".to_owned(),
            cols: 80,
            rows: 24,
            byte_length: b"checkpoint".len() as u64,
            sha256: checkpoint_sha,
            created_at: checkpoint_created_at.to_owned(),
        };
        descriptor.retained_checkpoint = Some(checkpoint.clone());
        descriptor.truncated_before_sequence = Some("2".to_owned());

        let checkpoint_resource =
            retained_checkpoint_resource_directory(&descriptor_path, &descriptor).unwrap();
        let checkpoint_generation = checkpoint_path.parent().unwrap();
        ensure_private_directory(&checkpoint_resource).unwrap();
        ensure_private_directory(checkpoint_generation).unwrap();
        write_private_checkpoint_atomic(&checkpoint_path, b"checkpoint").unwrap();
        write_private_json_atomic(
            &retained_checkpoint_metadata_path(&descriptor_path, &descriptor).unwrap(),
            &checkpoint,
        )
        .unwrap();
        let orphan_generation = checkpoint_resource.join("keeper_superseded");
        ensure_private_directory(&orphan_generation).unwrap();
        let orphan_path = orphan_generation.join("orphan.checkpoint");
        let orphan = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&orphan_path)
            .unwrap();
        orphan.set_len(orphan_checkpoint_bytes).unwrap();
        orphan.sync_all().unwrap();

        let journal_path = PathBuf::from(&descriptor.journal_path);
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&journal_path)
            .unwrap()
            .sync_all()
            .unwrap();
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();
        (descriptor_path, checkpoint_resource, journal_path)
    }

    #[test]
    fn resource_descriptor_identity_is_deterministic_and_target_scoped() {
        let key = RemoteResourceKey {
            desktop_installation_id: "desktop_1".to_owned(),
            target_id: "target_1".to_owned(),
            workspace_id: "workspace_1".to_owned(),
            session_id: Some("session_1".to_owned()),
        };
        assert_eq!(resource_key_digest(&key), resource_key_digest(&key));
        let mut other = key.clone();
        other.target_id = "target_2".to_owned();
        assert_ne!(resource_key_digest(&key), resource_key_digest(&other));
    }

    #[test]
    fn timestamp_formatter_emits_parseable_epoch_and_modern_dates() {
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            format_rfc3339(1_752_710_400_123),
            "2025-07-17T00:00:00.123Z"
        );
    }

    #[test]
    fn keeper_prepends_remote_shims_only_to_the_spawned_process_environment() {
        let descriptor_env = BTreeMap::from([
            ("KMUX_AGENT_BIN_DIR".to_owned(), "/kmux/bin".to_owned()),
            ("PATH".to_owned(), "/custom/bin:/usr/bin".to_owned()),
            ("USER_VALUE".to_owned(), "preserved".to_owned()),
        ]);

        let spawned = keeper_launch_env(Some(&descriptor_env));
        assert_eq!(
            spawned.get("PATH").map(String::as_str),
            Some("/kmux/bin:/custom/bin:/usr/bin")
        );
        assert_eq!(
            spawned.get("USER_VALUE").map(String::as_str),
            Some("preserved")
        );
        assert_eq!(
            descriptor_env.get("PATH").map(String::as_str),
            Some("/custom/bin:/usr/bin")
        );
    }

    #[test]
    fn attach_uses_cursor_replay_only_when_the_retained_range_is_contiguous() {
        assert!(attach_needs_checkpoint(None, 1));
        assert!(!attach_needs_checkpoint(Some(0), 1));
        assert!(!attach_needs_checkpoint(Some(6), 7));
        assert!(attach_needs_checkpoint(Some(5), 7));
        assert!(!attach_needs_checkpoint(Some(u64::MAX), u64::MAX));
    }

    #[test]
    fn attachment_admission_rejects_duplicates_and_is_hard_bounded() {
        let mut subscribers = HashMap::new();
        for index in 0..MAX_ATTACHMENTS_PER_KEEPER {
            let (outbound, _receiver) = bounded(1);
            subscribers.insert(
                format!("attachment_{index}"),
                Subscriber {
                    outbound,
                    closed: Arc::new(AtomicBool::new(false)),
                },
            );
        }

        assert!(matches!(
            validate_attachment_admission(&subscribers, "attachment_0"),
            Err(KeeperRuntimeError::Fenced(_))
        ));
        assert!(matches!(
            validate_attachment_admission(&subscribers, "attachment_over_limit"),
            Err(KeeperRuntimeError::Invalid(_))
        ));
    }

    #[test]
    fn attachment_registration_detaches_on_every_scope_exit() {
        let (commands, receiver) = bounded(1);
        let closed = Arc::new(AtomicBool::new(false));
        {
            let _registration = AttachmentRegistration::new(
                commands,
                "attachment_1".to_owned(),
                Arc::clone(&closed),
            );
        }

        assert!(closed.load(Ordering::Acquire));
        assert!(matches!(
            receiver.recv().unwrap(),
            OwnerCommand::Detach { attachment_id } if attachment_id == "attachment_1"
        ));
    }

    #[test]
    fn first_writer_safety_bit_commits_memory_only_after_durable_write() {
        let mut descriptor = test_session_descriptor(Path::new("/tmp"));
        let refreshed = descriptor.clone();
        let failed = commit_first_writer_safety_bit(&mut descriptor, refreshed, |updated| {
            assert!(updated.ever_granted_writer_lease);
            Err(KeeperRuntimeError::Retryable(
                "injected descriptor persistence failure",
            ))
        });
        assert!(matches!(failed, Err(KeeperRuntimeError::Retryable(_))));
        assert!(!descriptor.ever_granted_writer_lease);

        let refreshed = descriptor.clone();
        let mut persisted = false;
        commit_first_writer_safety_bit(&mut descriptor, refreshed, |updated| {
            persisted = updated.ever_granted_writer_lease;
            Ok(())
        })
        .unwrap();
        assert!(persisted);
        assert!(descriptor.ever_granted_writer_lease);
    }

    #[test]
    fn input_retry_resumes_only_the_unwritten_suffix_and_fences_old_writers() {
        let writer = Some(("lease_1".to_owned(), "attachment_1".to_owned()));
        let mut deduplication = InputDeduplication::default();
        let mut input_epoch = 0_u64;
        let mut child = ScriptedInputWriter {
            steps: VecDeque::from([
                InputWriteStep::Accept(2),
                InputWriteStep::Fail,
                InputWriteStep::Accept(3),
            ]),
            accepted: Vec::new(),
            attempted: Vec::new(),
        };

        let first = apply_input(
            &mut child,
            &writer,
            "lease_1",
            "attachment_1",
            1,
            b"hello",
            &mut deduplication,
            &mut input_epoch,
        );
        assert!(first.is_err());
        assert_eq!(child.accepted, b"he");

        let retried = apply_input(
            &mut child,
            &writer,
            "lease_1",
            "attachment_1",
            1,
            b"hello",
            &mut deduplication,
            &mut input_epoch,
        )
        .unwrap();
        assert_eq!(retried, 1);
        assert_eq!(child.accepted, b"hello");
        assert_eq!(
            child.attempted,
            [b"hello".to_vec(), b"llo".to_vec(), b"llo".to_vec()]
        );

        let attempts_after_completion = child.attempted.len();
        assert_eq!(
            apply_input(
                &mut child,
                &writer,
                "lease_1",
                "attachment_1",
                1,
                b"hello",
                &mut deduplication,
                &mut input_epoch,
            )
            .unwrap(),
            1
        );
        assert_eq!(child.attempted.len(), attempts_after_completion);

        let stale = apply_input(
            &mut child,
            &writer,
            "lease_stale",
            "attachment_1",
            2,
            b"!",
            &mut deduplication,
            &mut input_epoch,
        );
        assert!(matches!(stale, Err(KeeperRuntimeError::Fenced(_))));
        assert_eq!(child.attempted.len(), attempts_after_completion);
    }

    #[test]
    fn operation_input_persists_partial_offsets_deduplicates_and_fences_lease_changes() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let descriptor_path = sandbox.path().join("session.json");
        let mut descriptor = test_session_descriptor(sandbox.path());
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();

        let writer = Some(("lease_1".to_owned(), "attachment_1".to_owned()));
        let mut input_epoch = 0_u64;
        let mut uncertain_records = HashMap::new();
        let input = b"hello";
        let payload_hash = format!("{:x}", Sha256::digest(input));
        let mut child = ScriptedInputWriter {
            steps: VecDeque::from([
                InputWriteStep::Accept(2),
                InputWriteStep::Fail,
                InputWriteStep::Accept(3),
            ]),
            accepted: Vec::new(),
            attempted: Vec::new(),
        };

        assert!(
            apply_operation_input(
                &mut child,
                &mut descriptor,
                &descriptor_path,
                &writer,
                "operation_1",
                &payload_hash,
                input,
                &mut input_epoch,
                &mut uncertain_records,
            )
            .is_err()
        );
        assert_eq!(child.accepted, b"he");
        assert!(descriptor.ever_granted_writer_lease);

        let operation_directory = operation_input_directory(&descriptor_path).unwrap();
        let record_path = operation_input_record_path(
            &operation_directory,
            &descriptor.keeper_generation,
            "operation_1",
        );
        assert_eq!(
            load_operation_input_record(&record_path).unwrap(),
            Some(OperationInputRecord {
                version: 1,
                keeper_generation: "keeper_1".to_owned(),
                operation_id: "operation_1".to_owned(),
                payload_hash: payload_hash.clone(),
                writer_lease_id: "lease_1".to_owned(),
                temporary_lease: false,
                input_epoch: 1,
                byte_length: input.len(),
                written_offset: 2,
                outcome: OperationInputOutcome::OutcomeUnknown,
            })
        );

        let retried = apply_operation_input(
            &mut child,
            &mut descriptor,
            &descriptor_path,
            &writer,
            "operation_1",
            &payload_hash,
            input,
            &mut input_epoch,
            &mut uncertain_records,
        )
        .unwrap();
        assert!(matches!(
            retried,
            KeeperRpcResponse::InputAck {
                operation_id,
                keeper_generation,
                writer_lease_id,
                byte_length: 5,
                boundary,
            } if operation_id == "operation_1"
                && keeper_generation == "keeper_1"
                && writer_lease_id == "lease_1"
                && boundary == "pty-write"
        ));
        assert_eq!(child.accepted, input);
        assert_eq!(
            child.attempted,
            [input.to_vec(), b"llo".to_vec(), b"llo".to_vec()]
        );

        let attempts_after_completion = child.attempted.len();
        let changed_writer = Some(("lease_2".to_owned(), "attachment_2".to_owned()));
        apply_operation_input(
            &mut child,
            &mut descriptor,
            &descriptor_path,
            &changed_writer,
            "operation_1",
            &payload_hash,
            input,
            &mut input_epoch,
            &mut uncertain_records,
        )
        .unwrap();
        assert_eq!(child.attempted.len(), attempts_after_completion);

        let changed_input = b"hullo";
        let changed_hash = format!("{:x}", Sha256::digest(changed_input));
        assert!(matches!(
            apply_operation_input(
                &mut child,
                &mut descriptor,
                &descriptor_path,
                &writer,
                "operation_1",
                &changed_hash,
                changed_input,
                &mut input_epoch,
                &mut uncertain_records,
            ),
            Err(KeeperRuntimeError::Fenced(_))
        ));
        assert_eq!(child.attempted.len(), attempts_after_completion);

        let second_input = b"world";
        let second_hash = format!("{:x}", Sha256::digest(second_input));
        let mut partial_child = ScriptedInputWriter {
            steps: VecDeque::from([InputWriteStep::Accept(1), InputWriteStep::Fail]),
            accepted: Vec::new(),
            attempted: Vec::new(),
        };
        assert!(
            apply_operation_input(
                &mut partial_child,
                &mut descriptor,
                &descriptor_path,
                &writer,
                "operation_2",
                &second_hash,
                second_input,
                &mut input_epoch,
                &mut uncertain_records,
            )
            .is_err()
        );
        let attempts_after_partial_write = partial_child.attempted.len();
        assert!(matches!(
            apply_operation_input(
                &mut partial_child,
                &mut descriptor,
                &descriptor_path,
                &changed_writer,
                "operation_2",
                &second_hash,
                second_input,
                &mut input_epoch,
                &mut uncertain_records,
            ),
            Err(KeeperRuntimeError::OutcomeUnknown(_))
        ));
        assert_eq!(partial_child.accepted, b"w");
        assert_eq!(partial_child.attempted.len(), attempts_after_partial_write);
    }

    #[test]
    fn operation_input_is_not_reissued_when_only_completion_persistence_fails() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let descriptor_directory = sandbox.path().join("descriptors");
        ensure_private_directory(&descriptor_directory).unwrap();
        let descriptor_path = descriptor_directory.join("session.json");
        let mut descriptor = test_session_descriptor(sandbox.path());
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();
        let operation_directory = operation_input_directory(&descriptor_path).unwrap();
        let operation_directory_backup = sandbox.path().join("input-ops-backup");
        let writer = Some(("lease_1".to_owned(), "attachment_1".to_owned()));
        let input = b"hello";
        let payload_hash = format!("{:x}", Sha256::digest(input));
        let mut input_epoch = 0_u64;
        let mut uncertain_records = HashMap::new();
        let mut child = SabotagingInputWriter {
            sabotage: Some(InputPersistenceSabotage::DirectoryToFile {
                path: operation_directory,
                backup: operation_directory_backup,
            }),
            accepted: Vec::new(),
            attempted: Vec::new(),
        };

        assert!(matches!(
            apply_operation_input(
                &mut child,
                &mut descriptor,
                &descriptor_path,
                &writer,
                "operation_1",
                &payload_hash,
                input,
                &mut input_epoch,
                &mut uncertain_records,
            ),
            Err(KeeperRuntimeError::OutcomeUnknown(_))
        ));
        assert_eq!(child.accepted, input);
        assert_eq!(child.attempted, [input.to_vec()]);
        assert_eq!(
            uncertain_records
                .get("operation_1")
                .map(|record| &record.outcome),
            Some(&OperationInputOutcome::Written)
        );

        let attempts_after_completion = child.attempted.len();
        assert!(matches!(
            apply_operation_input(
                &mut child,
                &mut descriptor,
                &descriptor_path,
                &writer,
                "operation_1",
                &payload_hash,
                input,
                &mut input_epoch,
                &mut uncertain_records,
            )
            .unwrap(),
            KeeperRpcResponse::InputAck { byte_length: 5, .. }
        ));
        assert_eq!(child.attempted.len(), attempts_after_completion);
        assert_eq!(child.accepted, input);
    }

    #[test]
    fn recovered_accepted_operation_input_is_never_reissued() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let descriptor_directory = sandbox.path().join("descriptors");
        ensure_private_directory(&descriptor_directory).unwrap();
        let descriptor_path = descriptor_directory.join("session.json");
        let mut descriptor = test_session_descriptor(sandbox.path());
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();
        let operation_directory = operation_input_directory(&descriptor_path).unwrap();
        ensure_private_directory(&operation_directory).unwrap();
        let input = b"hello";
        let payload_hash = format!("{:x}", Sha256::digest(input));
        write_private_json_atomic(
            &operation_input_record_path(
                &operation_directory,
                &descriptor.keeper_generation,
                "operation_1",
            ),
            &OperationInputRecord {
                version: 1,
                keeper_generation: descriptor.keeper_generation.clone(),
                operation_id: "operation_1".to_owned(),
                payload_hash: payload_hash.clone(),
                writer_lease_id: "lease_1".to_owned(),
                temporary_lease: false,
                input_epoch: 1,
                byte_length: input.len(),
                written_offset: 0,
                outcome: OperationInputOutcome::Accepted,
            },
        )
        .unwrap();
        let writer = Some(("lease_1".to_owned(), "attachment_1".to_owned()));
        let mut input_epoch = 1_u64;
        let mut uncertain_records = HashMap::new();
        let mut child = ScriptedInputWriter {
            steps: VecDeque::from([InputWriteStep::Accept(input.len())]),
            accepted: Vec::new(),
            attempted: Vec::new(),
        };

        assert!(matches!(
            apply_operation_input(
                &mut child,
                &mut descriptor,
                &descriptor_path,
                &writer,
                "operation_1",
                &payload_hash,
                input,
                &mut input_epoch,
                &mut uncertain_records,
            ),
            Err(KeeperRuntimeError::OutcomeUnknown(_))
        ));
        assert!(child.attempted.is_empty());
        assert!(child.accepted.is_empty());
    }

    #[test]
    fn cross_domain_input_fences_an_older_partial_retry_in_both_directions() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let descriptor_path = sandbox.path().join("session.json");
        let mut descriptor = test_session_descriptor(sandbox.path());
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();
        let writer = Some(("lease_1".to_owned(), "attachment_1".to_owned()));
        let mut deduplication = InputDeduplication::default();
        let mut input_epoch = 0_u64;
        let mut uncertain_records = HashMap::new();
        let operation = b"hello";
        let operation_hash = format!("{:x}", Sha256::digest(operation));
        let mut child = ScriptedInputWriter {
            steps: VecDeque::from([
                InputWriteStep::Accept(2),
                InputWriteStep::Fail,
                InputWriteStep::Accept(1),
            ]),
            accepted: Vec::new(),
            attempted: Vec::new(),
        };

        assert!(
            apply_operation_input(
                &mut child,
                &mut descriptor,
                &descriptor_path,
                &writer,
                "operation_partial",
                &operation_hash,
                operation,
                &mut input_epoch,
                &mut uncertain_records,
            )
            .is_err()
        );
        assert_eq!(input_epoch, 1);
        assert_eq!(
            apply_input(
                &mut child,
                &writer,
                "lease_1",
                "attachment_1",
                1,
                b"!",
                &mut deduplication,
                &mut input_epoch,
            )
            .unwrap(),
            1
        );
        assert_eq!(input_epoch, 2);
        let attempts_after_interleaving_input = child.attempted.len();
        assert!(matches!(
            apply_operation_input(
                &mut child,
                &mut descriptor,
                &descriptor_path,
                &writer,
                "operation_partial",
                &operation_hash,
                operation,
                &mut input_epoch,
                &mut uncertain_records,
            ),
            Err(KeeperRuntimeError::OutcomeUnknown(_))
        ));
        assert_eq!(child.accepted, b"he!");
        assert_eq!(child.attempted.len(), attempts_after_interleaving_input);

        let second_sandbox = tempfile::TempDir::new().unwrap();
        let second_descriptor_path = second_sandbox.path().join("session.json");
        let mut second_descriptor = test_session_descriptor(second_sandbox.path());
        write_session_descriptor(&second_descriptor_path, &second_descriptor).unwrap();
        let mut second_deduplication = InputDeduplication::default();
        let mut second_epoch = 0_u64;
        let mut second_uncertain_records = HashMap::new();
        let injected = b"!";
        let injected_hash = format!("{:x}", Sha256::digest(injected));
        let mut second_child = ScriptedInputWriter {
            steps: VecDeque::from([
                InputWriteStep::Accept(2),
                InputWriteStep::Fail,
                InputWriteStep::Accept(1),
            ]),
            accepted: Vec::new(),
            attempted: Vec::new(),
        };

        assert!(
            apply_input(
                &mut second_child,
                &writer,
                "lease_1",
                "attachment_1",
                1,
                b"hello",
                &mut second_deduplication,
                &mut second_epoch,
            )
            .is_err()
        );
        apply_operation_input(
            &mut second_child,
            &mut second_descriptor,
            &second_descriptor_path,
            &writer,
            "operation_after_partial_renderer_input",
            &injected_hash,
            injected,
            &mut second_epoch,
            &mut second_uncertain_records,
        )
        .unwrap();
        let attempts_after_operation = second_child.attempted.len();
        assert!(matches!(
            apply_input(
                &mut second_child,
                &writer,
                "lease_1",
                "attachment_1",
                1,
                b"hello",
                &mut second_deduplication,
                &mut second_epoch,
            ),
            Err(KeeperRuntimeError::OutcomeUnknown(_))
        ));
        assert_eq!(second_child.accepted, b"he!");
        assert_eq!(second_child.attempted.len(), attempts_after_operation);
    }

    #[test]
    fn ambiguous_temporary_lease_operation_input_is_never_reissued() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let descriptor_path = sandbox.path().join("session.json");
        let mut descriptor = test_session_descriptor(sandbox.path());
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();
        let input = b"hello";
        let payload_hash = format!("{:x}", Sha256::digest(input));
        let mut input_epoch = 0_u64;
        let mut uncertain_records = HashMap::new();
        let mut child = ScriptedInputWriter {
            steps: VecDeque::from([InputWriteStep::Accept(2), InputWriteStep::Fail]),
            accepted: Vec::new(),
            attempted: Vec::new(),
        };

        assert!(
            apply_operation_input(
                &mut child,
                &mut descriptor,
                &descriptor_path,
                &None,
                "operation_temporary",
                &payload_hash,
                input,
                &mut input_epoch,
                &mut uncertain_records,
            )
            .is_err()
        );
        assert_eq!(child.accepted, b"he");
        let attempts_after_ambiguous_write = child.attempted.len();
        assert!(matches!(
            apply_operation_input(
                &mut child,
                &mut descriptor,
                &descriptor_path,
                &None,
                "operation_temporary",
                &payload_hash,
                input,
                &mut input_epoch,
                &mut uncertain_records,
            ),
            Err(KeeperRuntimeError::OutcomeUnknown(_))
        ));
        assert_eq!(child.attempted.len(), attempts_after_ambiguous_write);
    }

    #[test]
    fn live_generation_operation_dedupe_records_are_never_evicted_for_capacity() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let directory = sandbox.path().join("input-ops");
        ensure_private_directory(&directory).unwrap();
        let payload_hash = format!("{:x}", Sha256::digest(b"x"));
        for index in 1..=2 {
            let operation_id = format!("operation_{index}");
            let record = OperationInputRecord {
                version: 1,
                keeper_generation: "keeper_1".to_owned(),
                operation_id: operation_id.clone(),
                payload_hash: payload_hash.clone(),
                writer_lease_id: "lease_1".to_owned(),
                temporary_lease: false,
                input_epoch: index as u64,
                byte_length: 1,
                written_offset: 1,
                outcome: OperationInputOutcome::Written,
            };
            write_private_json_atomic(
                &operation_input_record_path(&directory, "keeper_1", &operation_id),
                &record,
            )
            .unwrap();
        }

        assert!(matches!(
            ensure_operation_input_capacity_with_limit(&directory, "keeper_1", 2),
            Err(KeeperRuntimeError::OutcomeUnknown(_))
        ));
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 2);

        ensure_operation_input_capacity_with_limit(&directory, "keeper_2", 2).unwrap();
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
    }

    #[test]
    fn keeper_terminal_side_effects_enter_the_durable_target_spool_once() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let descriptor_path = sandbox.path().join("session.json");
        let endpoint_path = sandbox.path().join("runtime/hook.json");
        let state_root = sandbox.path().join("state");
        let mut descriptor = test_session_descriptor(sandbox.path());
        let token = "secret";
        let endpoint = kmux_hook::SessionControlEndpoint {
            version: 1,
            resource_key: descriptor.resource_key.clone(),
            surface_id: "surface_1".to_owned(),
            keeper_generation: descriptor.keeper_generation.clone(),
            state_root: state_root.to_string_lossy().into_owned(),
            descriptor_path: descriptor_path.to_string_lossy().into_owned(),
            token_sha256: format!("{:x}", Sha256::digest(token.as_bytes())),
        };
        kmux_hook::write_session_control_endpoint(&endpoint_path, &endpoint).unwrap();
        descriptor.launch.env = Some(BTreeMap::from([
            (
                "KMUX_AGENT_HOOK_ENDPOINT".to_owned(),
                endpoint_path.to_string_lossy().into_owned(),
            ),
            ("KMUX_AUTH_TOKEN".to_owned(), token.to_owned()),
            ("KMUX_SURFACE_ID".to_owned(), "surface_1".to_owned()),
        ]));
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();
        let spool = load_keeper_event_spool(&descriptor, &descriptor_path).unwrap();
        let effect = ParserSideEffect {
            mutation_sequence: 7,
            action_index: 0,
            kind: ParserSideEffectKind::Notification {
                protocol: 777,
                title: Some("Build complete".to_owned()),
                message: Some("All tasks passed".to_owned()),
            },
        };
        let mut pending = VecDeque::from([effect.clone(), effect]);
        let mut admission = SideEffectAdmissionState::default();

        assert!(
            drain_pending_side_effects(&spool, &mut pending, &mut admission, Duration::ZERO,)
                .unwrap()
        );
        assert!(pending.is_empty());
        let page = kmux_hook::replay_events(&state_root, "desktop_1", "target_1", 0).unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].kind, "osc-notification");
        assert_eq!(page.events[0].name, "terminal.osc.777");
        assert_eq!(page.events[0].payload["protocol"], 777);

        let mut bells = (0..100)
            .map(|action_index| ParserSideEffect {
                mutation_sequence: 8,
                action_index,
                kind: ParserSideEffectKind::Bell,
            })
            .collect::<VecDeque<_>>();
        assert!(
            drain_pending_side_effects(&spool, &mut bells, &mut admission, Duration::from_secs(1),)
                .unwrap()
        );
        assert!(bells.is_empty());
        assert!(
            drain_pending_side_effects(&spool, &mut bells, &mut admission, Duration::from_secs(6),)
                .unwrap()
        );
        let compacted = kmux_hook::replay_events(&state_root, "desktop_1", "target_1", 0).unwrap();
        assert_eq!(compacted.events.len(), 2);
        assert_eq!(compacted.events[1].name, "terminal.bell");
        assert_eq!(compacted.dropped_low_value_count, 99);
    }

    #[test]
    fn capture_tail_and_chunks_are_hard_bounded_without_splitting_utf8() {
        let value = "first\n둘째\nthird";
        let (tail, truncated) = truncate_utf8_tail(value, 11);
        assert!(truncated);
        assert!(tail.len() <= 11);
        assert!(value.ends_with(&tail));

        let chunks = utf8_chunks(value, 5);
        assert_eq!(chunks.concat(), value);
        assert!(chunks.iter().all(|chunk| chunk.len() <= 5));
    }

    #[test]
    fn capture_receiver_bounds_fragment_count_and_bytes_before_completion() {
        let mut chunks = Vec::new();
        let mut byte_length = 0;
        append_capture_chunk(
            &mut chunks,
            &mut byte_length,
            "capture_1",
            2,
            "capture_1".to_owned(),
            0,
            "a".to_owned(),
        )
        .unwrap();
        append_capture_chunk(
            &mut chunks,
            &mut byte_length,
            "capture_1",
            2,
            "capture_1".to_owned(),
            1,
            "b".to_owned(),
        )
        .unwrap();
        assert_eq!(byte_length, 2);
        assert!(
            append_capture_chunk(
                &mut chunks,
                &mut byte_length,
                "capture_1",
                2,
                "capture_1".to_owned(),
                2,
                "c".to_owned(),
            )
            .is_err()
        );
        let mut empty_chunks = Vec::new();
        let mut empty_byte_length = 0;
        assert!(
            append_capture_chunk(
                &mut empty_chunks,
                &mut empty_byte_length,
                "capture_1",
                2,
                "capture_1".to_owned(),
                0,
                String::new(),
            )
            .is_err()
        );
    }

    #[test]
    fn launch_input_persists_partial_offset_and_retries_only_the_suffix() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let descriptor_path = sandbox.path().join("session.json");
        let mut descriptor = SessionDescriptor {
            version: SESSION_DESCRIPTOR_VERSION,
            resource_key: RemoteResourceKey {
                desktop_installation_id: "desktop_1".to_owned(),
                target_id: "target_1".to_owned(),
                workspace_id: "workspace_1".to_owned(),
                session_id: Some("session_1".to_owned()),
            },
            keeper_generation: "keeper_1".to_owned(),
            executable_generation: "d".repeat(64),
            executable_path: "/tmp/kmuxd".to_owned(),
            keeper_local_protocol_major: kmux_compat::KEEPER_LOCAL_PROTOCOL_MAJOR,
            terminal_wire_version: kmux_compat::TERMINAL_WIRE_VERSION,
            create_operation_id: "create_1".to_owned(),
            canonical_create_payload_hash: "a".repeat(64),
            create_result_digest: "b".repeat(64),
            remote_resource_revision: "1".to_owned(),
            last_operation_id: "create_1".to_owned(),
            last_operation_payload_hash: "a".repeat(64),
            last_result_digest: "b".repeat(64),
            state: SessionDescriptorState::Running,
            socket_path: sandbox
                .path()
                .join("keeper.sock")
                .to_string_lossy()
                .into_owned(),
            journal_path: sandbox
                .path()
                .join("terminal.journal")
                .to_string_lossy()
                .into_owned(),
            launch: KeeperLaunchConfig {
                cwd: "/tmp".to_owned(),
                shell: Some("/bin/sh".to_owned()),
                args: None,
                env: None,
                title: None,
                cols: 80,
                rows: 24,
            },
            keeper_pid: Some(std::process::id()),
            child_pid: Some(std::process::id()),
            exit_code: None,
            launch_input: None,
            updated_at: now_rfc3339(),
            lifecycle_state: SessionLifecycleState::Committed,
            conversion_transaction_id: None,
            remote_snapshot_hash: None,
            provisional_created_at: None,
            ever_granted_writer_lease: false,
            storage_status: RemoteSessionStorageStatus::default(),
            retention_policy: RemoteRetentionPolicy::default(),
            retained_checkpoint: None,
            truncated_before_sequence: None,
        };
        let payload_hash = format!("{:x}", Sha256::digest(b"hello"));
        let mut durable_descriptor = descriptor.clone();
        durable_descriptor.remote_resource_revision = "2".to_owned();
        durable_descriptor.last_operation_id = "adopt_2".to_owned();
        durable_descriptor.last_operation_payload_hash = "e".repeat(64);
        durable_descriptor.last_result_digest = "f".repeat(64);
        durable_descriptor.lifecycle_state = SessionLifecycleState::Provisional;
        durable_descriptor.conversion_transaction_id = Some("conversion_1".to_owned());
        durable_descriptor.remote_snapshot_hash = Some("9".repeat(64));
        durable_descriptor.provisional_created_at = Some(now_rfc3339());
        write_session_descriptor(&descriptor_path, &durable_descriptor).unwrap();

        let mut rejected_descriptor = descriptor.clone();
        let mut rejected_writer = ScriptedInputWriter {
            steps: VecDeque::new(),
            accepted: Vec::new(),
            attempted: Vec::new(),
        };
        assert!(matches!(
            apply_launch_input(
                &mut rejected_writer,
                &mut rejected_descriptor,
                &descriptor_path,
                "launch_late",
                &payload_hash,
                b"hello",
                true,
            ),
            Err(KeeperRuntimeError::OutcomeUnknown(_))
        ));
        assert!(rejected_descriptor.launch_input.is_none());
        assert!(rejected_writer.attempted.is_empty());

        let oversized = vec![b'x'; kmux_compat::REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES + 1];
        assert!(matches!(
            apply_launch_input(
                &mut rejected_writer,
                &mut rejected_descriptor,
                &descriptor_path,
                "launch_oversized",
                &payload_hash,
                &oversized,
                false,
            ),
            Err(KeeperRuntimeError::Invalid(_))
        ));
        assert!(rejected_descriptor.launch_input.is_none());
        assert!(rejected_writer.attempted.is_empty());

        let blocked_parent = sandbox.path().join("not-a-directory");
        fs::write(&blocked_parent, b"fixture").unwrap();
        assert!(
            apply_launch_input(
                &mut rejected_writer,
                &mut rejected_descriptor,
                &blocked_parent.join("session.json"),
                "launch_unpersisted",
                &payload_hash,
                b"hello",
                false,
            )
            .is_err()
        );
        assert!(rejected_descriptor.launch_input.is_none());
        assert!(rejected_writer.attempted.is_empty());

        let mut child = ScriptedInputWriter {
            steps: VecDeque::from([
                InputWriteStep::Accept(2),
                InputWriteStep::Fail,
                InputWriteStep::Accept(3),
            ]),
            accepted: Vec::new(),
            attempted: Vec::new(),
        };

        let first = apply_launch_input(
            &mut child,
            &mut descriptor,
            &descriptor_path,
            "launch_1",
            &payload_hash,
            b"hello",
            false,
        );
        assert!(first.is_err());
        assert_eq!(child.accepted, b"he");

        descriptor = load_session_descriptor(&descriptor_path).unwrap();
        assert_eq!(
            descriptor.launch_input,
            Some(LaunchInputRecord {
                operation_id: "launch_1".to_owned(),
                payload_hash: payload_hash.clone(),
                byte_length: 5,
                written_offset: 2,
                outcome: LaunchInputOutcome::OutcomeUnknown,
            })
        );

        let retried = apply_launch_input(
            &mut child,
            &mut descriptor,
            &descriptor_path,
            "launch_1",
            &payload_hash,
            b"hello",
            false,
        )
        .unwrap();
        assert!(matches!(
            retried,
            KeeperRpcResponse::Result {
                outcome,
                written_offset: Some(5),
                ..
            } if outcome == "written"
        ));
        assert_eq!(child.accepted, b"hello");
        assert_eq!(
            child.attempted,
            [b"hello".to_vec(), b"llo".to_vec(), b"llo".to_vec()]
        );

        descriptor = load_session_descriptor(&descriptor_path).unwrap();
        let attempts_after_completion = child.attempted.len();
        apply_launch_input(
            &mut child,
            &mut descriptor,
            &descriptor_path,
            "launch_1",
            &payload_hash,
            b"hello",
            true,
        )
        .unwrap();
        assert_eq!(child.attempted.len(), attempts_after_completion);

        let mismatched = apply_launch_input(
            &mut child,
            &mut descriptor,
            &descriptor_path,
            "launch_2",
            &payload_hash,
            b"hello",
            false,
        );
        assert!(matches!(mismatched, Err(KeeperRuntimeError::Fenced(_))));
        assert_eq!(child.attempted.len(), attempts_after_completion);
        let preserved = load_session_descriptor(&descriptor_path).unwrap();
        assert_eq!(preserved.remote_resource_revision, "2");
        assert_eq!(
            preserved.lifecycle_state,
            SessionLifecycleState::Provisional
        );
        assert_eq!(
            preserved.conversion_transaction_id.as_deref(),
            Some("conversion_1")
        );
    }

    #[test]
    fn launch_input_is_not_reissued_when_only_completion_persistence_fails() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let descriptor_path = sandbox.path().join("session.json");
        let descriptor_backup = sandbox.path().join("session-backup.json");
        let mut descriptor = test_session_descriptor(sandbox.path());
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();
        let input = b"hello";
        let payload_hash = format!("{:x}", Sha256::digest(input));
        let mut child = SabotagingInputWriter {
            sabotage: Some(InputPersistenceSabotage::FileToDirectory {
                path: descriptor_path.clone(),
                backup: descriptor_backup,
            }),
            accepted: Vec::new(),
            attempted: Vec::new(),
        };

        assert!(
            apply_launch_input(
                &mut child,
                &mut descriptor,
                &descriptor_path,
                "launch_1",
                &payload_hash,
                input,
                false,
            )
            .is_err()
        );
        assert_eq!(child.accepted, input);
        assert_eq!(child.attempted, [input.to_vec()]);
        assert_eq!(
            descriptor
                .launch_input
                .as_ref()
                .map(|record| &record.outcome),
            Some(&LaunchInputOutcome::Written)
        );

        let attempts_after_completion = child.attempted.len();
        assert!(matches!(
            apply_launch_input(
                &mut child,
                &mut descriptor,
                &descriptor_path,
                "launch_1",
                &payload_hash,
                input,
                false,
            )
            .unwrap(),
            KeeperRpcResponse::Result {
                outcome,
                written_offset: Some(5),
                ..
            } if outcome == "written"
        ));
        assert_eq!(child.attempted.len(), attempts_after_completion);
        assert_eq!(child.accepted, input);
    }

    #[test]
    fn recovered_accepted_launch_input_is_never_reissued() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let descriptor_path = sandbox.path().join("session.json");
        let input = b"hello";
        let payload_hash = format!("{:x}", Sha256::digest(input));
        let mut descriptor = test_session_descriptor(sandbox.path());
        descriptor.launch_input = Some(LaunchInputRecord {
            operation_id: "launch_1".to_owned(),
            payload_hash: payload_hash.clone(),
            byte_length: input.len(),
            written_offset: 0,
            outcome: LaunchInputOutcome::Accepted,
        });
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();
        let mut child = ScriptedInputWriter {
            steps: VecDeque::from([InputWriteStep::Accept(input.len())]),
            accepted: Vec::new(),
            attempted: Vec::new(),
        };

        assert!(matches!(
            apply_launch_input(
                &mut child,
                &mut descriptor,
                &descriptor_path,
                "launch_1",
                &payload_hash,
                input,
                false,
            ),
            Err(KeeperRuntimeError::OutcomeUnknown(_))
        ));
        assert!(child.attempted.is_empty());
        assert!(child.accepted.is_empty());
    }

    #[test]
    fn synced_checkpoint_is_durable_before_journal_compaction() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let state_root = sandbox.path().join("state");
        let sessions = state_root.join("sessions");
        ensure_private_directory(&sessions).unwrap();
        let mut descriptor = test_session_descriptor(&sessions);
        let descriptor_path = session_descriptor_path(&state_root, &descriptor.resource_key);
        descriptor.journal_path = sessions
            .join("terminal.journal")
            .to_string_lossy()
            .into_owned();
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();
        let journal_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&descriptor.journal_path)
            .unwrap();
        let mut journal = MutationJournal::new(journal_file, Duration::ZERO);
        let resize = TerminalMutation::Resize {
            sequence: 1,
            cols: 100,
            rows: 40,
        };
        journal.append(&resize, Duration::ZERO).unwrap();
        journal.force_sync(Duration::from_millis(1)).unwrap();
        let parser = ParserWorker::start(80, 24, 8);
        assert!(parser.try_submit(resize));
        let checkpoint = parser.checkpoint(1).unwrap();

        let checkpoint_directory =
            retained_checkpoint_directory(&descriptor_path, &descriptor).unwrap();
        ensure_private_directory(&checkpoint_directory).unwrap();
        write_private_checkpoint_atomic(&checkpoint_directory.join("obsolete.checkpoint"), b"old")
            .unwrap();
        compact_synced_journal(
            &mut descriptor,
            &descriptor_path,
            &mut journal,
            &checkpoint,
            Duration::from_millis(2),
        )
        .unwrap();

        assert_eq!(journal.storage_len().unwrap(), 0);
        let durable = load_session_descriptor(&descriptor_path).unwrap();
        let record = durable.retained_checkpoint.as_ref().unwrap();
        assert_eq!(record.mutation_sequence, "1");
        assert_eq!(durable.truncated_before_sequence.as_deref(), Some("2"));
        assert_eq!(
            load_retained_checkpoint(&durable, &descriptor_path, record).unwrap(),
            checkpoint
        );
        assert!(!checkpoint_directory.join("obsolete.checkpoint").exists());

        journal
            .append(
                &TerminalMutation::Output {
                    sequence: 2,
                    data: b"after".to_vec(),
                },
                Duration::from_millis(3),
            )
            .unwrap();
        journal.force_sync(Duration::from_millis(4)).unwrap();
        drop(journal);
        let journal_bytes = fs::read(&durable.journal_path).unwrap();
        let recovery = kmux_journal::recover_journal_after(journal_bytes.as_slice(), 1).unwrap();
        assert_eq!(recovery.last_complete_sequence, 2);
        assert_eq!(recovery.mutations.len(), 1);
    }

    #[test]
    fn checkpoint_persistence_failure_never_removes_the_synced_journal() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let state_root = sandbox.path().join("state");
        let sessions = state_root.join("sessions");
        ensure_private_directory(&sessions).unwrap();
        let mut descriptor = test_session_descriptor(&sessions);
        let descriptor_path = session_descriptor_path(&state_root, &descriptor.resource_key);
        descriptor.journal_path = sessions
            .join("terminal.journal")
            .to_string_lossy()
            .into_owned();
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();
        let journal_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&descriptor.journal_path)
            .unwrap();
        let mut journal = MutationJournal::new(journal_file, Duration::ZERO);
        let resize = TerminalMutation::Resize {
            sequence: 1,
            cols: 80,
            rows: 24,
        };
        journal.append(&resize, Duration::ZERO).unwrap();
        journal.force_sync(Duration::from_millis(1)).unwrap();
        let original_bytes = fs::read(&descriptor.journal_path).unwrap();
        let parser = ParserWorker::start(80, 24, 8);
        assert!(parser.try_submit(resize));
        let checkpoint = parser.checkpoint(1).unwrap();
        fs::write(state_root.join("checkpoints"), b"blocked").unwrap();

        assert!(
            compact_synced_journal(
                &mut descriptor,
                &descriptor_path,
                &mut journal,
                &checkpoint,
                Duration::from_millis(2),
            )
            .is_err()
        );
        assert_eq!(fs::read(&descriptor.journal_path).unwrap(), original_bytes);
        assert!(
            load_session_descriptor(&descriptor_path)
                .unwrap()
                .retained_checkpoint
                .is_none()
        );
    }

    #[test]
    fn explicit_termination_removes_only_managed_resource_retained_data() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let state_root = sandbox.path().join("state");
        let runtime_root = sandbox.path().join("run");
        let roots = RemoteRuntimeRoots {
            install_root: sandbox
                .path()
                .join("install")
                .to_string_lossy()
                .into_owned(),
            authority_root: sandbox
                .path()
                .join("authority")
                .to_string_lossy()
                .into_owned(),
            state_root: state_root.to_string_lossy().into_owned(),
            runtime_root: runtime_root.to_string_lossy().into_owned(),
        };
        prepare_runtime_directories(&roots).unwrap();
        let descriptor_path = session_descriptor_path(
            &state_root,
            &RemoteResourceKey {
                desktop_installation_id: "desktop_1".to_owned(),
                target_id: "target_1".to_owned(),
                workspace_id: "workspace_1".to_owned(),
                session_id: Some("session_1".to_owned()),
            },
        );
        let mut descriptor = test_session_descriptor(&state_root.join("sessions"));
        descriptor.journal_path = session_journal_path(
            &state_root,
            &descriptor.resource_key,
            &descriptor.keeper_generation,
        )
        .to_string_lossy()
        .into_owned();
        descriptor.state = SessionDescriptorState::Terminated;
        descriptor.exit_code = Some(0);
        descriptor.truncated_before_sequence = Some("3".to_owned());
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();

        let write_private = |path: &Path, bytes: &[u8]| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .unwrap();
            file.write_all(bytes).unwrap();
            file.sync_all().unwrap();
        };
        write_private(Path::new(&descriptor.journal_path), b"current");
        let digest = resource_key_digest(&descriptor.resource_key);
        let prior_journal = state_root
            .join("journals")
            .join(format!("{}-prior123.journal", &digest[..24]));
        write_private(&prior_journal, b"prior");
        let unrelated_journal = state_root.join("journals").join("unrelated.journal");
        write_private(&unrelated_journal, b"keep");

        let checkpoint_resource =
            retained_checkpoint_resource_directory(&descriptor_path, &descriptor).unwrap();
        ensure_private_directory(&checkpoint_resource).unwrap();
        for generation in ["keeper_old", descriptor.keeper_generation.as_str()] {
            let directory = checkpoint_resource.join(generation);
            ensure_private_directory(&directory).unwrap();
            write_private(&directory.join("current.json"), b"checkpoint");
        }
        let operation_directory = operation_input_directory(&descriptor_path).unwrap();
        ensure_private_directory(&operation_directory).unwrap();
        write_private(&operation_directory.join("record.json"), b"operation");

        cleanup_terminated_retained_data(&descriptor, &descriptor_path).unwrap();

        assert!(descriptor_path.exists());
        assert!(!Path::new(&descriptor.journal_path).exists());
        assert!(!prior_journal.exists());
        assert!(unrelated_journal.exists());
        assert!(!checkpoint_resource.exists());
        assert!(!operation_directory.exists());
    }

    #[test]
    fn terminated_cleanup_rejects_an_unmanaged_journal_path_without_deleting_it() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let state_root = sandbox.path().join("state");
        let roots = RemoteRuntimeRoots {
            install_root: sandbox
                .path()
                .join("install")
                .to_string_lossy()
                .into_owned(),
            authority_root: sandbox
                .path()
                .join("authority")
                .to_string_lossy()
                .into_owned(),
            state_root: state_root.to_string_lossy().into_owned(),
            runtime_root: sandbox.path().join("run").to_string_lossy().into_owned(),
        };
        prepare_runtime_directories(&roots).unwrap();
        let mut descriptor = test_session_descriptor(&state_root.join("sessions"));
        descriptor.state = SessionDescriptorState::Terminated;
        descriptor.exit_code = Some(0);
        descriptor.truncated_before_sequence = Some("2".to_owned());
        let unmanaged = sandbox.path().join("unmanaged.journal");
        fs::write(&unmanaged, b"must remain").unwrap();
        descriptor.journal_path = unmanaged.to_string_lossy().into_owned();
        let descriptor_path = session_descriptor_path(&state_root, &descriptor.resource_key);

        assert!(cleanup_terminated_retained_data(&descriptor, &descriptor_path).is_err());
        assert_eq!(fs::read(unmanaged).unwrap(), b"must remain");
    }

    #[test]
    fn retention_quota_uses_ninety_to_seventy_five_percent_hysteresis() {
        let policy = RemoteRetentionPolicy::default();
        let mut state = RetentionQuotaState::default();
        state.observe_usage(
            quota_percent(
                policy.session_quota_bytes(),
                RETENTION_CLEANUP_START_PERCENT,
            ),
            0,
            policy,
        );
        assert!(state.pressure_active);
        assert!(state.backpressured);

        state.observe_usage(quota_percent(policy.session_quota_bytes(), 80), 0, policy);
        assert!(state.pressure_active);
        state.observe_usage(
            quota_percent(policy.session_quota_bytes(), RETENTION_CLEANUP_STOP_PERCENT),
            0,
            policy,
        );
        assert!(!state.pressure_active);
        assert!(!state.backpressured);
    }

    #[test]
    fn target_retention_prunes_oldest_exited_data_to_low_watermark_and_on_full_storage() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let state_root = sandbox.path().join("state");
        let roots = RemoteRuntimeRoots {
            install_root: sandbox
                .path()
                .join("install")
                .to_string_lossy()
                .into_owned(),
            authority_root: sandbox
                .path()
                .join("authority")
                .to_string_lossy()
                .into_owned(),
            state_root: state_root.to_string_lossy().into_owned(),
            runtime_root: sandbox.path().join("run").to_string_lossy().into_owned(),
        };
        prepare_runtime_directories(&roots).unwrap();
        let policy = RemoteRetentionPolicy {
            session_quota_mib: 64,
            target_quota_mib: 256,
        };
        let (old_path, old_checkpoints, old_journal) = write_retained_exited_session(
            &state_root,
            "workspace_old",
            "session_old",
            "keeper_old",
            "2026-07-17T00:00:00.000Z",
            120 * 1024 * 1024,
            policy,
        );
        let (new_path, new_checkpoints, new_journal) = write_retained_exited_session(
            &state_root,
            "workspace_new",
            "session_new",
            "keeper_new",
            "2026-07-18T00:00:00.000Z",
            120 * 1024 * 1024,
            policy,
        );
        let mut current = test_session_descriptor(&state_root.join("sessions"));
        current.resource_key.workspace_id = "workspace_current".to_owned();
        current.resource_key.session_id = Some("session_current".to_owned());
        current.keeper_generation = "keeper_current".to_owned();
        current.retention_policy = policy;
        current.journal_path = session_journal_path(
            &state_root,
            &current.resource_key,
            &current.keeper_generation,
        )
        .to_string_lossy()
        .into_owned();
        let current_path = session_descriptor_path(&state_root, &current.resource_key);
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&current.journal_path)
            .unwrap()
            .sync_all()
            .unwrap();
        write_session_descriptor(&current_path, &current).unwrap();

        let remaining =
            prune_oldest_eligible_target_retention(&current, &current_path, false).unwrap();
        assert!(remaining <= quota_percent(policy.target_quota_bytes(), 75));
        let old = load_session_descriptor(&old_path).unwrap();
        assert!(old.retained_checkpoint.is_none());
        assert_eq!(old.truncated_before_sequence.as_deref(), Some("2"));
        assert_eq!(old.storage_status.state, RemoteSessionStorageState::Normal);
        assert!(!old_checkpoints.exists());
        assert!(!old_journal.exists());
        assert!(
            load_session_descriptor(&new_path)
                .unwrap()
                .retained_checkpoint
                .is_some()
        );
        assert!(new_checkpoints.exists());
        assert!(new_journal.exists());

        prune_oldest_eligible_target_retention(&current, &current_path, true).unwrap();
        assert!(
            load_session_descriptor(&new_path)
                .unwrap()
                .retained_checkpoint
                .is_none()
        );
        assert!(!new_checkpoints.exists());
        assert!(!new_journal.exists());
    }

    #[test]
    fn target_retention_recovers_only_durable_gc_intents() {
        let sandbox = tempfile::TempDir::new().unwrap();
        let state_root = sandbox.path().join("state");
        let roots = RemoteRuntimeRoots {
            install_root: sandbox
                .path()
                .join("install")
                .to_string_lossy()
                .into_owned(),
            authority_root: sandbox
                .path()
                .join("authority")
                .to_string_lossy()
                .into_owned(),
            state_root: state_root.to_string_lossy().into_owned(),
            runtime_root: sandbox.path().join("run").to_string_lossy().into_owned(),
        };
        prepare_runtime_directories(&roots).unwrap();
        let policy = RemoteRetentionPolicy {
            session_quota_mib: 64,
            target_quota_mib: 256,
        };
        let (intent_path, intent_checkpoints, intent_journal) = write_retained_exited_session(
            &state_root,
            "workspace_intent",
            "session_intent",
            "keeper_intent",
            "2026-07-17T00:00:00.000Z",
            1024 * 1024,
            policy,
        );
        let intent_descriptor = load_session_descriptor(&intent_path).unwrap();
        write_retention_gc_intent(&intent_descriptor, &intent_path).unwrap();

        let mut journal_only = test_session_descriptor(&state_root.join("sessions"));
        journal_only.resource_key.workspace_id = "workspace_journal".to_owned();
        journal_only.resource_key.session_id = Some("session_journal".to_owned());
        journal_only.keeper_generation = "keeper_journal".to_owned();
        journal_only.state = SessionDescriptorState::Exited;
        journal_only.exit_code = Some(0);
        journal_only.retention_policy = policy;
        journal_only.truncated_before_sequence = Some("2".to_owned());
        journal_only.storage_status.state = RemoteSessionStorageState::Degraded;
        journal_only.journal_path = session_journal_path(
            &state_root,
            &journal_only.resource_key,
            &journal_only.keeper_generation,
        )
        .to_string_lossy()
        .into_owned();
        let journal_only_path = session_descriptor_path(&state_root, &journal_only.resource_key);
        let mut journal_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&journal_only.journal_path)
            .unwrap();
        journal_file.write_all(b"authoritative journal").unwrap();
        journal_file.sync_all().unwrap();
        write_session_descriptor(&journal_only_path, &journal_only).unwrap();

        let mut current = test_session_descriptor(&state_root.join("sessions"));
        current.resource_key.workspace_id = "workspace_current".to_owned();
        current.resource_key.session_id = Some("session_current".to_owned());
        current.keeper_generation = "keeper_current".to_owned();
        current.retention_policy = policy;
        current.journal_path = session_journal_path(
            &state_root,
            &current.resource_key,
            &current.keeper_generation,
        )
        .to_string_lossy()
        .into_owned();
        let current_path = session_descriptor_path(&state_root, &current.resource_key);
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&current.journal_path)
            .unwrap()
            .sync_all()
            .unwrap();
        write_session_descriptor(&current_path, &current).unwrap();

        target_retained_bytes(&current, &current_path).unwrap();

        assert!(
            load_session_descriptor(&intent_path)
                .unwrap()
                .retained_checkpoint
                .is_none()
        );
        assert!(!intent_checkpoints.exists());
        assert!(!intent_journal.exists());
        assert!(!has_retention_gc_intent(&intent_descriptor, &intent_path).unwrap());
        assert!(Path::new(&journal_only.journal_path).exists());
        assert_eq!(
            fs::read(&journal_only.journal_path).unwrap(),
            b"authoritative journal"
        );
        assert_eq!(
            load_session_descriptor(&journal_only_path)
                .unwrap()
                .storage_status
                .state,
            RemoteSessionStorageState::Degraded
        );
    }

    #[test]
    fn emergency_mutation_buffer_is_hard_bounded_at_four_mebibytes() {
        let mut emergency = EmergencyMutationBuffer::default();
        emergency
            .push(TerminalMutation::Output {
                sequence: 1,
                data: vec![b'x'; MAX_EMERGENCY_MUTATION_BYTES - 32],
            })
            .unwrap();
        assert_eq!(emergency.bytes, MAX_EMERGENCY_MUTATION_BYTES);
        assert_eq!(emergency.max_safe_output_read(16 * 1024), 0);
        assert!(matches!(
            emergency.push(TerminalMutation::Resize {
                sequence: 2,
                cols: 80,
                rows: 24,
            }),
            Err(KeeperRuntimeError::Retryable(_))
        ));
    }
}
