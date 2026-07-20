use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kmux_compat::{
    AttachAuthorizedResponse, AttachmentAccess, BridgeRequest, BridgeRequestEnvelope,
    BridgeResponseBody, BridgeResponseEnvelope, BridgeResponseStatus, CohortProxyRequest,
    CohortProxyResponse, ConversionPreparedResponse, ConversionPromotedResponse,
    DesiredForwardResponse, EventsAcknowledgedResponse, EventsReplayedResponse,
    ForwardsObservedResponse, GitInspectedResponse, GitRepositoryResponse, HelloResponse,
    HistoryScannedResponse, KeeperAttachRequest, ObservedKeeper, ObservedResponse,
    ObservedWorkspace, OperationResult, PortsInspectedResponse, ProvisionalReclaimedResponse,
    REMOTE_PROTOCOL_VERSION, RemoteAuthority, RemoteControlError, RemoteFrameKind,
    RemoteHistoryRecord, RemoteOperationIntent, RemoteOperationPayload, RemotePersistenceLevel,
    RemotePrincipal, RemoteResourceKey, RemoteRetentionPolicy, RemoteRuntimeRoots,
    RemoteSessionLaunchPayload, RemoteSessionStorageStatus, RemoteSpoolEvent, RemoteUsageRecord,
    SurfaceCaptureChunkResponse, SurfaceCaptureCompletedResponse, TerminalInputAckResponse,
    TerminalProxyEndpoint, UsageScannedResponse, read_control, read_remote_frame, write_control,
};
use kmux_doctor::{DoctorPaths, run_doctor};
use kmux_hook::{
    SessionControlEndpoint, acknowledge_events, replay_events, write_session_control_endpoint,
};
use kmux_keeper::{
    ATTACH_CAPABILITY_TTL, KeeperCaptureRequest, KeeperLaunchConfig, KeeperOperationInputRequest,
    KeeperRpcResponse, LaunchInputOutcome, SESSION_DESCRIPTOR_VERSION, SURFACE_CAPTURE_CHUNK_BYTES,
    SessionDescriptor, SessionDescriptorState, SessionLifecycleState,
    cleanup_terminated_retained_data, invoke_keeper_capture, invoke_keeper_rpc,
    load_session_descriptor, new_attach_capability, now_rfc3339, prepare_runtime_directories,
    resource_key_digest, session_descriptor_path, session_journal_path, write_attach_capability,
    write_session_descriptor,
};
use kmux_metadata::{scan_external_history, scan_external_usage};
use kmux_platform::{
    current_authenticated_home, current_authenticated_principal, effective_uid, spawn_detached,
    spawn_reparented,
};
use nix::errno::Errno;
use nix::fcntl::{Flock, FlockArg, OFlag};
use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const MAX_BRIDGE_TOKEN_RECORD_BYTES: u64 = 64 * 1024;
const MAX_BRIDGE_TOKEN_ROTATION_BYTES: u64 = 64 * 1024;
const MAX_SCOPED_BRIDGE_TOKENS: usize = 256;
const MAX_REMOTE_RUNTIME_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_RUNTIME_EXECUTABLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SESSION_DESCRIPTORS: usize = 4096;
const KEEPER_START_TIMEOUT: Duration = Duration::from_secs(10);
const RESOURCE_LOCK_TIMEOUT: Duration = Duration::from_secs(10);
const COHORT_START_TIMEOUT: Duration = Duration::from_secs(10);
const COHORT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const COHORT_LIVENESS_INTERVAL: Duration = Duration::from_secs(1);
const MAX_COHORT_CAPABILITIES: usize = 1024;
const MAX_COHORT_CONNECTIONS: usize = 1024;
const MAX_CONVERSION_SNAPSHOT_BYTES: usize = 128 * 1024;
const MAX_CONVERSION_SNAPSHOTS: usize = 4_096;
const MAX_PROTECTED_CONVERSIONS: usize = 64;
const PROVISIONAL_TTL_MILLIS: u64 = 24 * 60 * 60 * 1_000;
const MAX_GIT_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_GIT_DIRTY_ENTRIES: usize = 256;
const MAX_GIT_ARGUMENT_BYTES: usize = 32 * 1024;
const MAX_OPERATION_MESSAGE_BYTES: usize = 4 * 1024;
const SYSTEM_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_TERMINATION_GRACE: Duration = Duration::from_millis(500);
const COMMAND_WAIT_POLL: Duration = Duration::from_millis(10);
const MAX_PORT_INSPECTION_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_INSPECTED_PORTS: usize = 64;
const MAX_DESIRED_FORWARDS: usize = 4_096;

#[derive(Debug, Error)]
pub enum BridgeRuntimeError {
    #[error("bridge I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("bridge wire failed: {0}")]
    Wire(#[from] kmux_compat::RemoteWireError),
    #[error("bridge JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("bridge doctor failed: {0}")]
    Doctor(#[from] kmux_doctor::DoctorError),
    #[error("bridge keeper failed: {0}")]
    Keeper(#[from] kmux_keeper::KeeperRuntimeError),
    #[error("bridge hook spool failed: {0}")]
    Hook(#[from] kmux_hook::HookError),
    #[error("bridge request is invalid: {0}")]
    Invalid(String),
    #[error("bridge operation is temporarily unavailable: {0}")]
    Retryable(String),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyBridgeTokenRecord {
    version: u16,
    token_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScopedBridgeTokenRecord {
    version: u16,
    roots: RemoteRuntimeRoots,
    desktop_installation_id: String,
    target_id: String,
    token_sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeTokenRotationRequest {
    version: u16,
    roots: RemoteRuntimeRoots,
    desktop_installation_id: String,
    target_id: String,
    token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeTokenRotationResponse {
    version: u16,
    status: &'static str,
}

#[derive(Clone, Debug)]
struct BridgeTokenScope {
    desktop_installation_id: String,
    target_id: String,
}

#[derive(Clone, Debug)]
struct VerifiedBridgeToken {
    scope: Option<BridgeTokenScope>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceDescriptor {
    version: u16,
    resource_key: RemoteResourceKey,
    create_operation_id: String,
    canonical_create_payload_hash: String,
    create_result_digest: String,
    remote_resource_revision: String,
    last_operation_id: String,
    last_operation_payload_hash: String,
    last_result_digest: String,
    state: String,
    updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conversion_transaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote_snapshot_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provisional_created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_workspace_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_operation: Option<WorkspacePendingOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    failed_operation: Option<WorkspaceFailedOperation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspacePendingOperation {
    operation_id: String,
    kind: String,
    canonical_payload_hash: String,
    next_remote_resource_revision: String,
    result_digest: String,
    payload: RemoteOperationPayload,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceFailedOperation {
    operation_id: String,
    kind: String,
    canonical_payload_hash: String,
    result_digest: String,
    code: String,
    message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesiredForwardDescriptor {
    version: u16,
    resource_key: RemoteResourceKey,
    forward_id: String,
    remote_host: String,
    remote_port: u16,
    local_bind_host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    local_port: Option<u16>,
    operation_id: String,
    remote_resource_revision: String,
    updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConversionSnapshotRecord {
    version: u16,
    transaction_id: String,
    remote_snapshot_hash: String,
    payload: String,
    written_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteRuntimeArtifactManifest {
    schema_version: u16,
    target: String,
    platform: String,
    arch: String,
    abi: String,
    runtime_version: String,
    remote_protocol_min: u16,
    remote_protocol_max: u16,
    keeper_local_protocol_major: u16,
    terminal_wire_version: u16,
    executable: String,
    sha256: String,
    bytes: u64,
    signed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeeperHealthRequest<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    keeper_generation: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeeperLaunchInputRequest<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    keeper_generation: &'a str,
    operation_id: &'a str,
    payload_hash: &'a str,
    input: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeeperTerminateRequest<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    keeper_generation: &'a str,
    operation_id: &'a str,
    payload_hash: &'a str,
    next_remote_resource_revision: &'a str,
    result_digest: &'a str,
}

#[derive(Clone, Debug)]
struct BridgeConnectionBinding {
    roots: RemoteRuntimeRoots,
    retention_policy: RemoteRetentionPolicy,
    token_sha256: String,
    token_scope: Option<BridgeTokenScope>,
    desktop_installation_id: Option<String>,
    target_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CohortProxyServeOptions {
    pub socket_path: PathBuf,
    pub state_root: PathBuf,
    pub runtime_root: PathBuf,
    pub target_id: String,
    pub executable_generation: String,
    pub keeper_local_protocol_major: u16,
}

#[derive(Clone, Debug)]
struct CohortAttachCapability {
    roots: RemoteRuntimeRoots,
    resource_key: RemoteResourceKey,
    keeper_generation: String,
    expires_at_unix_ms: u64,
    access: AttachmentAccess,
}

struct CohortProxyState {
    options: CohortProxyServeOptions,
    capabilities: Mutex<BTreeMap<String, CohortAttachCapability>>,
}

enum BridgeHandledResponse {
    Single(BridgeResponseBody),
    Capture(kmux_keeper::KeeperCaptureResult),
}

pub fn run_bridge_server(
    mut reader: impl Read,
    mut writer: impl Write,
) -> Result<(), BridgeRuntimeError> {
    let bridge_generation = format!("bridge_{}", Uuid::new_v4());
    let executable = std::env::current_exe()?;
    let mut connection_binding: Option<BridgeConnectionBinding> = None;
    loop {
        let frame = match read_remote_frame(&mut reader)? {
            Some(frame) => frame,
            None => return Ok(()),
        };
        if frame.kind != RemoteFrameKind::Control {
            return Err(BridgeRuntimeError::Invalid(
                "bridge accepts only control frames".to_owned(),
            ));
        }
        let request: BridgeRequestEnvelope = serde_json::from_slice(&frame.payload)?;
        let request_id = request.request_id.clone();
        let initial_roots = request.roots.clone();
        let initial_retention_policy = request.retention_policy;
        let initial_token_sha256 = format!("{:x}", Sha256::digest(request.token.as_bytes()));
        let scope = bridge_request_scope(&request.request)
            .map(|(desktop, target)| (desktop.to_owned(), target.to_owned()));
        let request_result = validate_bridge_connection_binding(&connection_binding, &request)
            .and_then(|()| {
                handle_request(
                    request,
                    &bridge_generation,
                    &executable,
                    connection_binding.as_ref(),
                )
            });
        let request_result = match request_result {
            Ok((response, verified)) => {
                if connection_binding.is_none() {
                    let token_scope = verified.scope;
                    let desktop_installation_id = token_scope
                        .as_ref()
                        .map(|scope| scope.desktop_installation_id.clone());
                    let target_id = token_scope.as_ref().map(|scope| scope.target_id.clone());
                    connection_binding = Some(BridgeConnectionBinding {
                        roots: initial_roots,
                        retention_policy: initial_retention_policy,
                        token_sha256: initial_token_sha256,
                        token_scope,
                        desktop_installation_id,
                        target_id,
                    });
                }
                update_bridge_connection_binding(
                    &mut connection_binding,
                    scope
                        .as_ref()
                        .map(|(desktop, target)| (desktop.as_str(), target.as_str())),
                );
                Ok(response)
            }
            Err(error) => Err(error),
        };
        write_bridge_response(&mut writer, &request_id, request_result)?;
    }
}

fn write_bridge_response(
    writer: &mut impl Write,
    request_id: &str,
    result: Result<BridgeHandledResponse, BridgeRuntimeError>,
) -> Result<(), BridgeRuntimeError> {
    match result {
        Ok(BridgeHandledResponse::Single(body)) => write_control(
            writer,
            &BridgeResponseEnvelope {
                protocol_version: REMOTE_PROTOCOL_VERSION,
                request_id: request_id.to_owned(),
                status: BridgeResponseStatus::Ok,
                body: Some(body),
                error: None,
            },
        )?,
        Ok(BridgeHandledResponse::Capture(capture)) => {
            let chunks = utf8_chunks(&capture.text, SURFACE_CAPTURE_CHUNK_BYTES);
            for (index, text) in chunks.iter().enumerate() {
                write_control(
                    writer,
                    &BridgeResponseEnvelope {
                        protocol_version: REMOTE_PROTOCOL_VERSION,
                        request_id: request_id.to_owned(),
                        status: BridgeResponseStatus::Ok,
                        body: Some(BridgeResponseBody::SurfaceCaptureChunk(
                            SurfaceCaptureChunkResponse {
                                capture_id: capture.capture_id.clone(),
                                index,
                                text: (*text).to_owned(),
                            },
                        )),
                        error: None,
                    },
                )?;
            }
            let chunk_count = chunks.len();
            drop(chunks);
            let byte_length = capture.text.len();
            let sha256 = format!("{:x}", Sha256::digest(capture.text.as_bytes()));
            write_control(
                writer,
                &BridgeResponseEnvelope {
                    protocol_version: REMOTE_PROTOCOL_VERSION,
                    request_id: request_id.to_owned(),
                    status: BridgeResponseStatus::Ok,
                    body: Some(BridgeResponseBody::SurfaceCaptureCompleted(
                        SurfaceCaptureCompletedResponse {
                            capture_id: capture.capture_id,
                            resource_key: capture.resource_key,
                            keeper_generation: capture.keeper_generation,
                            mutation_sequence: capture.mutation_sequence.to_string(),
                            cols: capture.cols,
                            rows: capture.rows,
                            line_count: capture.line_count,
                            byte_length,
                            chunk_count,
                            sha256,
                            lines_truncated: capture.lines_truncated,
                            bytes_truncated: capture.bytes_truncated,
                            retained_range_truncated: capture.retained_range_truncated,
                        },
                    )),
                    error: None,
                },
            )?;
        }
        Err(error) => write_control(
            writer,
            &BridgeResponseEnvelope {
                protocol_version: REMOTE_PROTOCOL_VERSION,
                request_id: request_id.to_owned(),
                status: BridgeResponseStatus::Error,
                body: None,
                error: Some(to_control_error(&error)),
            },
        )?,
    }
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

fn bridge_request_scope(request: &BridgeRequest) -> Option<(&str, &str)> {
    match request {
        BridgeRequest::Hello {} => None,
        BridgeRequest::OperationExecute { intent, .. } => Some((
            &intent.resource_key.desktop_installation_id,
            &intent.resource_key.target_id,
        )),
        BridgeRequest::Observe {
            desktop_installation_id,
            target_id,
        }
        | BridgeRequest::ForwardsObserve {
            desktop_installation_id,
            target_id,
        } => Some((desktop_installation_id, target_id)),
        BridgeRequest::GitInspect {
            desktop_installation_id,
            target_id,
            ..
        }
        | BridgeRequest::HistoryScan {
            desktop_installation_id,
            target_id,
            ..
        }
        | BridgeRequest::UsageScan {
            desktop_installation_id,
            target_id,
            ..
        } => Some((desktop_installation_id, target_id)),
        BridgeRequest::PortsInspect { resource_key } => Some((
            &resource_key.desktop_installation_id,
            &resource_key.target_id,
        )),
        BridgeRequest::AttachAuthorize { resource_key, .. } => Some((
            &resource_key.desktop_installation_id,
            &resource_key.target_id,
        )),
        BridgeRequest::TerminalInject { resource_key, .. }
        | BridgeRequest::SurfaceCapture { resource_key, .. } => Some((
            &resource_key.desktop_installation_id,
            &resource_key.target_id,
        )),
        BridgeRequest::EventsReplay {
            desktop_installation_id,
            target_id,
            ..
        }
        | BridgeRequest::EventsAck {
            desktop_installation_id,
            target_id,
            ..
        } => Some((desktop_installation_id, target_id)),
        BridgeRequest::ConversionPrepare {
            workspace_resource_key,
            ..
        }
        | BridgeRequest::ConversionPromote {
            workspace_resource_key,
            ..
        } => Some((
            &workspace_resource_key.desktop_installation_id,
            &workspace_resource_key.target_id,
        )),
        BridgeRequest::ProvisionalReclaim {
            desktop_installation_id,
            target_id,
            ..
        } => Some((desktop_installation_id, target_id)),
    }
}

fn validate_bridge_connection_binding(
    binding: &Option<BridgeConnectionBinding>,
    envelope: &BridgeRequestEnvelope,
) -> Result<(), BridgeRuntimeError> {
    let Some(binding) = binding else {
        if !matches!(&envelope.request, BridgeRequest::Hello {}) {
            return Err(BridgeRuntimeError::Invalid(
                "bridge hello is required before scoped requests".to_owned(),
            ));
        }
        return Ok(());
    };
    let token_sha256 = format!("{:x}", Sha256::digest(envelope.token.as_bytes()));
    if envelope.roots != binding.roots
        || envelope.retention_policy != binding.retention_policy
        || token_sha256 != binding.token_sha256
    {
        return Err(BridgeRuntimeError::Invalid(
            "bridge connection roots, retention policy, or token changed".to_owned(),
        ));
    }
    if let Some((desktop_installation_id, target_id)) = bridge_request_scope(&envelope.request)
        && (binding
            .desktop_installation_id
            .as_deref()
            .is_some_and(|bound| bound != desktop_installation_id)
            || binding
                .target_id
                .as_deref()
                .is_some_and(|bound| bound != target_id))
    {
        return Err(BridgeRuntimeError::Invalid(
            "bridge connection target scope changed".to_owned(),
        ));
    }
    Ok(())
}

fn update_bridge_connection_binding(
    binding: &mut Option<BridgeConnectionBinding>,
    scope: Option<(&str, &str)>,
) {
    let binding = binding
        .as_mut()
        .expect("a successful request establishes the bridge binding");
    if let Some((desktop_installation_id, target_id)) = scope {
        binding
            .desktop_installation_id
            .get_or_insert_with(|| desktop_installation_id.to_owned());
        binding
            .target_id
            .get_or_insert_with(|| target_id.to_owned());
    }
}

pub fn open_keeper_proxy(
    request: &kmux_compat::KeeperAttachRequest,
) -> Result<UnixStream, BridgeRuntimeError> {
    if request.message_type != "keeper.attach"
        || request.protocol_version != REMOTE_PROTOCOL_VERSION
        || request.resource_key.session_id.is_none()
    {
        return Err(BridgeRuntimeError::Invalid(
            "keeper attach request is invalid".to_owned(),
        ));
    }
    validate_roots(&request.roots)?;
    let descriptor_path =
        session_descriptor_path(Path::new(&request.roots.state_root), &request.resource_key);
    let descriptor = load_session_descriptor(&descriptor_path)?;
    if descriptor.resource_key != request.resource_key
        || descriptor.keeper_generation != request.keeper_generation
        || descriptor.state != SessionDescriptorState::Running
        || descriptor.keeper_local_protocol_major != kmux_compat::KEEPER_LOCAL_PROTOCOL_MAJOR
        || descriptor.terminal_wire_version != kmux_compat::TERMINAL_WIRE_VERSION
    {
        return Err(BridgeRuntimeError::Invalid(
            "keeper attach generation is unavailable".to_owned(),
        ));
    }
    let mut stream = UnixStream::connect(&descriptor.socket_path)?;
    write_control(&mut stream, request)?;
    Ok(stream)
}

pub fn run_cohort_proxy_server(options: CohortProxyServeOptions) -> Result<(), BridgeRuntimeError> {
    validate_id(&options.target_id, "targetId")?;
    if !is_sha256(&options.executable_generation)
        || options.keeper_local_protocol_major != kmux_compat::KEEPER_LOCAL_PROTOCOL_MAJOR
    {
        return Err(BridgeRuntimeError::Invalid(
            "cohort proxy executable identity is invalid".to_owned(),
        ));
    }
    let executable = std::env::current_exe()?.canonicalize()?;
    if hash_file(&executable)? != options.executable_generation {
        return Err(BridgeRuntimeError::Invalid(
            "cohort proxy executable hash changed".to_owned(),
        ));
    }
    if !options.state_root.is_absolute()
        || !options.runtime_root.is_absolute()
        || !options.socket_path.is_absolute()
        || options.socket_path.parent() != Some(&options.runtime_root.join("cohorts"))
        || options.socket_path.as_os_str().as_encoded_bytes().len() > 103
    {
        return Err(BridgeRuntimeError::Invalid(
            "cohort proxy paths are invalid".to_owned(),
        ));
    }
    ensure_private_directory(&options.state_root)?;
    ensure_private_directory(&options.runtime_root)?;
    ensure_private_directory(&options.runtime_root.join("cohorts"))?;
    let listener = UnixListener::bind(&options.socket_path)?;
    fs::set_permissions(&options.socket_path, fs::Permissions::from_mode(0o600))?;
    let _socket_guard = CohortSocketGuard(options.socket_path.clone());
    let state = Arc::new(CohortProxyState {
        options,
        capabilities: Mutex::new(BTreeMap::new()),
    });
    let connections = Arc::new(AtomicUsize::new(0));
    let shutdown = Arc::new(AtomicBool::new(false));
    let monitor_shutdown = Arc::clone(&shutdown);
    let monitor_state = Arc::clone(&state);
    let monitor_socket_path = state.options.socket_path.clone();
    let monitor = thread::Builder::new()
        .name("kmux-cohort-liveness".to_owned())
        .spawn(move || {
            loop {
                thread::sleep(COHORT_LIVENESS_INTERVAL);
                if monitor_shutdown.load(Ordering::Acquire) {
                    return;
                }
                match cohort_has_live_keeper(&monitor_state.options) {
                    Ok(true) | Err(_) => {}
                    Ok(false) => {
                        monitor_shutdown.store(true, Ordering::Release);
                        let _ = UnixStream::connect(&monitor_socket_path);
                        return;
                    }
                }
            }
        })?;
    let result = loop {
        let (stream, _) = match listener.accept() {
            Ok(connection) => connection,
            Err(error) => break Err(error.into()),
        };
        if shutdown.load(Ordering::Acquire) {
            break Ok(());
        }
        if connections
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < MAX_COHORT_CONNECTIONS).then_some(current + 1)
            })
            .is_err()
        {
            drop(stream);
            continue;
        }
        let state = Arc::clone(&state);
        let connections_for_thread = Arc::clone(&connections);
        if thread::Builder::new()
            .name("kmux-cohort-proxy".to_owned())
            .spawn(move || {
                let _permit = CohortConnectionPermit(connections_for_thread);
                let _ = handle_cohort_proxy_connection(stream, &state);
            })
            .is_err()
        {
            connections.fetch_sub(1, Ordering::AcqRel);
        }
    };
    shutdown.store(true, Ordering::Release);
    let _ = monitor.join();
    result
}

fn cohort_has_live_keeper(options: &CohortProxyServeOptions) -> Result<bool, BridgeRuntimeError> {
    let directory = options.state_root.join("sessions");
    let entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    if entries.len() > MAX_SESSION_DESCRIPTORS.saturating_mul(2) {
        return Err(BridgeRuntimeError::Invalid(
            "cohort session inventory exceeds its hard bound".to_owned(),
        ));
    }
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let descriptor = load_session_descriptor(&path)?;
        if descriptor.resource_key.target_id != options.target_id
            || descriptor.keeper_local_protocol_major != options.keeper_local_protocol_major
        {
            continue;
        }
        match descriptor.state {
            SessionDescriptorState::Creating => return Ok(true),
            SessionDescriptorState::Running => {
                // A keeper can die before it commits an exited descriptor. A
                // stale `running` record must not pin its old executable
                // cohort forever once that process is authoritatively gone.
                if !keeper_process_is_definitively_absent(&descriptor)? {
                    return Ok(true);
                }
            }
            SessionDescriptorState::Exited | SessionDescriptorState::Terminated => {}
        }
    }
    Ok(false)
}

pub fn open_cohort_proxy(
    socket_path: &Path,
    request: &KeeperAttachRequest,
) -> Result<UnixStream, BridgeRuntimeError> {
    if !socket_path.is_absolute() || socket_path.as_os_str().as_encoded_bytes().len() > 103 {
        return Err(BridgeRuntimeError::Invalid(
            "cohort proxy socket path is invalid".to_owned(),
        ));
    }
    let mut stream = UnixStream::connect(socket_path)?;
    stream.set_read_timeout(Some(COHORT_CONNECT_TIMEOUT))?;
    stream.set_write_timeout(Some(COHORT_CONNECT_TIMEOUT))?;
    write_control(
        &mut stream,
        &CohortProxyRequest::Attach {
            request: request.clone(),
        },
    )?;
    match read_control(&mut stream)? {
        Some(CohortProxyResponse::Attached {}) => {
            stream.set_read_timeout(None)?;
            stream.set_write_timeout(None)?;
            Ok(stream)
        }
        Some(CohortProxyResponse::Error { message, .. }) => {
            Err(BridgeRuntimeError::Invalid(message))
        }
        _ => Err(BridgeRuntimeError::Invalid(
            "cohort proxy returned an invalid attach response".to_owned(),
        )),
    }
}

fn handle_cohort_proxy_connection(
    mut stream: UnixStream,
    state: &CohortProxyState,
) -> Result<(), BridgeRuntimeError> {
    stream.set_read_timeout(Some(COHORT_CONNECT_TIMEOUT))?;
    stream.set_write_timeout(Some(COHORT_CONNECT_TIMEOUT))?;
    let request: CohortProxyRequest = read_control(&mut stream)?
        .ok_or_else(|| BridgeRuntimeError::Invalid("cohort proxy request is missing".to_owned()))?;
    let result = match request {
        CohortProxyRequest::Health {
            target_id,
            keeper_local_protocol_major,
        } => {
            if target_id != state.options.target_id
                || keeper_local_protocol_major != state.options.keeper_local_protocol_major
            {
                Err(BridgeRuntimeError::Invalid(
                    "cohort proxy health identity mismatch".to_owned(),
                ))
            } else {
                write_control(
                    &mut stream,
                    &CohortProxyResponse::Healthy {
                        target_id,
                        keeper_local_protocol_major,
                        executable_generation: state.options.executable_generation.clone(),
                    },
                )?;
                Ok(())
            }
        }
        CohortProxyRequest::Authorize {
            roots,
            resource_key,
            keeper_generation,
            attach_capability,
            expires_at_unix_ms,
            access,
        } => state
            .authorize(
                CohortAttachCapability {
                    roots,
                    resource_key,
                    keeper_generation,
                    expires_at_unix_ms,
                    access,
                },
                attach_capability,
            )
            .and_then(|()| {
                write_control(&mut stream, &CohortProxyResponse::Authorized {})?;
                Ok(())
            }),
        CohortProxyRequest::Attach { mut request } => {
            if let Err(error) = state.redeem(&request) {
                write_cohort_proxy_error(&mut stream, &error);
                return Err(error);
            }
            let (inner_capability, _) = write_attach_capability(
                &request.roots,
                &request.resource_key,
                &request.keeper_generation,
                request.access,
            )?;
            request.attach_capability = inner_capability;
            let keeper = match open_keeper_proxy(&request) {
                Ok(keeper) => keeper,
                Err(error) => {
                    write_cohort_proxy_error(&mut stream, &error);
                    return Err(error);
                }
            };
            write_control(&mut stream, &CohortProxyResponse::Attached {})?;
            stream.set_read_timeout(None)?;
            stream.set_write_timeout(None)?;
            return proxy_unix_streams(stream, keeper);
        }
    };
    if let Err(error) = result {
        write_cohort_proxy_error(&mut stream, &error);
        return Err(error);
    }
    Ok(())
}

fn write_cohort_proxy_error(stream: &mut UnixStream, error: &BridgeRuntimeError) {
    let _ = write_control(
        stream,
        &CohortProxyResponse::Error {
            code: "cohort-proxy-rejected".to_owned(),
            message: error.to_string(),
            retryable: false,
        },
    );
}

impl CohortProxyState {
    fn authorize(
        &self,
        capability: CohortAttachCapability,
        token: String,
    ) -> Result<(), BridgeRuntimeError> {
        validate_roots(&capability.roots)?;
        validate_resource_key(&capability.resource_key)?;
        let now = unix_millis();
        let maximum_expiry = now
            .checked_add(ATTACH_CAPABILITY_TTL.as_millis() as u64)
            .ok_or_else(|| {
                BridgeRuntimeError::Invalid("capability deadline overflow".to_owned())
            })?;
        if !is_sha256(&token)
            || capability.resource_key.target_id != self.options.target_id
            || capability.resource_key.session_id.is_none()
            || capability.roots.state_root != self.options.state_root.to_string_lossy()
            || capability.roots.runtime_root != self.options.runtime_root.to_string_lossy()
            || capability.expires_at_unix_ms <= now
            || capability.expires_at_unix_ms > maximum_expiry
        {
            return Err(BridgeRuntimeError::Invalid(
                "cohort attach authorization is invalid".to_owned(),
            ));
        }
        let descriptor_path =
            session_descriptor_path(&self.options.state_root, &capability.resource_key);
        let descriptor = load_session_descriptor(&descriptor_path)?;
        if descriptor.resource_key != capability.resource_key
            || descriptor.keeper_generation != capability.keeper_generation
            || descriptor.state != SessionDescriptorState::Running
            || descriptor.keeper_local_protocol_major != self.options.keeper_local_protocol_major
            || descriptor.terminal_wire_version != kmux_compat::TERMINAL_WIRE_VERSION
        {
            return Err(BridgeRuntimeError::Invalid(
                "cohort keeper scope is unavailable".to_owned(),
            ));
        }
        let mut capabilities = self.capabilities.lock().map_err(|_| {
            BridgeRuntimeError::Retryable("cohort capability store is unavailable".to_owned())
        })?;
        capabilities.retain(|_, record| record.expires_at_unix_ms > now);
        if capabilities.len() >= MAX_COHORT_CAPABILITIES || capabilities.contains_key(&token) {
            return Err(BridgeRuntimeError::Retryable(
                "cohort capability store is full".to_owned(),
            ));
        }
        capabilities.insert(token, capability);
        Ok(())
    }

    fn redeem(&self, request: &KeeperAttachRequest) -> Result<(), BridgeRuntimeError> {
        let mut capabilities = self.capabilities.lock().map_err(|_| {
            BridgeRuntimeError::Retryable("cohort capability store is unavailable".to_owned())
        })?;
        let capability = capabilities
            .remove(&request.attach_capability)
            .ok_or_else(|| {
                BridgeRuntimeError::Invalid(
                    "cohort attach capability is unavailable or already used".to_owned(),
                )
            })?;
        if capability.expires_at_unix_ms <= unix_millis()
            || request.message_type != "keeper.attach"
            || request.protocol_version != REMOTE_PROTOCOL_VERSION
            || request.roots != capability.roots
            || request.resource_key != capability.resource_key
            || request.keeper_generation != capability.keeper_generation
            || request.access != capability.access
        {
            return Err(BridgeRuntimeError::Invalid(
                "cohort attach capability scope is invalid".to_owned(),
            ));
        }
        Ok(())
    }
}

fn proxy_unix_streams(
    mut client: UnixStream,
    mut keeper: UnixStream,
) -> Result<(), BridgeRuntimeError> {
    let mut client_input = client.try_clone()?;
    let mut keeper_input = keeper.try_clone()?;
    let input = thread::Builder::new()
        .name("kmux-cohort-input".to_owned())
        .spawn(move || {
            let result = io::copy(&mut client_input, &mut keeper_input);
            let _ = keeper_input.shutdown(Shutdown::Write);
            result
        })?;
    let output = io::copy(&mut keeper, &mut client);
    let _ = client.shutdown(Shutdown::Both);
    let _ = input.join();
    output?;
    Ok(())
}

struct CohortSocketGuard(PathBuf);

impl Drop for CohortSocketGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        if let Some(parent) = self.0.parent() {
            let _ = File::open(parent).and_then(|directory| directory.sync_all());
        }
    }
}

struct CohortConnectionPermit(Arc<AtomicUsize>);

impl Drop for CohortConnectionPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn handle_request(
    envelope: BridgeRequestEnvelope,
    bridge_generation: &str,
    executable: &Path,
    binding: Option<&BridgeConnectionBinding>,
) -> Result<(BridgeHandledResponse, VerifiedBridgeToken), BridgeRuntimeError> {
    if envelope.protocol_version != REMOTE_PROTOCOL_VERSION {
        return Err(BridgeRuntimeError::Invalid(
            "protocol-incompatible".to_owned(),
        ));
    }
    validate_id(&envelope.request_id, "requestId")?;
    validate_roots(&envelope.roots)?;
    if !envelope.retention_policy.is_valid() {
        return Err(BridgeRuntimeError::Invalid(
            "remote retention policy is outside its allowed range".to_owned(),
        ));
    }
    let verified = match binding {
        Some(binding) => verify_bound_bridge_token(&envelope.roots, &envelope.token, binding)?,
        None => verify_bridge_token(&envelope.roots, &envelope.token)?,
    };
    let response = match envelope.request {
        BridgeRequest::SurfaceCapture {
            resource_key,
            expected_keeper_generation,
            capture_id,
            line_limit,
            max_bytes,
        } => capture_surface_request(
            &envelope.roots,
            resource_key,
            &expected_keeper_generation,
            &capture_id,
            line_limit,
            max_bytes,
        )
        .map(BridgeHandledResponse::Capture),
        request => handle_single_request(
            &envelope.roots,
            envelope.retention_policy,
            bridge_generation,
            executable,
            request,
        )
        .map(BridgeHandledResponse::Single),
    }?;
    Ok((response, verified))
}

fn handle_single_request(
    roots: &RemoteRuntimeRoots,
    retention_policy: RemoteRetentionPolicy,
    bridge_generation: &str,
    executable: &Path,
    request: BridgeRequest,
) -> Result<BridgeResponseBody, BridgeRuntimeError> {
    match request {
        BridgeRequest::Hello {} => hello(roots, bridge_generation),
        BridgeRequest::OperationExecute { intent, payload } => {
            execute_operation(roots, retention_policy, executable, *intent, payload)
                .map(BridgeResponseBody::OperationResult)
        }
        BridgeRequest::Observe {
            desktop_installation_id,
            target_id,
        } => observe(
            roots,
            bridge_generation,
            &desktop_installation_id,
            &target_id,
        )
        .map(BridgeResponseBody::Observed),
        BridgeRequest::GitInspect {
            cwd,
            dirty_limit,
            branch,
            ..
        } => inspect_git_repository(&cwd, dirty_limit, branch.as_deref())
            .map(BridgeResponseBody::GitInspected),
        BridgeRequest::PortsInspect { resource_key } => {
            inspect_session_ports(roots, resource_key).map(BridgeResponseBody::PortsInspected)
        }
        BridgeRequest::HistoryScan {
            target_id,
            max_records,
            ..
        } => inspect_external_history(&target_id, max_records)
            .map(BridgeResponseBody::HistoryScanned),
        BridgeRequest::UsageScan {
            target_id,
            start_at_unix_ms,
            max_records,
            ..
        } => inspect_external_usage(&target_id, &start_at_unix_ms, max_records)
            .map(BridgeResponseBody::UsageScanned),
        BridgeRequest::ForwardsObserve {
            desktop_installation_id,
            target_id,
        } => observe_forwards(roots, &desktop_installation_id, &target_id)
            .map(BridgeResponseBody::ForwardsObserved),
        BridgeRequest::AttachAuthorize {
            resource_key,
            expected_keeper_generation,
            access,
        } => authorize_attach(
            roots,
            resource_key,
            expected_keeper_generation.as_deref(),
            access,
        )
        .map(BridgeResponseBody::AttachAuthorized),
        BridgeRequest::TerminalInject {
            resource_key,
            expected_keeper_generation,
            operation_id,
            payload_hash,
            input,
        } => inject_terminal_input(
            roots,
            resource_key,
            &expected_keeper_generation,
            &operation_id,
            &payload_hash,
            &input,
        )
        .map(BridgeResponseBody::TerminalInputAck),
        BridgeRequest::EventsReplay {
            desktop_installation_id,
            target_id,
            after_sequence,
        } => replay_remote_events(roots, &desktop_installation_id, &target_id, &after_sequence)
            .map(BridgeResponseBody::EventsReplayed),
        BridgeRequest::EventsAck {
            desktop_installation_id,
            target_id,
            through_sequence,
        } => acknowledge_remote_events(
            roots,
            &desktop_installation_id,
            &target_id,
            &through_sequence,
        )
        .map(BridgeResponseBody::EventsAcknowledged),
        BridgeRequest::ConversionPrepare {
            transaction_id,
            workspace_create_operation_id,
            session_create_operation_id,
            workspace_resource_key,
            session_resource_key,
            source_workspace_revision,
            remote_snapshot,
            remote_snapshot_hash,
            launch,
            prepared_at,
        } => prepare_conversion(
            roots,
            retention_policy,
            executable,
            ConversionPrepareInput {
                transaction_id,
                workspace_create_operation_id,
                session_create_operation_id,
                workspace_resource_key,
                session_resource_key,
                source_workspace_revision,
                remote_snapshot,
                remote_snapshot_hash,
                launch,
                prepared_at,
            },
        )
        .map(BridgeResponseBody::ConversionPrepared),
        BridgeRequest::ConversionPromote {
            transaction_id,
            workspace_create_operation_id,
            session_create_operation_id,
            workspace_resource_key,
            session_resource_key,
            remote_snapshot_hash,
        } => promote_conversion(
            roots,
            &transaction_id,
            &workspace_create_operation_id,
            &session_create_operation_id,
            &workspace_resource_key,
            &session_resource_key,
            &remote_snapshot_hash,
        )
        .map(BridgeResponseBody::ConversionPromoted),
        BridgeRequest::ProvisionalReclaim {
            desktop_installation_id,
            target_id,
            protected_transaction_ids,
            now,
        } => reclaim_provisionals(
            roots,
            &desktop_installation_id,
            &target_id,
            &protected_transaction_ids,
            &now,
        )
        .map(BridgeResponseBody::ProvisionalReclaimed),
        BridgeRequest::SurfaceCapture { .. } => Err(BridgeRuntimeError::Invalid(
            "surface capture reached the single-response handler".to_owned(),
        )),
    }
}

fn hello(
    roots: &RemoteRuntimeRoots,
    bridge_generation: &str,
) -> Result<BridgeResponseBody, BridgeRuntimeError> {
    let report = run_doctor(&DoctorPaths {
        install_root: PathBuf::from(&roots.install_root),
        authority_root: PathBuf::from(&roots.authority_root),
        state_root: PathBuf::from(&roots.state_root),
        runtime_root: PathBuf::from(&roots.runtime_root),
    })?;
    Ok(BridgeResponseBody::Hello(HelloResponse {
        protocol_version: REMOTE_PROTOCOL_VERSION,
        runtime_version: env!("CARGO_PKG_VERSION").to_owned(),
        bridge_generation: bridge_generation.to_owned(),
        capabilities: vec![
            "session.create".to_owned(),
            "session.attach".to_owned(),
            "session.input".to_owned(),
            "session.resize".to_owned(),
            "session.reconnect".to_owned(),
            "session.terminate".to_owned(),
            "terminal.checkpoint".to_owned(),
            "terminal.inject-ack".to_owned(),
            "surface.capture-bounded".to_owned(),
            "events.replay-ack".to_owned(),
            "hook.spool-v1".to_owned(),
            "conversion.provisional-v1".to_owned(),
            "git.inspect-bounded-v1".to_owned(),
            "ports.inspect-bounded-v1".to_owned(),
            "history.scan-bounded-v1".to_owned(),
            "usage.scan-bounded-v1".to_owned(),
            "worktree.durable-v1".to_owned(),
            "forward.desired-state-v1".to_owned(),
        ],
        authority: RemoteAuthority {
            remote_installation_id: report.remote_installation_id.to_string(),
            execution_node_id: report.execution_node_id.to_string(),
            authenticated_principal: RemotePrincipal {
                uid: report.authenticated_principal.uid,
                account_name: report.authenticated_principal.account_name,
            },
        },
        platform: report.platform,
        arch: report.arch,
        abi: report.abi,
        persistence_level: RemotePersistenceLevel::SshDisconnect,
    }))
}

fn execute_operation(
    roots: &RemoteRuntimeRoots,
    retention_policy: RemoteRetentionPolicy,
    executable: &Path,
    intent: RemoteOperationIntent,
    payload: RemoteOperationPayload,
) -> Result<OperationResult, BridgeRuntimeError> {
    validate_operation(&intent, &payload)?;
    match payload {
        RemoteOperationPayload::WorkspaceCreate { .. }
        | RemoteOperationPayload::WorkspaceTerminate { .. } => {
            execute_workspace_operation(roots, &intent, &payload)
        }
        RemoteOperationPayload::SessionCreate { launch, .. } => {
            execute_session_create(roots, retention_policy, executable, &intent, launch)
        }
        RemoteOperationPayload::SessionRestart { launch, .. } => {
            execute_session_restart(roots, retention_policy, executable, &intent, launch)
        }
        RemoteOperationPayload::SessionAdopt { launch, .. } => {
            execute_session_adopt(roots, &intent, &launch)
        }
        RemoteOperationPayload::SessionTerminate { .. } => {
            execute_session_terminate(roots, &intent)
        }
        RemoteOperationPayload::LaunchInput { input, .. } => {
            execute_launch_input(roots, &intent, &input)
        }
        payload @ (RemoteOperationPayload::WorktreeCreate { .. }
        | RemoteOperationPayload::WorktreeRemove { .. }
        | RemoteOperationPayload::ForwardEnsure { .. }
        | RemoteOperationPayload::ForwardRemove { .. }) => {
            execute_target_local_workspace_operation(roots, &intent, payload)
        }
    }
}

fn execute_workspace_operation(
    roots: &RemoteRuntimeRoots,
    intent: &RemoteOperationIntent,
    payload: &RemoteOperationPayload,
) -> Result<OperationResult, BridgeRuntimeError> {
    let directory = Path::new(&roots.state_root).join("workspaces");
    ensure_private_directory(&directory)?;
    let path = directory.join(format!(
        "{}.json",
        resource_key_digest(&intent.resource_key)
    ));
    let _lock = acquire_resource_lock(&path)?;
    let existing = read_workspace_descriptor_optional(&path)?;
    if let Some(existing) = existing.as_ref() {
        if existing.resource_key != intent.resource_key {
            return Err(BridgeRuntimeError::Invalid(
                "workspace descriptor resource key is inconsistent".to_owned(),
            ));
        }
        if existing.create_operation_id == intent.operation_id {
            if existing.canonical_create_payload_hash != intent.canonical_payload_hash {
                return Ok(operation_failure(
                    &intent.operation_id,
                    "idempotency-conflict",
                    "create operation ID was reused with another payload",
                ));
            }
            return Ok(operation_success(
                intent,
                existing.create_result_digest.clone(),
                None,
            ));
        }
        if existing.last_operation_id == intent.operation_id {
            if existing.last_operation_payload_hash != intent.canonical_payload_hash {
                return Ok(operation_failure(
                    &intent.operation_id,
                    "idempotency-conflict",
                    "operation ID was reused with another payload",
                ));
            }
            return Ok(operation_success(
                intent,
                existing.last_result_digest.clone(),
                None,
            ));
        }
        if existing.remote_resource_revision != intent.expected_remote_resource_revision {
            return Ok(operation_failure(
                &intent.operation_id,
                "operation-stale",
                "workspace resource revision is stale",
            ));
        }
    } else if intent.expected_remote_resource_revision != "0" {
        return Ok(operation_failure(
            &intent.operation_id,
            "operation-stale",
            "workspace resource does not exist at the expected revision",
        ));
    }
    let result_digest = operation_result_digest(intent, None, "succeeded");
    let creating = matches!(payload, RemoteOperationPayload::WorkspaceCreate { .. });
    let create_operation_id = existing
        .as_ref()
        .map(|record| record.create_operation_id.clone())
        .unwrap_or_else(|| intent.operation_id.clone());
    let create_hash = existing
        .as_ref()
        .map(|record| record.canonical_create_payload_hash.clone())
        .unwrap_or_else(|| intent.canonical_payload_hash.clone());
    let create_result_digest = existing
        .as_ref()
        .map(|record| record.create_result_digest.clone())
        .unwrap_or_else(|| result_digest.clone());
    let descriptor = WorkspaceDescriptor {
        version: 1,
        resource_key: intent.resource_key.clone(),
        create_operation_id,
        canonical_create_payload_hash: create_hash,
        create_result_digest,
        remote_resource_revision: intent.next_remote_resource_revision.clone(),
        last_operation_id: intent.operation_id.clone(),
        last_operation_payload_hash: intent.canonical_payload_hash.clone(),
        last_result_digest: result_digest.clone(),
        state: if creating { "active" } else { "terminated" }.to_owned(),
        updated_at: now_rfc3339(),
        conversion_transaction_id: None,
        remote_snapshot_hash: None,
        provisional_created_at: None,
        source_workspace_revision: None,
        pending_operation: None,
        failed_operation: existing
            .as_ref()
            .and_then(|record| record.failed_operation.clone()),
    };
    write_json_atomic(&path, &descriptor)?;
    Ok(operation_success(intent, result_digest, None))
}

fn execute_target_local_workspace_operation(
    roots: &RemoteRuntimeRoots,
    intent: &RemoteOperationIntent,
    payload: RemoteOperationPayload,
) -> Result<OperationResult, BridgeRuntimeError> {
    let descriptor_path = workspace_descriptor_path(roots, &intent.resource_key);
    let _lock = acquire_resource_lock(&descriptor_path)?;
    let Some(mut descriptor) = read_workspace_descriptor_optional(&descriptor_path)? else {
        return Ok(operation_failure(
            &intent.operation_id,
            "resource-missing",
            "workspace resource does not exist",
        ));
    };
    if descriptor.resource_key != intent.resource_key {
        return Err(BridgeRuntimeError::Invalid(
            "workspace descriptor resource key is inconsistent".to_owned(),
        ));
    }
    if let Some(failed) = descriptor.failed_operation.as_ref()
        && failed.operation_id == intent.operation_id
    {
        if failed.kind != intent.kind
            || failed.canonical_payload_hash != intent.canonical_payload_hash
        {
            return Ok(operation_failure(
                &intent.operation_id,
                "idempotency-conflict",
                "operation ID was reused with another payload",
            ));
        }
        let result = operation_failure(&failed.operation_id, &failed.code, &failed.message);
        if result.result_digest != failed.result_digest {
            return Err(BridgeRuntimeError::Invalid(
                "workspace failed-operation digest is inconsistent".to_owned(),
            ));
        }
        return Ok(result);
    }
    if descriptor.state != "active" {
        return Ok(operation_failure(
            &intent.operation_id,
            "resource-inactive",
            "workspace resource is not active",
        ));
    }
    if descriptor.last_operation_id == intent.operation_id {
        if descriptor.last_operation_payload_hash != intent.canonical_payload_hash {
            return Ok(operation_failure(
                &intent.operation_id,
                "idempotency-conflict",
                "operation ID was reused with another payload",
            ));
        }
        return Ok(operation_success(
            intent,
            descriptor.last_result_digest.clone(),
            None,
        ));
    }

    let result_digest = operation_result_digest(intent, None, "succeeded");
    if let Some(pending) = descriptor.pending_operation.as_ref() {
        if pending.operation_id != intent.operation_id
            || pending.kind != intent.kind
            || pending.canonical_payload_hash != intent.canonical_payload_hash
            || pending.next_remote_resource_revision != intent.next_remote_resource_revision
            || pending.result_digest != result_digest
            || canonical_payload_hash(&pending.payload)? != intent.canonical_payload_hash
        {
            return Err(BridgeRuntimeError::Retryable(
                "another workspace mutation requires recovery".to_owned(),
            ));
        }
    } else {
        if descriptor.remote_resource_revision != intent.expected_remote_resource_revision {
            return Ok(operation_failure(
                &intent.operation_id,
                "operation-stale",
                "workspace resource revision is stale",
            ));
        }
        descriptor.pending_operation = Some(WorkspacePendingOperation {
            operation_id: intent.operation_id.clone(),
            kind: intent.kind.clone(),
            canonical_payload_hash: intent.canonical_payload_hash.clone(),
            next_remote_resource_revision: intent.next_remote_resource_revision.clone(),
            result_digest: result_digest.clone(),
            payload: payload.clone(),
        });
        descriptor.updated_at = now_rfc3339();
        write_json_atomic(&descriptor_path, &descriptor)?;
    }

    let effect = apply_target_local_workspace_effect(roots, intent, &payload);
    match effect {
        Ok(()) => {
            descriptor.remote_resource_revision = intent.next_remote_resource_revision.clone();
            descriptor.last_operation_id = intent.operation_id.clone();
            descriptor.last_operation_payload_hash = intent.canonical_payload_hash.clone();
            descriptor.last_result_digest = result_digest.clone();
            descriptor.pending_operation = None;
            descriptor.updated_at = now_rfc3339();
            write_json_atomic(&descriptor_path, &descriptor)?;
            Ok(operation_success(intent, result_digest, None))
        }
        Err(TargetLocalEffectError::Definitive { code, message }) => {
            let result = operation_failure(&intent.operation_id, code, &message);
            let stored_code = result.code.clone().ok_or_else(|| {
                BridgeRuntimeError::Invalid("definitive operation failure has no code".to_owned())
            })?;
            let stored_message = result.message.clone().ok_or_else(|| {
                BridgeRuntimeError::Invalid(
                    "definitive operation failure has no message".to_owned(),
                )
            })?;
            descriptor.failed_operation = Some(WorkspaceFailedOperation {
                operation_id: intent.operation_id.clone(),
                kind: intent.kind.clone(),
                canonical_payload_hash: intent.canonical_payload_hash.clone(),
                result_digest: result.result_digest.clone(),
                code: stored_code,
                message: stored_message,
            });
            descriptor.pending_operation = None;
            descriptor.updated_at = now_rfc3339();
            write_json_atomic(&descriptor_path, &descriptor)?;
            Ok(result)
        }
        Err(TargetLocalEffectError::Ambiguous(message)) => {
            Err(BridgeRuntimeError::Retryable(message))
        }
    }
}

#[derive(Debug)]
enum TargetLocalEffectError {
    Definitive { code: &'static str, message: String },
    Ambiguous(String),
}

fn apply_target_local_workspace_effect(
    roots: &RemoteRuntimeRoots,
    intent: &RemoteOperationIntent,
    payload: &RemoteOperationPayload,
) -> Result<(), TargetLocalEffectError> {
    match payload {
        RemoteOperationPayload::WorktreeCreate {
            cwd,
            path,
            base_ref,
            branch,
            ..
        } => apply_worktree_create(roots, cwd, path, base_ref, branch),
        RemoteOperationPayload::WorktreeRemove {
            cwd,
            path,
            force,
            expected_branch,
            expected_common_git_dir,
            ..
        } => apply_worktree_remove(cwd, path, *force, expected_branch, expected_common_git_dir),
        RemoteOperationPayload::ForwardEnsure {
            forward_id,
            remote_host,
            remote_port,
            local_bind_host,
            local_port,
        } => write_desired_forward(
            roots,
            intent,
            forward_id,
            remote_host,
            *remote_port,
            local_bind_host,
            *local_port,
        )
        .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string())),
        RemoteOperationPayload::ForwardRemove { forward_id } => {
            remove_desired_forward(roots, &intent.resource_key, forward_id)
                .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))
        }
        _ => Err(TargetLocalEffectError::Definitive {
            code: "invalid-operation",
            message: "target-local workspace effect has an unsupported payload".to_owned(),
        }),
    }
}

fn apply_worktree_create(
    roots: &RemoteRuntimeRoots,
    cwd: &str,
    path: &str,
    base_ref: &str,
    branch: &str,
) -> Result<(), TargetLocalEffectError> {
    match find_registered_worktree(cwd, path) {
        Ok(Some(existing_branch)) if existing_branch.as_deref() == Some(branch) => return Ok(()),
        Ok(Some(_)) => {
            return Err(TargetLocalEffectError::Definitive {
                code: "worktree-conflict",
                message: "worktree path is registered with another branch".to_owned(),
            });
        }
        Ok(None) => {}
        Err(error) => return Err(TargetLocalEffectError::Ambiguous(error.to_string())),
    }
    let branch_ref = format!("refs/heads/{branch}");
    let branch_exists = git_exit_success(cwd, &["show-ref", "--verify", "--quiet", &branch_ref])
        .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?;
    if branch_exists {
        return Err(TargetLocalEffectError::Definitive {
            code: "branch-exists",
            message: format!("Branch already exists: {branch}"),
        });
    }
    if !git_exit_success(cwd, &["check-ref-format", "--branch", branch])
        .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?
    {
        return Err(TargetLocalEffectError::Definitive {
            code: "invalid-branch",
            message: "worktree branch name is invalid".to_owned(),
        });
    }
    if !git_exit_success(cwd, &["rev-parse", "--verify", "--quiet", base_ref])
        .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?
    {
        return Err(TargetLocalEffectError::Definitive {
            code: "invalid-base-ref",
            message: "worktree base ref does not resolve".to_owned(),
        });
    }
    prepare_managed_worktree_parent(roots, path)?;

    let output = run_git_mutating_bounded(
        cwd,
        &["worktree", "add", "-b", branch, "--", path, base_ref],
    )
    .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?;
    if output.status.success() {
        return verify_registered_worktree(cwd, path, branch);
    }
    if matches!(find_registered_worktree(cwd, path), Ok(Some(value)) if value.as_deref() == Some(branch))
    {
        return Ok(());
    }
    Err(TargetLocalEffectError::Definitive {
        code: "git-failed",
        message: bounded_command_message(&output, "git worktree add failed"),
    })
}

fn prepare_managed_worktree_parent(
    roots: &RemoteRuntimeRoots,
    requested_path: &str,
) -> Result<(), TargetLocalEffectError> {
    let requested = Path::new(requested_path);
    if requested
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(TargetLocalEffectError::Definitive {
            code: "invalid-worktree-path",
            message: "managed worktree path contains a relative component".to_owned(),
        });
    }
    let requested = normalize_absolute_path(requested_path).map_err(|error| {
        TargetLocalEffectError::Definitive {
            code: "invalid-worktree-path",
            message: error.to_string(),
        }
    })?;
    let managed_root = normalize_absolute_path(
        &Path::new(&roots.state_root)
            .join("worktrees")
            .to_string_lossy(),
    )
    .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?;
    let requested = Path::new(&requested);
    let managed_root = Path::new(&managed_root);
    if requested == managed_root || !requested.starts_with(managed_root) {
        return Err(TargetLocalEffectError::Definitive {
            code: "invalid-worktree-path",
            message: "managed worktree path is outside the target state root".to_owned(),
        });
    }
    let parent = requested
        .parent()
        .ok_or_else(|| TargetLocalEffectError::Definitive {
            code: "invalid-worktree-path",
            message: "managed worktree path has no parent".to_owned(),
        })?;
    ensure_private_directory(managed_root)
        .and_then(|()| ensure_private_directory(parent))
        .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?;
    let canonical_root = fs::canonicalize(managed_root)
        .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(TargetLocalEffectError::Definitive {
            code: "invalid-worktree-path",
            message: "managed worktree parent escapes through a symbolic link".to_owned(),
        });
    }
    Ok(())
}

fn apply_worktree_remove(
    cwd: &str,
    path: &str,
    force: bool,
    expected_branch: &str,
    expected_common_git_dir: &str,
) -> Result<(), TargetLocalEffectError> {
    let registered = find_registered_worktree(cwd, path)
        .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?;
    let Some(registered_branch) = registered else {
        return Ok(());
    };
    if !registered_branch_matches(registered_branch.as_deref(), expected_branch) {
        return Err(TargetLocalEffectError::Definitive {
            code: "worktree-changed",
            message: "worktree path is registered with another branch".to_owned(),
        });
    }
    let command_repository = inspect_git_repository(cwd, 0, None)
        .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?
        .repository
        .ok_or_else(|| {
            TargetLocalEffectError::Ambiguous("worktree repository is unavailable".to_owned())
        })?;
    let actual_common_git_dir = comparable_worktree_path(&command_repository.common_git_dir)
        .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?;
    let expected_common_git_dir = comparable_worktree_path(expected_common_git_dir)
        .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?;
    if actual_common_git_dir != expected_common_git_dir {
        return Err(TargetLocalEffectError::Definitive {
            code: "worktree-changed",
            message: "worktree repository identity changed before removal".to_owned(),
        });
    }
    if !force {
        let inspection = inspect_git_repository(path, 8, None)
            .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?;
        if !inspection.dirty_entries.is_empty() || inspection.dirty_entries_truncated {
            return Err(TargetLocalEffectError::Definitive {
                code: "worktree-dirty",
                message: inspection.dirty_entries.join("\n"),
            });
        }
    }
    let mut arguments = vec!["worktree", "remove"];
    if force {
        arguments.push("--force");
    }
    arguments.extend(["--", path]);
    let output = run_git_mutating_bounded(cwd, &arguments)
        .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?;
    if output.status.success()
        || find_registered_worktree(cwd, path)
            .map_err(|error| TargetLocalEffectError::Ambiguous(error.to_string()))?
            .is_none()
    {
        return Ok(());
    }
    Err(TargetLocalEffectError::Definitive {
        code: "git-failed",
        message: bounded_command_message(&output, "git worktree remove failed"),
    })
}

fn registered_branch_matches(actual: Option<&str>, expected: &str) -> bool {
    actual == Some(expected) || (actual.is_none() && expected == "HEAD")
}

fn verify_registered_worktree(
    cwd: &str,
    path: &str,
    branch: &str,
) -> Result<(), TargetLocalEffectError> {
    match find_registered_worktree(cwd, path) {
        Ok(Some(value)) if value.as_deref() == Some(branch) => Ok(()),
        Ok(_) => Err(TargetLocalEffectError::Ambiguous(
            "git reported success without the requested worktree".to_owned(),
        )),
        Err(error) => Err(TargetLocalEffectError::Ambiguous(error.to_string())),
    }
}

fn find_registered_worktree(
    cwd: &str,
    requested_path: &str,
) -> Result<Option<Option<String>>, BridgeRuntimeError> {
    let output = run_git_bounded(cwd, &["worktree", "list", "--porcelain"])?;
    if !output.status.success() || output.stdout_truncated {
        return Err(BridgeRuntimeError::Retryable(
            "git worktree inventory is unavailable or oversized".to_owned(),
        ));
    }
    let text = std::str::from_utf8(&output.stdout).map_err(|_| {
        BridgeRuntimeError::Invalid("git worktree inventory is not UTF-8".to_owned())
    })?;
    let requested = comparable_worktree_path(requested_path)?;
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;
    let flush = |path: &mut Option<String>, branch: &mut Option<String>| {
        let matches = path
            .as_deref()
            .and_then(|value| comparable_worktree_path(value).ok())
            .is_some_and(|value| value == requested);
        let result = matches.then(|| branch.take());
        *path = None;
        *branch = None;
        result
    };
    for line in text.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if let Some(result) = flush(&mut current_path, &mut current_branch) {
                return Ok(Some(result));
            }
        } else if let Some(value) = line.strip_prefix("worktree ") {
            current_path = Some(value.to_owned());
        } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(value.to_owned());
        }
    }
    Ok(None)
}

fn comparable_worktree_path(value: &str) -> Result<String, BridgeRuntimeError> {
    let normalized = normalize_absolute_path(value)?;
    match fs::canonicalize(&normalized) {
        Ok(canonical) => normalize_absolute_path(&canonical.to_string_lossy()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(normalized),
        Err(error) => Err(error.into()),
    }
}

fn write_desired_forward(
    roots: &RemoteRuntimeRoots,
    intent: &RemoteOperationIntent,
    forward_id: &str,
    remote_host: &str,
    remote_port: u16,
    local_bind_host: &str,
    local_port: Option<u16>,
) -> Result<(), BridgeRuntimeError> {
    let path = desired_forward_path(roots, &intent.resource_key, forward_id);
    if let Some(existing) = read_desired_forward_optional(&path)?
        && (existing.resource_key != intent.resource_key || existing.forward_id != forward_id)
    {
        return Err(BridgeRuntimeError::Invalid(
            "desired forward descriptor identity is inconsistent".to_owned(),
        ));
    }
    write_json_atomic(
        &path,
        &DesiredForwardDescriptor {
            version: 1,
            resource_key: intent.resource_key.clone(),
            forward_id: forward_id.to_owned(),
            remote_host: remote_host.to_owned(),
            remote_port,
            local_bind_host: local_bind_host.to_owned(),
            local_port,
            operation_id: intent.operation_id.clone(),
            remote_resource_revision: intent.next_remote_resource_revision.clone(),
            updated_at: now_rfc3339(),
        },
    )
}

fn remove_desired_forward(
    roots: &RemoteRuntimeRoots,
    resource_key: &RemoteResourceKey,
    forward_id: &str,
) -> Result<(), BridgeRuntimeError> {
    let path = desired_forward_path(roots, resource_key, forward_id);
    match fs::remove_file(&path) {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                File::open(parent)?.sync_all()?;
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn desired_forward_path(
    roots: &RemoteRuntimeRoots,
    resource_key: &RemoteResourceKey,
    forward_id: &str,
) -> PathBuf {
    let identity = format!("{}\0{forward_id}", resource_key_digest(resource_key));
    Path::new(&roots.state_root)
        .join("forwards")
        .join(format!("{:x}.json", Sha256::digest(identity.as_bytes())))
}

fn read_desired_forward_optional(
    path: &Path,
) -> Result<Option<DesiredForwardDescriptor>, BridgeRuntimeError> {
    match read_private_json(path, 256 * 1024) {
        Ok(value) => Ok(Some(value)),
        Err(BridgeRuntimeError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn observe_forwards(
    roots: &RemoteRuntimeRoots,
    desktop_installation_id: &str,
    target_id: &str,
) -> Result<ForwardsObservedResponse, BridgeRuntimeError> {
    validate_id(desktop_installation_id, "desktopInstallationId")?;
    validate_id(target_id, "targetId")?;
    let directory = Path::new(&roots.state_root).join("forwards");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ForwardsObservedResponse {
                target_id: target_id.to_owned(),
                forwards: Vec::new(),
            });
        }
        Err(error) => return Err(error.into()),
    };
    let mut forwards = Vec::new();
    for entry in entries {
        let entry = entry?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if forwards.len() >= MAX_DESIRED_FORWARDS {
            return Err(BridgeRuntimeError::Invalid(
                "desired forward inventory exceeds its bound".to_owned(),
            ));
        }
        let descriptor: DesiredForwardDescriptor = read_private_json(&entry.path(), 256 * 1024)?;
        if descriptor.version != 1 {
            return Err(BridgeRuntimeError::Invalid(
                "desired forward descriptor version is incompatible".to_owned(),
            ));
        }
        if descriptor.resource_key.desktop_installation_id != desktop_installation_id
            || descriptor.resource_key.target_id != target_id
        {
            continue;
        }
        forwards.push(DesiredForwardResponse {
            resource_key: descriptor.resource_key,
            forward_id: descriptor.forward_id,
            remote_host: descriptor.remote_host,
            remote_port: descriptor.remote_port,
            local_bind_host: descriptor.local_bind_host,
            local_port: descriptor.local_port,
            operation_id: descriptor.operation_id,
            remote_resource_revision: descriptor.remote_resource_revision,
        });
    }
    forwards.sort_by(|left, right| left.forward_id.cmp(&right.forward_id));
    Ok(ForwardsObservedResponse {
        target_id: target_id.to_owned(),
        forwards,
    })
}

fn inspect_git_repository(
    cwd: &str,
    dirty_limit: usize,
    requested_branch: Option<&str>,
) -> Result<GitInspectedResponse, BridgeRuntimeError> {
    let cwd = normalize_absolute_path(cwd)?;
    if dirty_limit > MAX_GIT_DIRTY_ENTRIES {
        return Err(BridgeRuntimeError::Invalid(
            "git dirty entry limit exceeds its bound".to_owned(),
        ));
    }
    let repository_output = run_git_bounded(
        &cwd,
        &[
            "rev-parse",
            "--show-toplevel",
            "--absolute-git-dir",
            "--git-common-dir",
        ],
    )?;
    if !repository_output.status.success() {
        return Ok(GitInspectedResponse {
            cwd,
            repository: None,
            branch: None,
            dirty_entries: Vec::new(),
            dirty_entries_truncated: false,
            branch_exists: requested_branch.map(|_| false),
        });
    }
    if repository_output.stdout_truncated {
        return Err(BridgeRuntimeError::Invalid(
            "git repository metadata exceeds its bound".to_owned(),
        ));
    }
    let fields = std::str::from_utf8(&repository_output.stdout)
        .map_err(|_| {
            BridgeRuntimeError::Invalid("git repository metadata is not UTF-8".to_owned())
        })?
        .lines()
        .collect::<Vec<_>>();
    if fields.len() != 3 {
        return Err(BridgeRuntimeError::Invalid(
            "git repository metadata shape is invalid".to_owned(),
        ));
    }
    let root = normalize_git_path(&cwd, fields[0])?;
    let git_dir = normalize_git_path(&cwd, fields[1])?;
    let common_git_dir = normalize_git_path(&cwd, fields[2])?;
    let branch_output = run_git_bounded(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let branch = if branch_output.status.success() && !branch_output.stdout_truncated {
        Some(
            std::str::from_utf8(&branch_output.stdout)
                .map_err(|_| BridgeRuntimeError::Invalid("git branch is not UTF-8".to_owned()))?
                .trim_end_matches(['\r', '\n'])
                .to_owned(),
        )
    } else {
        None
    };
    let (dirty_entries, dirty_entries_truncated) = if dirty_limit == 0 {
        (Vec::new(), false)
    } else {
        let dirty_output = run_git_bounded(
            &cwd,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )?;
        if !dirty_output.status.success() {
            return Err(BridgeRuntimeError::Retryable(
                "git dirty status is unavailable".to_owned(),
            ));
        }
        let mut dirty_entries = Vec::new();
        let mut dirty_entries_truncated = dirty_output.stdout_truncated;
        for entry in dirty_output.stdout.split(|byte| *byte == 0) {
            if entry.is_empty() {
                continue;
            }
            if dirty_entries.len() >= dirty_limit {
                dirty_entries_truncated = true;
                break;
            }
            let entry = std::str::from_utf8(entry).map_err(|_| {
                BridgeRuntimeError::Invalid("git dirty path is not UTF-8".to_owned())
            })?;
            dirty_entries.push(entry.to_owned());
        }
        (dirty_entries, dirty_entries_truncated)
    };
    let branch_exists = requested_branch
        .map(|candidate| {
            validate_git_text(candidate, "requested branch")?;
            let branch_ref = format!("refs/heads/{candidate}");
            git_exit_success(&cwd, &["show-ref", "--verify", "--quiet", &branch_ref])
        })
        .transpose()?;
    Ok(GitInspectedResponse {
        cwd,
        repository: Some(GitRepositoryResponse {
            root,
            git_dir: git_dir.clone(),
            common_git_dir: common_git_dir.clone(),
            linked_worktree: git_dir != common_git_dir,
        }),
        branch,
        dirty_entries,
        dirty_entries_truncated,
        branch_exists,
    })
}

fn inspect_session_ports(
    roots: &RemoteRuntimeRoots,
    resource_key: RemoteResourceKey,
) -> Result<PortsInspectedResponse, BridgeRuntimeError> {
    validate_resource_key(&resource_key)?;
    if resource_key.session_id.is_none() {
        return Err(BridgeRuntimeError::Invalid(
            "port inspection requires a session resource".to_owned(),
        ));
    }
    let descriptor_path = session_descriptor_path(Path::new(&roots.state_root), &resource_key);
    let descriptor = {
        let _session_lock = acquire_resource_lock(&descriptor_path)?;
        let descriptor = load_session_descriptor(&descriptor_path)?;
        if descriptor.resource_key != resource_key {
            return Err(BridgeRuntimeError::Invalid(
                "port inspection resource changed".to_owned(),
            ));
        }
        descriptor
    };
    require_keeper_running(&descriptor)?;
    let ports = match descriptor.child_pid {
        Some(pid) => inspect_process_listeners(pid)?,
        None => Vec::new(),
    };
    let _session_lock = acquire_resource_lock(&descriptor_path)?;
    let current = load_session_descriptor(&descriptor_path)?;
    if current.resource_key != descriptor.resource_key
        || current.keeper_generation != descriptor.keeper_generation
        || current.state != SessionDescriptorState::Running
    {
        return Err(BridgeRuntimeError::Retryable(
            "session generation advanced during port inspection".to_owned(),
        ));
    }
    Ok(PortsInspectedResponse {
        resource_key,
        ports,
    })
}

fn inspect_external_history(
    target_id: &str,
    max_records: usize,
) -> Result<HistoryScannedResponse, BridgeRuntimeError> {
    validate_id(target_id, "targetId")?;
    let principal = current_authenticated_principal().map_err(|error| {
        BridgeRuntimeError::Invalid(format!("history principal is unavailable: {error}"))
    })?;
    let home = current_authenticated_home().map_err(|error| {
        BridgeRuntimeError::Invalid(format!("history home is unavailable: {error}"))
    })?;
    let records = scan_external_history(&home, max_records)
        .map_err(|error| BridgeRuntimeError::Invalid(error.to_string()))?
        .into_iter()
        .map(|record| RemoteHistoryRecord {
            vendor: record.vendor.to_owned(),
            session_id: record.session_id,
            updated_at_unix_ms: record.updated_at_unix_ms.to_string(),
            can_resume: record.can_resume,
            cwd: record.cwd,
            title: record.title,
            recent_conversation: record.recent_conversation,
            model: record.model,
            created_at: None,
            updated_at: None,
        })
        .collect();
    Ok(HistoryScannedResponse {
        target_id: target_id.to_owned(),
        principal: RemotePrincipal {
            uid: principal.uid,
            account_name: principal.account_name,
        },
        records,
    })
}

fn inspect_external_usage(
    target_id: &str,
    start_at_unix_ms: &str,
    max_records: usize,
) -> Result<UsageScannedResponse, BridgeRuntimeError> {
    validate_id(target_id, "targetId")?;
    let start_at_unix_ms = parse_u64(start_at_unix_ms)?;
    let principal = current_authenticated_principal().map_err(|error| {
        BridgeRuntimeError::Invalid(format!("usage principal is unavailable: {error}"))
    })?;
    let home = current_authenticated_home().map_err(|error| {
        BridgeRuntimeError::Invalid(format!("usage home is unavailable: {error}"))
    })?;
    let scan = scan_external_usage(&home, start_at_unix_ms, max_records)
        .map_err(|error| BridgeRuntimeError::Invalid(error.to_string()))?;
    let records = scan
        .records
        .into_iter()
        .map(|record| RemoteUsageRecord {
            vendor: record.vendor.to_owned(),
            sample_id: record.sample_id,
            timestamp_unix_ms: record.timestamp_unix_ms.to_string(),
            session_id: record.session_id,
            model: record.model,
            cwd: record.cwd,
            project_path: record.project_path,
            input_tokens: record.input_tokens.to_string(),
            output_tokens: record.output_tokens.to_string(),
            thinking_tokens: record.thinking_tokens.to_string(),
            cache_read_tokens: record.cache_read_tokens.to_string(),
            cache_write_tokens: record.cache_write_tokens.to_string(),
            cache_write_tokens_known: record.cache_write_tokens_known,
            total_tokens: record.total_tokens.to_string(),
        })
        .collect();
    Ok(UsageScannedResponse {
        target_id: target_id.to_owned(),
        principal: RemotePrincipal {
            uid: principal.uid,
            account_name: principal.account_name,
        },
        truncated: scan.truncated,
        records,
    })
}

fn inspect_process_listeners(pid: u32) -> Result<Vec<u16>, BridgeRuntimeError> {
    #[cfg(target_os = "linux")]
    let output =
        run_system_command_bounded("ss", &["-H", "-ltnp"], MAX_PORT_INSPECTION_OUTPUT_BYTES);
    #[cfg(target_os = "macos")]
    let output = run_system_command_bounded(
        "/usr/sbin/lsof",
        &["-Pan", "-p", &pid.to_string(), "-iTCP", "-sTCP:LISTEN"],
        MAX_PORT_INSPECTION_OUTPUT_BYTES,
    );
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    compile_error!("kmuxd supports only Linux and macOS remote targets");

    let output = match output {
        Ok(output) => output,
        Err(BridgeRuntimeError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(Vec::new());
        }
        Err(error) => return Err(error),
    };
    if output.stdout_truncated || output.stderr_truncated {
        return Err(BridgeRuntimeError::Invalid(
            "port inspection output exceeds its hard bound".to_owned(),
        ));
    }
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let stdout = String::from_utf8(output.stdout).map_err(|_| {
        BridgeRuntimeError::Invalid("port inspection output is not UTF-8".to_owned())
    })?;
    let mut ports = BTreeSet::new();
    for line in stdout.lines() {
        #[cfg(target_os = "linux")]
        {
            let pid_marker = format!("pid={pid},");
            if !line.contains(&pid_marker) {
                continue;
            }
            if let Some(port) = line.split_whitespace().nth(3).and_then(parse_endpoint_port) {
                ports.insert(port);
            }
        }
        #[cfg(target_os = "macos")]
        {
            if !line.contains("(LISTEN)") {
                continue;
            }
            if let Some(port) = line.split_whitespace().find_map(parse_endpoint_port) {
                ports.insert(port);
            }
        }
        if ports.len() >= MAX_INSPECTED_PORTS {
            break;
        }
    }
    Ok(ports.into_iter().collect())
}

fn parse_endpoint_port(value: &str) -> Option<u16> {
    value
        .trim_end_matches(|character: char| !character.is_ascii_digit())
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .filter(|port| *port > 0)
}

fn run_system_command_bounded(
    executable: &str,
    arguments: &[&str],
    maximum: usize,
) -> Result<BoundedCommandOutput, BridgeRuntimeError> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "C");
    run_bounded_command(
        &mut command,
        maximum,
        SYSTEM_COMMAND_TIMEOUT,
        "system metadata command",
    )
}

struct BoundedCommandOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

fn run_bounded_command(
    command: &mut Command,
    maximum: usize,
    timeout: Duration,
    label: &'static str,
) -> Result<BoundedCommandOutput, BridgeRuntimeError> {
    let mut child = spawn_detached(command)?;
    let Some(stdout) = child.stdout.take() else {
        let _ = terminate_command_group(&mut child);
        return Err(BridgeRuntimeError::Invalid(format!(
            "{label} stdout pipe is missing"
        )));
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = terminate_command_group(&mut child);
        return Err(BridgeRuntimeError::Invalid(format!(
            "{label} stderr pipe is missing"
        )));
    };
    let stdout_reader = thread::spawn(move || drain_bounded(stdout, maximum));
    let stderr_reader = thread::spawn(move || drain_bounded(stderr, maximum));
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(COMMAND_WAIT_POLL),
            Ok(None) => {
                timed_out = true;
                break terminate_command_group(&mut child);
            }
            Err(error) => {
                let _ = terminate_command_group(&mut child);
                break Err(error);
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| BridgeRuntimeError::Retryable(format!("{label} stdout reader failed")))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| BridgeRuntimeError::Retryable(format!("{label} stderr reader failed")))??;
    let status = status?;
    if timed_out {
        return Err(BridgeRuntimeError::Retryable(format!(
            "{label} exceeded its {} ms timeout",
            timeout.as_millis()
        )));
    }
    Ok(BoundedCommandOutput {
        status,
        stdout: stdout.0,
        stderr: stderr.0,
        stdout_truncated: stdout.1,
        stderr_truncated: stderr.1,
    })
}

fn terminate_command_group(
    child: &mut std::process::Child,
) -> io::Result<std::process::ExitStatus> {
    if let Some(status) = child.try_wait()? {
        return Ok(status);
    }
    signal_command_group(child.id(), Signal::SIGTERM)?;
    let deadline = Instant::now() + COMMAND_TERMINATION_GRACE;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(COMMAND_WAIT_POLL),
            Ok(None) => break,
            Err(error) => {
                let _ = signal_command_group(child.id(), Signal::SIGKILL);
                let _ = child.wait();
                return Err(error);
            }
        }
    }
    signal_command_group(child.id(), Signal::SIGKILL)?;
    child.wait()
}

fn signal_command_group(pid: u32, signal: Signal) -> io::Result<()> {
    let pid = i32::try_from(pid)
        .map(Pid::from_raw)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "child PID is invalid"))?;
    match killpg(pid, signal) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(error) => Err(io::Error::from_raw_os_error(error as i32)),
    }
}

fn run_git_bounded(
    cwd: &str,
    arguments: &[&str],
) -> Result<BoundedCommandOutput, BridgeRuntimeError> {
    run_git_command_bounded(cwd, arguments, true)
}

fn run_git_mutating_bounded(
    cwd: &str,
    arguments: &[&str],
) -> Result<BoundedCommandOutput, BridgeRuntimeError> {
    run_git_command_bounded(cwd, arguments, false)
}

fn run_git_command_bounded(
    cwd: &str,
    arguments: &[&str],
    read_only: bool,
) -> Result<BoundedCommandOutput, BridgeRuntimeError> {
    if arguments
        .iter()
        .any(|argument| argument.as_bytes().contains(&0) || argument.len() > MAX_GIT_ARGUMENT_BYTES)
    {
        return Err(BridgeRuntimeError::Invalid(
            "git argument is invalid or oversized".to_owned(),
        ));
    }
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    if read_only {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
    run_bounded_command(
        &mut command,
        MAX_GIT_OUTPUT_BYTES,
        GIT_COMMAND_TIMEOUT,
        "git command",
    )
}

fn drain_bounded(mut reader: impl Read, maximum: usize) -> io::Result<(Vec<u8>, bool)> {
    let mut retained = Vec::with_capacity(maximum.min(64 * 1024));
    let mut truncated = false;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = maximum.saturating_sub(retained.len());
        let keep = remaining.min(read);
        retained.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
    }
    Ok((retained, truncated))
}

fn git_exit_success(cwd: &str, arguments: &[&str]) -> Result<bool, BridgeRuntimeError> {
    let output = run_git_bounded(cwd, arguments)?;
    if output.stdout_truncated || output.stderr_truncated {
        return Err(BridgeRuntimeError::Invalid(
            "git validation output exceeds its bound".to_owned(),
        ));
    }
    Ok(output.status.success())
}

fn bounded_command_message(output: &BoundedCommandOutput, fallback: &str) -> String {
    let bytes = if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    bounded_operation_message(
        &String::from_utf8_lossy(bytes),
        fallback,
        output.stdout_truncated || output.stderr_truncated,
    )
}

fn bounded_operation_message(value: &str, fallback: &str, source_truncated: bool) -> String {
    let mut message = String::new();
    let mut truncated = source_truncated;
    for character in value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
    {
        if message.len().saturating_add(character.len_utf8()) > MAX_OPERATION_MESSAGE_BYTES {
            truncated = true;
            break;
        }
        message.push(character);
    }
    let mut message = message.trim().to_owned();
    if message.is_empty() {
        return fallback.to_owned();
    }
    if truncated {
        const SUFFIX: &str = " (truncated)";
        while message.len().saturating_add(SUFFIX.len()) > MAX_OPERATION_MESSAGE_BYTES {
            message.pop();
        }
        message.push_str(SUFFIX);
    }
    message
}

fn normalize_absolute_path(value: &str) -> Result<String, BridgeRuntimeError> {
    if value.is_empty()
        || value.len() > MAX_GIT_ARGUMENT_BYTES
        || value.as_bytes().contains(&0)
        || !Path::new(value).is_absolute()
    {
        return Err(BridgeRuntimeError::Invalid(
            "target-local path must be a bounded absolute path".to_owned(),
        ));
    }
    Ok(Path::new(value)
        .components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned())
}

fn normalize_git_path(cwd: &str, value: &str) -> Result<String, BridgeRuntimeError> {
    let path = Path::new(value);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(cwd).join(path)
    };
    normalize_absolute_path(&absolute.to_string_lossy())
}

fn execute_session_create(
    roots: &RemoteRuntimeRoots,
    retention_policy: RemoteRetentionPolicy,
    executable: &Path,
    intent: &RemoteOperationIntent,
    launch: kmux_compat::RemoteSessionLaunchPayload,
) -> Result<OperationResult, BridgeRuntimeError> {
    let descriptor_path =
        session_descriptor_path(Path::new(&roots.state_root), &intent.resource_key);
    let _operation_lock = acquire_session_operation_lock(&descriptor_path)?;
    let _lock = acquire_resource_lock(&descriptor_path)?;
    if let Some(existing) = load_descriptor_optional(&descriptor_path)? {
        if existing.resource_key != intent.resource_key {
            return Err(BridgeRuntimeError::Invalid(
                "session descriptor resource key is inconsistent".to_owned(),
            ));
        }
        if existing.create_operation_id == intent.operation_id
            && existing.canonical_create_payload_hash == intent.canonical_payload_hash
            && existing.state == SessionDescriptorState::Creating
        {
            spawn_keeper(executable, &descriptor_path, &existing.keeper_generation)?;
            let recovered = wait_for_keeper(&descriptor_path, &existing.keeper_generation)?;
            return resolve_existing_operation(&recovered, intent);
        }
        return resolve_existing_operation(&existing, intent);
    }
    if intent.expected_remote_resource_revision != "0" {
        return Ok(operation_failure(
            &intent.operation_id,
            "operation-stale",
            "session does not exist at the expected revision",
        ));
    }
    create_keeper(roots, retention_policy, executable, intent, launch, None)
}

fn execute_session_restart(
    roots: &RemoteRuntimeRoots,
    retention_policy: RemoteRetentionPolicy,
    executable: &Path,
    intent: &RemoteOperationIntent,
    launch: kmux_compat::RemoteSessionLaunchPayload,
) -> Result<OperationResult, BridgeRuntimeError> {
    let descriptor_path =
        session_descriptor_path(Path::new(&roots.state_root), &intent.resource_key);
    let _operation_lock = acquire_session_operation_lock(&descriptor_path)?;
    let lock = acquire_resource_lock(&descriptor_path)?;
    let existing = load_session_descriptor(&descriptor_path)?;
    if existing.last_operation_id == intent.operation_id {
        if existing.last_operation_payload_hash != intent.canonical_payload_hash {
            return resolve_existing_operation(&existing, intent);
        }
        if existing.state == SessionDescriptorState::Creating {
            spawn_keeper(executable, &descriptor_path, &existing.keeper_generation)?;
            let recovered = wait_for_keeper(&descriptor_path, &existing.keeper_generation)?;
            return resolve_existing_operation(&recovered, intent);
        }
        return resolve_existing_operation(&existing, intent);
    }
    if existing.remote_resource_revision != intent.expected_remote_resource_revision {
        return Ok(operation_failure(
            &intent.operation_id,
            "operation-stale",
            "session resource revision is stale",
        ));
    }
    let (lock, existing) = if existing.state == SessionDescriptorState::Running {
        let fence_seed = format!(
            "restart-fence\0{}\0{}",
            intent.operation_id, intent.canonical_payload_hash
        );
        let fence_digest = format!("{:x}", Sha256::digest(fence_seed.as_bytes()));
        let fence_operation_id = format!("restart-fence-{}", &fence_digest[..32]);
        drop(lock);
        terminate_keeper_and_reacquire_lock(
            &descriptor_path,
            &existing,
            &KeeperTerminateRequest {
                message_type: "keeper.terminate",
                keeper_generation: &existing.keeper_generation,
                operation_id: &fence_operation_id,
                payload_hash: &fence_digest,
                next_remote_resource_revision: &intent.expected_remote_resource_revision,
                result_digest: &fence_digest,
            },
        )?
    } else if existing.state == SessionDescriptorState::Creating {
        return Err(BridgeRuntimeError::Retryable(
            "a prior keeper creation is unresolved".to_owned(),
        ));
    } else {
        (lock, existing)
    };
    let _lock = lock;
    create_keeper(
        roots,
        retention_policy,
        executable,
        intent,
        launch,
        Some(&existing),
    )
}

fn execute_session_adopt(
    roots: &RemoteRuntimeRoots,
    intent: &RemoteOperationIntent,
    launch: &kmux_compat::RemoteSessionLaunchPayload,
) -> Result<OperationResult, BridgeRuntimeError> {
    let descriptor_path =
        session_descriptor_path(Path::new(&roots.state_root), &intent.resource_key);
    let _operation_lock = acquire_session_operation_lock(&descriptor_path)?;
    let observed = {
        let _lock = acquire_resource_lock(&descriptor_path)?;
        let descriptor = load_session_descriptor(&descriptor_path)?;
        if descriptor.last_operation_id == intent.operation_id {
            return resolve_existing_operation(&descriptor, intent);
        }
        if let Some(failure) = revision_failure(&descriptor, intent) {
            return Ok(failure);
        }
        if !session_launch_matches(&descriptor, launch) {
            return Ok(operation_failure(
                &intent.operation_id,
                "adopt-launch-mismatch",
                "retained session launch descriptor does not match",
            ));
        }
        descriptor
    };
    require_keeper_running(&observed)?;

    let _lock = acquire_resource_lock(&descriptor_path)?;
    let mut descriptor = load_session_descriptor(&descriptor_path)?;
    if descriptor.last_operation_id == intent.operation_id {
        return resolve_existing_operation(&descriptor, intent);
    }
    if let Some(failure) = revision_failure(&descriptor, intent) {
        return Ok(failure);
    }
    if descriptor.keeper_generation != observed.keeper_generation
        || descriptor.state != SessionDescriptorState::Running
    {
        return Err(BridgeRuntimeError::Retryable(
            "session generation advanced during adoption".to_owned(),
        ));
    }
    if !session_launch_matches(&descriptor, launch) {
        return Ok(operation_failure(
            &intent.operation_id,
            "adopt-launch-mismatch",
            "retained session launch descriptor does not match",
        ));
    }
    let result_digest =
        operation_result_digest(intent, Some(&descriptor.keeper_generation), "succeeded");
    descriptor.remote_resource_revision = intent.next_remote_resource_revision.clone();
    descriptor.last_operation_id = intent.operation_id.clone();
    descriptor.last_operation_payload_hash = intent.canonical_payload_hash.clone();
    descriptor.last_result_digest = result_digest.clone();
    descriptor.updated_at = now_rfc3339();
    write_session_descriptor(&descriptor_path, &descriptor)?;
    Ok(operation_success(
        intent,
        result_digest,
        Some(descriptor.keeper_generation),
    ))
}

fn session_launch_matches(
    descriptor: &SessionDescriptor,
    launch: &kmux_compat::RemoteSessionLaunchPayload,
) -> bool {
    descriptor.launch.cwd == launch.cwd
        && descriptor.launch.shell == launch.shell
        && descriptor.launch.args == launch.args
        && user_launch_env(descriptor.launch.env.as_ref()) == user_launch_env(launch.env.as_ref())
        && descriptor.launch.title == launch.title
}

fn execute_session_terminate(
    roots: &RemoteRuntimeRoots,
    intent: &RemoteOperationIntent,
) -> Result<OperationResult, BridgeRuntimeError> {
    let descriptor_path =
        session_descriptor_path(Path::new(&roots.state_root), &intent.resource_key);
    let _operation_lock = acquire_session_operation_lock(&descriptor_path)?;
    let lock = acquire_resource_lock(&descriptor_path)?;
    let descriptor = load_session_descriptor(&descriptor_path)?;
    if descriptor.last_operation_id == intent.operation_id {
        return resolve_existing_operation(&descriptor, intent);
    }
    if let Some(failure) = revision_failure(&descriptor, intent) {
        return Ok(failure);
    }
    let result_digest =
        operation_result_digest(intent, Some(&descriptor.keeper_generation), "succeeded");
    if descriptor.state == SessionDescriptorState::Running {
        drop(lock);
        let (_lock, _descriptor) = terminate_keeper_and_reacquire_lock(
            &descriptor_path,
            &descriptor,
            &KeeperTerminateRequest {
                message_type: "keeper.terminate",
                keeper_generation: &descriptor.keeper_generation,
                operation_id: &intent.operation_id,
                payload_hash: &intent.canonical_payload_hash,
                next_remote_resource_revision: &intent.next_remote_resource_revision,
                result_digest: &result_digest,
            },
        )?;
    } else {
        let _lock = lock;
        let mut descriptor = descriptor;
        descriptor.state = SessionDescriptorState::Terminated;
        descriptor.remote_resource_revision = intent.next_remote_resource_revision.clone();
        descriptor.last_operation_id = intent.operation_id.clone();
        descriptor.last_operation_payload_hash = intent.canonical_payload_hash.clone();
        descriptor.last_result_digest = result_digest.clone();
        let unavailable_before = parse_u64(&descriptor.storage_status.journal_synced)?
            .checked_add(1)
            .ok_or_else(|| BridgeRuntimeError::Invalid("mutation sequence exhausted".to_owned()))?;
        descriptor.retained_checkpoint = None;
        descriptor.truncated_before_sequence = Some(unavailable_before.to_string());
        descriptor.updated_at = now_rfc3339();
        write_session_descriptor(&descriptor_path, &descriptor)?;
        if cleanup_terminated_retained_data(&descriptor, &descriptor_path).is_err() {
            descriptor.storage_status.state = kmux_compat::RemoteSessionStorageState::Degraded;
            descriptor.updated_at = now_rfc3339();
            let _ = write_session_descriptor(&descriptor_path, &descriptor);
        }
    }
    Ok(operation_success(intent, result_digest, None))
}

fn execute_launch_input(
    roots: &RemoteRuntimeRoots,
    intent: &RemoteOperationIntent,
    input: &str,
) -> Result<OperationResult, BridgeRuntimeError> {
    let descriptor_path =
        session_descriptor_path(Path::new(&roots.state_root), &intent.resource_key);
    let _operation_lock = acquire_session_operation_lock(&descriptor_path)?;
    let observed = {
        let _lock = acquire_resource_lock(&descriptor_path)?;
        let descriptor = load_session_descriptor(&descriptor_path)?;
        if descriptor.last_operation_id == intent.operation_id {
            return resolve_existing_operation(&descriptor, intent);
        }
        if let Some(failure) = revision_failure(&descriptor, intent) {
            return Ok(failure);
        }
        descriptor
    };
    require_keeper_running(&observed)?;
    let input_payload_hash = format!("{:x}", Sha256::digest(input.as_bytes()));
    let response = invoke_keeper_rpc(
        &observed,
        &KeeperLaunchInputRequest {
            message_type: "keeper.launch-input",
            keeper_generation: &observed.keeper_generation,
            operation_id: &intent.operation_id,
            payload_hash: &input_payload_hash,
            input,
        },
    )?;
    let written_offset = require_launch_input_written(response, input.len())?;
    // Reload under the descriptor lock because the keeper durably recorded
    // acceptance/written offset while no bridge descriptor lock was held.
    let _lock = acquire_resource_lock(&descriptor_path)?;
    let mut descriptor = load_session_descriptor(&descriptor_path)?;
    if descriptor.keeper_generation != observed.keeper_generation
        || descriptor.state != SessionDescriptorState::Running
    {
        return Err(BridgeRuntimeError::Retryable(
            "session generation advanced during launch input".to_owned(),
        ));
    }
    if descriptor.last_operation_id == intent.operation_id {
        return resolve_existing_operation(&descriptor, intent);
    }
    if let Some(failure) = revision_failure(&descriptor, intent) {
        return Ok(failure);
    }
    mark_launch_input_written(
        &mut descriptor,
        &intent.operation_id,
        &input_payload_hash,
        input.len(),
        written_offset,
    )?;
    let result_digest =
        operation_result_digest(intent, Some(&descriptor.keeper_generation), "succeeded");
    descriptor.remote_resource_revision = intent.next_remote_resource_revision.clone();
    descriptor.last_operation_id = intent.operation_id.clone();
    descriptor.last_operation_payload_hash = intent.canonical_payload_hash.clone();
    descriptor.last_result_digest = result_digest.clone();
    descriptor.updated_at = now_rfc3339();
    write_session_descriptor(&descriptor_path, &descriptor)?;
    Ok(operation_success(
        intent,
        result_digest,
        Some(descriptor.keeper_generation),
    ))
}

fn require_launch_input_written(
    response: KeeperRpcResponse,
    expected_byte_length: usize,
) -> Result<usize, BridgeRuntimeError> {
    match response {
        KeeperRpcResponse::Result {
            outcome,
            written_offset: Some(written_offset),
            ..
        } if outcome == "written" && written_offset == expected_byte_length => Ok(written_offset),
        KeeperRpcResponse::Error {
            code,
            message,
            retryable,
        } if retryable => Err(BridgeRuntimeError::Retryable(format!("{code}: {message}"))),
        KeeperRpcResponse::Error { code, message, .. } => {
            Err(BridgeRuntimeError::Invalid(format!("{code}: {message}")))
        }
        _ => Err(BridgeRuntimeError::Invalid(
            "keeper returned an invalid launch-input result".to_owned(),
        )),
    }
}

fn mark_launch_input_written(
    descriptor: &mut SessionDescriptor,
    operation_id: &str,
    payload_hash: &str,
    byte_length: usize,
    written_offset: usize,
) -> Result<(), BridgeRuntimeError> {
    let record = descriptor.launch_input.as_mut().ok_or_else(|| {
        BridgeRuntimeError::Invalid("keeper omitted the accepted launch-input record".to_owned())
    })?;
    if record.operation_id != operation_id
        || record.payload_hash != payload_hash
        || record.byte_length != byte_length
        || written_offset != byte_length
        || record.written_offset > written_offset
    {
        return Err(BridgeRuntimeError::Invalid(
            "keeper launch-input record changed identity or offset".to_owned(),
        ));
    }
    record.written_offset = written_offset;
    record.outcome = LaunchInputOutcome::Written;
    Ok(())
}

fn create_keeper(
    roots: &RemoteRuntimeRoots,
    retention_policy: RemoteRetentionPolicy,
    executable: &Path,
    intent: &RemoteOperationIntent,
    mut launch: kmux_compat::RemoteSessionLaunchPayload,
    previous: Option<&SessionDescriptor>,
) -> Result<OperationResult, BridgeRuntimeError> {
    prepare_runtime_directories(roots)?;
    let generation = format!("keeper_{}", Uuid::new_v4());
    let key_digest = resource_key_digest(&intent.resource_key);
    let generation_suffix = generation
        .strip_prefix("keeper_")
        .unwrap_or(&generation)
        .chars()
        .filter(|character| *character != '-')
        .take(8)
        .collect::<String>();
    let socket_path = Path::new(&roots.runtime_root)
        .join("keepers")
        .join(format!("k-{}-{generation_suffix}.sock", &key_digest[..12]));
    if socket_path.as_os_str().as_encoded_bytes().len() > 103 {
        return Err(BridgeRuntimeError::Invalid(
            "keeper socket path exceeds the portable Unix limit".to_owned(),
        ));
    }
    let journal_path = session_journal_path(
        Path::new(&roots.state_root),
        &intent.resource_key,
        &generation,
    );
    let descriptor_path =
        session_descriptor_path(Path::new(&roots.state_root), &intent.resource_key);
    let result_digest = operation_result_digest(intent, Some(&generation), "succeeded");
    let executable_generation = hash_file(executable)?;
    let executable_path = executable.canonicalize()?.to_string_lossy().into_owned();
    let session_id = intent
        .resource_key
        .session_id
        .as_deref()
        .ok_or_else(|| BridgeRuntimeError::Invalid("session ID is required".to_owned()))?;
    let surface_id = launch
        .env
        .as_ref()
        .and_then(|env| env.get("KMUX_SURFACE_ID"))
        .filter(|value| validate_id(value, "KMUX_SURFACE_ID").is_ok())
        .cloned()
        .unwrap_or_else(|| session_id.to_owned());
    let control_token = format!(
        "{:x}",
        Sha256::digest(format!("{}:{}", Uuid::new_v4(), Uuid::new_v4()).as_bytes())
    );
    let endpoint_path = Path::new(&roots.runtime_root)
        .join("hooks")
        .join(format!("h-{}-{generation_suffix}.json", &key_digest[..12]));
    write_session_control_endpoint(
        &endpoint_path,
        &SessionControlEndpoint {
            version: 1,
            resource_key: intent.resource_key.clone(),
            surface_id: surface_id.clone(),
            keeper_generation: generation.clone(),
            state_root: roots.state_root.clone(),
            descriptor_path: descriptor_path.to_string_lossy().into_owned(),
            token_sha256: format!("{:x}", Sha256::digest(control_token.as_bytes())),
        },
    )?;
    let cli_bin = ensure_remote_cli_shims(
        Path::new(&roots.install_root),
        executable,
        &executable_generation,
    )?;
    let mut managed_env = launch.env.take().unwrap_or_default();
    managed_env.remove("KMUX_SOCKET_PATH");
    managed_env.remove("KMUX_AGENT_BIN_DIR");
    managed_env.insert(
        "KMUX_TARGET_ID".to_owned(),
        intent.resource_key.target_id.clone(),
    );
    managed_env.insert(
        "KMUX_WORKSPACE_ID".to_owned(),
        intent.resource_key.workspace_id.clone(),
    );
    managed_env.insert("KMUX_SURFACE_ID".to_owned(), surface_id);
    managed_env.insert("KMUX_SESSION_ID".to_owned(), session_id.to_owned());
    managed_env.insert("KMUX_KEEPER_GENERATION".to_owned(), generation.clone());
    managed_env.insert(
        "KMUX_AGENT_HOOK_ENDPOINT".to_owned(),
        endpoint_path.to_string_lossy().into_owned(),
    );
    managed_env.insert(
        "KMUX_REMOTE_CONTROL_ENDPOINT".to_owned(),
        endpoint_path.to_string_lossy().into_owned(),
    );
    managed_env.insert("KMUX_AUTH_TOKEN".to_owned(), control_token);
    managed_env.insert(
        "KMUX_CLI_PATH".to_owned(),
        cli_bin.join("kmux").to_string_lossy().into_owned(),
    );
    managed_env.insert(
        "KMUX_AGENT_BIN_DIR".to_owned(),
        cli_bin.to_string_lossy().into_owned(),
    );
    launch.env = Some(managed_env);
    let descriptor = SessionDescriptor {
        version: SESSION_DESCRIPTOR_VERSION,
        resource_key: intent.resource_key.clone(),
        keeper_generation: generation.clone(),
        executable_generation,
        executable_path,
        keeper_local_protocol_major: kmux_compat::KEEPER_LOCAL_PROTOCOL_MAJOR,
        terminal_wire_version: kmux_compat::TERMINAL_WIRE_VERSION,
        create_operation_id: previous
            .map(|descriptor| descriptor.create_operation_id.clone())
            .unwrap_or_else(|| intent.operation_id.clone()),
        canonical_create_payload_hash: previous
            .map(|descriptor| descriptor.canonical_create_payload_hash.clone())
            .unwrap_or_else(|| intent.canonical_payload_hash.clone()),
        create_result_digest: previous
            .map(|descriptor| descriptor.create_result_digest.clone())
            .unwrap_or_else(|| result_digest.clone()),
        remote_resource_revision: intent.next_remote_resource_revision.clone(),
        last_operation_id: intent.operation_id.clone(),
        last_operation_payload_hash: intent.canonical_payload_hash.clone(),
        last_result_digest: result_digest.clone(),
        state: SessionDescriptorState::Creating,
        socket_path: socket_path.to_string_lossy().into_owned(),
        journal_path: journal_path.to_string_lossy().into_owned(),
        launch: KeeperLaunchConfig {
            cwd: launch.cwd,
            shell: launch.shell,
            args: launch.args,
            env: launch.env,
            title: launch.title,
            cols: 80,
            rows: 24,
        },
        keeper_pid: None,
        child_pid: None,
        exit_code: None,
        launch_input: None,
        updated_at: now_rfc3339(),
        lifecycle_state: if intent.conversion_transaction_id.is_some() {
            SessionLifecycleState::Provisional
        } else {
            SessionLifecycleState::Committed
        },
        conversion_transaction_id: intent.conversion_transaction_id.clone(),
        remote_snapshot_hash: intent
            .conversion_transaction_id
            .as_ref()
            .map(|_| intent.canonical_payload_hash.clone()),
        provisional_created_at: intent
            .conversion_transaction_id
            .as_ref()
            .map(|_| intent.created_at.clone()),
        ever_granted_writer_lease: false,
        storage_status: RemoteSessionStorageStatus::default(),
        retention_policy,
        retained_checkpoint: None,
        truncated_before_sequence: None,
    };
    write_session_descriptor(&descriptor_path, &descriptor)?;
    spawn_keeper(executable, &descriptor_path, &generation)?;
    let running = wait_for_keeper(&descriptor_path, &generation)?;
    Ok(operation_success(
        intent,
        result_digest,
        Some(running.keeper_generation),
    ))
}

fn user_launch_env(env: Option<&BTreeMap<String, String>>) -> Option<BTreeMap<String, String>> {
    const MANAGED_KEYS: &[&str] = &[
        "KMUX_TARGET_ID",
        "KMUX_WORKSPACE_ID",
        "KMUX_PANE_ID",
        "KMUX_SURFACE_ID",
        "KMUX_SESSION_ID",
        "KMUX_KEEPER_GENERATION",
        "KMUX_AGENT_HOOK_ENDPOINT",
        "KMUX_REMOTE_CONTROL_ENDPOINT",
        "KMUX_AUTH_TOKEN",
        "KMUX_CLI_PATH",
        "KMUX_SOCKET_PATH",
        "KMUX_AGENT_BIN_DIR",
    ];
    let mut sanitized = env?.clone();
    for key in MANAGED_KEYS {
        sanitized.remove(*key);
    }
    (!sanitized.is_empty()).then_some(sanitized)
}

fn spawn_keeper(
    executable: &Path,
    descriptor_path: &Path,
    generation: &str,
) -> Result<(), BridgeRuntimeError> {
    let mut command = Command::new(executable);
    command
        .arg("keeper")
        .arg("serve")
        .arg("--descriptor-path")
        .arg(descriptor_path)
        .arg("--generation")
        .arg(generation)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    spawn_reparented(&mut command)?;
    Ok(())
}

fn wait_for_keeper(
    descriptor_path: &Path,
    generation: &str,
) -> Result<SessionDescriptor, BridgeRuntimeError> {
    let deadline = Instant::now() + KEEPER_START_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(descriptor) = load_session_descriptor(descriptor_path)
            && descriptor.keeper_generation == generation
            && descriptor.state == SessionDescriptorState::Running
            && require_keeper_running(&descriptor).is_ok()
        {
            return Ok(descriptor);
        }
        thread::sleep(Duration::from_millis(20));
    }
    let final_state = load_session_descriptor(descriptor_path)
        .ok()
        .filter(|descriptor| descriptor.keeper_generation == generation)
        .map(|descriptor| {
            format!(
                "state={:?}, exitCode={:?}, keeperPid={:?}, childPid={:?}",
                descriptor.state, descriptor.exit_code, descriptor.keeper_pid, descriptor.child_pid
            )
        })
        .unwrap_or_else(|| "descriptor unavailable".to_owned());
    Err(BridgeRuntimeError::Retryable(format!(
        "keeper did not become ready ({final_state})"
    )))
}

fn require_keeper_running(
    descriptor: &SessionDescriptor,
) -> Result<RemoteSessionStorageStatus, BridgeRuntimeError> {
    if descriptor.state != SessionDescriptorState::Running {
        return Err(BridgeRuntimeError::Invalid(
            "keeper is not running".to_owned(),
        ));
    }
    let response = invoke_keeper_rpc(
        descriptor,
        &KeeperHealthRequest {
            message_type: "keeper.health",
            keeper_generation: &descriptor.keeper_generation,
        },
    )?;
    match response {
        KeeperRpcResponse::Health { outcome, storage } if outcome == "running" => Ok(storage),
        // A same-major keeper from before storage status was added remains
        // compatible through its pinned cohort. It cannot report degraded
        // storage, so preserve the last descriptor status rather than inventing
        // one from the bridge.
        KeeperRpcResponse::Result { outcome, .. } if outcome == "running" => {
            Ok(descriptor.storage_status.clone())
        }
        KeeperRpcResponse::Error {
            code,
            message,
            retryable,
        } if retryable => Err(BridgeRuntimeError::Retryable(format!("{code}: {message}"))),
        KeeperRpcResponse::Error { code, message, .. } => {
            Err(BridgeRuntimeError::Invalid(format!("{code}: {message}")))
        }
        _ => Err(BridgeRuntimeError::Invalid(
            "keeper returned an unexpected health response".to_owned(),
        )),
    }
}

fn keeper_process_is_definitively_absent(
    descriptor: &SessionDescriptor,
) -> Result<bool, BridgeRuntimeError> {
    let pid = descriptor
        .keeper_pid
        .filter(|pid| *pid > 1)
        .and_then(|pid| i32::try_from(pid).ok())
        .ok_or_else(|| BridgeRuntimeError::Invalid("running keeper PID is invalid".to_owned()))?;
    match kill(Pid::from_raw(pid), None) {
        Err(Errno::ESRCH) => Ok(true),
        Ok(()) | Err(Errno::EPERM) => Ok(false),
        Err(error) => Err(BridgeRuntimeError::Retryable(format!(
            "keeper process liveness probe failed: {error}"
        ))),
    }
}

fn require_keeper_success(
    response: KeeperRpcResponse,
    expected: &str,
) -> Result<(), BridgeRuntimeError> {
    match response {
        KeeperRpcResponse::Result { outcome, .. } if outcome == expected => Ok(()),
        KeeperRpcResponse::Health { outcome, .. } if outcome == expected => Ok(()),
        KeeperRpcResponse::Error {
            code,
            message,
            retryable,
        } if retryable => Err(BridgeRuntimeError::Retryable(format!("{code}: {message}"))),
        KeeperRpcResponse::Error { code, message, .. } => {
            Err(BridgeRuntimeError::Invalid(format!("{code}: {message}")))
        }
        KeeperRpcResponse::Result { outcome, .. } => Err(BridgeRuntimeError::Invalid(format!(
            "keeper returned {outcome}, expected {expected}"
        ))),
        KeeperRpcResponse::Health { outcome, .. } => Err(BridgeRuntimeError::Invalid(format!(
            "keeper returned {outcome}, expected {expected}"
        ))),
        KeeperRpcResponse::InputAck { .. }
        | KeeperRpcResponse::CaptureChunk { .. }
        | KeeperRpcResponse::CaptureCompleted { .. } => Err(BridgeRuntimeError::Invalid(
            "keeper returned an unexpected response".to_owned(),
        )),
    }
}

fn terminate_keeper_and_reacquire_lock(
    descriptor_path: &Path,
    descriptor: &SessionDescriptor,
    request: &KeeperTerminateRequest<'_>,
) -> Result<(ResourceLock, SessionDescriptor), BridgeRuntimeError> {
    let mut stream = UnixStream::connect(&descriptor.socket_path)?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    write_control(&mut stream, request)?;
    let first: KeeperRpcResponse = read_control(&mut stream)?.ok_or_else(|| {
        BridgeRuntimeError::Invalid("keeper closed before termination acceptance".to_owned())
    })?;

    match first {
        KeeperRpcResponse::Result { ref outcome, .. } if outcome == "termination-accepted" => {
            // Acceptance means the owner has fenced later keeper commands and
            // signalled the process group. No descriptor lock is retained
            // across this RPC; the keeper is the sole writer of the durable
            // termination tombstone and can finish if the bridge disappears.
            let completed: KeeperRpcResponse = read_control(&mut stream)?.ok_or_else(|| {
                BridgeRuntimeError::Invalid(
                    "keeper closed before durable termination completion".to_owned(),
                )
            })?;
            require_keeper_success(completed, "terminated")?;
        }
        response => {
            // Same-major pinned keepers that predate the two-response protocol
            // may return only their final result.
            require_keeper_success(response, "terminated")?;
        }
    }

    let lock = acquire_resource_lock(descriptor_path)?;
    let completed = load_session_descriptor(descriptor_path)?;
    if completed.resource_key != descriptor.resource_key
        || completed.keeper_generation != descriptor.keeper_generation
        || completed.state != SessionDescriptorState::Terminated
        || completed.last_operation_id != request.operation_id
        || completed.last_operation_payload_hash != request.payload_hash
        || completed.last_result_digest != request.result_digest
        || completed.remote_resource_revision != request.next_remote_resource_revision
    {
        return Err(BridgeRuntimeError::Retryable(
            "session descriptor advanced during termination lock handoff".to_owned(),
        ));
    }
    Ok((lock, completed))
}

struct ConversionPrepareInput {
    transaction_id: String,
    workspace_create_operation_id: String,
    session_create_operation_id: String,
    workspace_resource_key: RemoteResourceKey,
    session_resource_key: RemoteResourceKey,
    source_workspace_revision: String,
    remote_snapshot: String,
    remote_snapshot_hash: String,
    launch: RemoteSessionLaunchPayload,
    prepared_at: String,
}

fn prepare_conversion(
    roots: &RemoteRuntimeRoots,
    retention_policy: RemoteRetentionPolicy,
    executable: &Path,
    input: ConversionPrepareInput,
) -> Result<ConversionPreparedResponse, BridgeRuntimeError> {
    validate_conversion_scope(
        &input.transaction_id,
        &input.workspace_create_operation_id,
        &input.session_create_operation_id,
        &input.workspace_resource_key,
        &input.session_resource_key,
        &input.remote_snapshot_hash,
    )?;
    if !is_sha256(&input.source_workspace_revision)
        || input.remote_snapshot.len() > MAX_CONVERSION_SNAPSHOT_BYTES
        || format!("{:x}", Sha256::digest(input.remote_snapshot.as_bytes()))
            != input.remote_snapshot_hash
        || parse_fixed_rfc3339_millis(&input.prepared_at).is_none()
    {
        return Err(BridgeRuntimeError::Invalid(
            "conversion preparation metadata is invalid".to_owned(),
        ));
    }
    let snapshot_path = conversion_snapshot_path(roots, &input.remote_snapshot_hash);
    let snapshot_inventory_path = snapshot_path
        .parent()
        .ok_or_else(|| {
            BridgeRuntimeError::Invalid("conversion snapshot path has no parent".to_owned())
        })?
        .join("inventory");
    let _snapshot_inventory_lock = acquire_resource_lock(&snapshot_inventory_path)?;
    match fs::symlink_metadata(&snapshot_path) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            ensure_conversion_snapshot_capacity(&snapshot_path)?;
        }
        Err(error) => return Err(error.into()),
    }

    let workspace_path = workspace_descriptor_path(roots, &input.workspace_resource_key);
    let _workspace_lock = acquire_resource_lock(&workspace_path)?;
    let workspace_result_digest = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "conversion-workspace\0{}\0{}\0{}",
                input.transaction_id,
                input.workspace_create_operation_id,
                input.remote_snapshot_hash
            )
            .as_bytes()
        )
    );
    let (workspace, workspace_needs_write) =
        match read_workspace_descriptor_optional(&workspace_path)? {
            Some(existing) => {
                if existing.resource_key != input.workspace_resource_key
                    || existing.create_operation_id != input.workspace_create_operation_id
                    || existing.canonical_create_payload_hash != input.remote_snapshot_hash
                    || existing.conversion_transaction_id.as_deref()
                        != Some(input.transaction_id.as_str())
                    || existing.remote_snapshot_hash.as_deref()
                        != Some(input.remote_snapshot_hash.as_str())
                    || existing.source_workspace_revision.as_deref()
                        != Some(input.source_workspace_revision.as_str())
                    || !matches!(existing.state.as_str(), "provisional" | "active")
                {
                    return Err(BridgeRuntimeError::Invalid(
                        "conversion workspace descriptor conflicts with existing state".to_owned(),
                    ));
                }
                (existing, false)
            }
            None => (
                WorkspaceDescriptor {
                    version: 1,
                    resource_key: input.workspace_resource_key.clone(),
                    create_operation_id: input.workspace_create_operation_id.clone(),
                    canonical_create_payload_hash: input.remote_snapshot_hash.clone(),
                    create_result_digest: workspace_result_digest.clone(),
                    remote_resource_revision: "1".to_owned(),
                    last_operation_id: input.workspace_create_operation_id.clone(),
                    last_operation_payload_hash: input.remote_snapshot_hash.clone(),
                    last_result_digest: workspace_result_digest,
                    state: "provisional".to_owned(),
                    updated_at: now_rfc3339(),
                    conversion_transaction_id: Some(input.transaction_id.clone()),
                    remote_snapshot_hash: Some(input.remote_snapshot_hash.clone()),
                    provisional_created_at: Some(input.prepared_at.clone()),
                    source_workspace_revision: Some(input.source_workspace_revision.clone()),
                    pending_operation: None,
                    failed_operation: None,
                },
                true,
            ),
        };
    if workspace_needs_write {
        write_json_atomic(&workspace_path, &workspace)?;
    }

    let session_intent = RemoteOperationIntent {
        operation_id: input.session_create_operation_id.clone(),
        kind: "session.create".to_owned(),
        resource_key: input.session_resource_key.clone(),
        expected_workspace_revision: input.source_workspace_revision.clone(),
        expected_remote_resource_revision: "0".to_owned(),
        next_remote_resource_revision: "1".to_owned(),
        conversion_transaction_id: Some(input.transaction_id.clone()),
        create_operation_id: Some(input.session_create_operation_id.clone()),
        canonical_payload_hash: input.remote_snapshot_hash.clone(),
        created_at: input.prepared_at.clone(),
    };
    let creation = execute_session_create(
        roots,
        retention_policy,
        executable,
        &session_intent,
        input.launch,
    )?;
    if creation.outcome != "succeeded" {
        return Err(BridgeRuntimeError::Invalid(
            creation
                .message
                .unwrap_or_else(|| "conversion keeper creation failed".to_owned()),
        ));
    }
    let session_path =
        session_descriptor_path(Path::new(&roots.state_root), &input.session_resource_key);
    let _session_lock = acquire_resource_lock(&session_path)?;
    let session = load_session_descriptor(&session_path)?;
    if session.resource_key != input.session_resource_key
        || session.create_operation_id != input.session_create_operation_id
        || session.canonical_create_payload_hash != input.remote_snapshot_hash
        || session.conversion_transaction_id.as_deref() != Some(input.transaction_id.as_str())
        || session.remote_snapshot_hash.as_deref() != Some(input.remote_snapshot_hash.as_str())
        || session.provisional_created_at.as_deref() != Some(input.prepared_at.as_str())
        || session.lifecycle_state == SessionLifecycleState::Abandoned
    {
        return Err(BridgeRuntimeError::Invalid(
            "conversion session descriptor conflicts with existing state".to_owned(),
        ));
    }

    let snapshot = ConversionSnapshotRecord {
        version: 1,
        transaction_id: input.transaction_id.clone(),
        remote_snapshot_hash: input.remote_snapshot_hash.clone(),
        payload: input.remote_snapshot,
        written_at: now_rfc3339(),
    };
    match read_private_json::<ConversionSnapshotRecord>(
        &snapshot_path,
        MAX_CONVERSION_SNAPSHOT_BYTES as u64 + 16 * 1024,
    ) {
        Ok(existing)
            if existing.version == snapshot.version
                && existing.transaction_id == snapshot.transaction_id
                && existing.remote_snapshot_hash == snapshot.remote_snapshot_hash
                && existing.payload == snapshot.payload => {}
        Ok(_) => {
            return Err(BridgeRuntimeError::Invalid(
                "conversion snapshot identity conflicts".to_owned(),
            ));
        }
        Err(BridgeRuntimeError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
            write_json_atomic(&snapshot_path, &snapshot)?;
        }
        Err(error) => return Err(error),
    }

    let session = load_session_descriptor(&session_path)?;
    Ok(ConversionPreparedResponse {
        transaction_id: input.transaction_id,
        remote_snapshot_hash: input.remote_snapshot_hash,
        workspace_descriptor_hash: hash_file(&workspace_path)?,
        session_descriptor_hash: hash_file(&session_path)?,
        keeper_generation: session.keeper_generation,
        remote_resource_revision: session.remote_resource_revision,
        remote_created_at: session.provisional_created_at.unwrap_or(input.prepared_at),
    })
}

fn promote_conversion(
    roots: &RemoteRuntimeRoots,
    transaction_id: &str,
    workspace_create_operation_id: &str,
    session_create_operation_id: &str,
    workspace_resource_key: &RemoteResourceKey,
    session_resource_key: &RemoteResourceKey,
    remote_snapshot_hash: &str,
) -> Result<ConversionPromotedResponse, BridgeRuntimeError> {
    validate_conversion_scope(
        transaction_id,
        workspace_create_operation_id,
        session_create_operation_id,
        workspace_resource_key,
        session_resource_key,
        remote_snapshot_hash,
    )?;
    let snapshot_path = conversion_snapshot_path(roots, remote_snapshot_hash);
    let snapshot: ConversionSnapshotRecord = read_private_json(
        &snapshot_path,
        MAX_CONVERSION_SNAPSHOT_BYTES as u64 + 16 * 1024,
    )?;
    if snapshot.version != 1
        || snapshot.transaction_id != transaction_id
        || snapshot.remote_snapshot_hash != remote_snapshot_hash
        || format!("{:x}", Sha256::digest(snapshot.payload.as_bytes())) != remote_snapshot_hash
    {
        return Err(BridgeRuntimeError::Invalid(
            "conversion promotion snapshot does not match".to_owned(),
        ));
    }

    let workspace_path = workspace_descriptor_path(roots, workspace_resource_key);
    let _workspace_lock = acquire_resource_lock(&workspace_path)?;
    let mut workspace = read_workspace_descriptor_optional(&workspace_path)?.ok_or_else(|| {
        BridgeRuntimeError::Invalid("conversion workspace descriptor is absent".to_owned())
    })?;
    validate_workspace_conversion_descriptor(
        &workspace,
        transaction_id,
        workspace_create_operation_id,
        workspace_resource_key,
        remote_snapshot_hash,
    )?;
    if workspace.state != "active" {
        if workspace.state != "provisional" {
            return Err(BridgeRuntimeError::Invalid(
                "conversion workspace cannot be promoted".to_owned(),
            ));
        }
        workspace.state = "active".to_owned();
        workspace.updated_at = now_rfc3339();
        write_json_atomic(&workspace_path, &workspace)?;
    }

    let session_path = session_descriptor_path(Path::new(&roots.state_root), session_resource_key);
    let _session_operation_lock = acquire_session_operation_lock(&session_path)?;
    let _session_lock = acquire_resource_lock(&session_path)?;
    let mut session = load_session_descriptor(&session_path)?;
    if session.resource_key != *session_resource_key
        || session.create_operation_id != session_create_operation_id
        || session.canonical_create_payload_hash != remote_snapshot_hash
        || session.conversion_transaction_id.as_deref() != Some(transaction_id)
        || session.remote_snapshot_hash.as_deref() != Some(remote_snapshot_hash)
        || session.lifecycle_state == SessionLifecycleState::Abandoned
    {
        return Err(BridgeRuntimeError::Invalid(
            "conversion session descriptor cannot be promoted".to_owned(),
        ));
    }
    if session.lifecycle_state != SessionLifecycleState::Committed {
        session.lifecycle_state = SessionLifecycleState::Committed;
        session.updated_at = now_rfc3339();
        write_session_descriptor(&session_path, &session)?;
    }
    let workspace_hash = hash_file(&workspace_path)?;
    let session_hash = hash_file(&session_path)?;
    let remote_promotion_hash = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}\0{}\0{}\0{}",
                transaction_id, remote_snapshot_hash, workspace_hash, session_hash
            )
            .as_bytes()
        )
    );
    Ok(ConversionPromotedResponse {
        transaction_id: transaction_id.to_owned(),
        remote_snapshot_hash: remote_snapshot_hash.to_owned(),
        remote_promotion_hash,
    })
}

fn reclaim_provisionals(
    roots: &RemoteRuntimeRoots,
    desktop_installation_id: &str,
    target_id: &str,
    protected_transaction_ids: &[String],
    now: &str,
) -> Result<ProvisionalReclaimedResponse, BridgeRuntimeError> {
    validate_id(desktop_installation_id, "desktopInstallationId")?;
    validate_id(target_id, "targetId")?;
    if protected_transaction_ids.len() > MAX_PROTECTED_CONVERSIONS {
        return Err(BridgeRuntimeError::Invalid(
            "protected conversion set exceeds its bound".to_owned(),
        ));
    }
    let now_millis = parse_fixed_rfc3339_millis(now).ok_or_else(|| {
        BridgeRuntimeError::Invalid("provisional reclaim timestamp is invalid".to_owned())
    })?;
    let mut protected = BTreeSet::new();
    for transaction_id in protected_transaction_ids {
        validate_id(transaction_id, "protectedTransactionId")?;
        if !protected.insert(transaction_id.clone()) {
            return Err(BridgeRuntimeError::Invalid(
                "protected conversion set contains duplicates".to_owned(),
            ));
        }
    }
    let directory = Path::new(&roots.state_root).join("sessions");
    ensure_private_directory(&directory)?;
    let mut entries = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    if entries.len() > MAX_SESSION_DESCRIPTORS.saturating_mul(2) {
        return Err(BridgeRuntimeError::Invalid(
            "session inventory exceeds its hard bound".to_owned(),
        ));
    }
    let mut terminated = BTreeSet::new();
    let mut skipped_ever_leased = BTreeSet::new();
    let mut provisional_session_transactions = BTreeSet::new();
    let mut abandoned_snapshots = BTreeMap::new();
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let session_operation_lock = acquire_session_operation_lock(&path)?;
        let mut session_lock = acquire_resource_lock(&path)?;
        let mut descriptor = load_session_descriptor(&path)?;
        if descriptor.resource_key.desktop_installation_id != desktop_installation_id
            || descriptor.resource_key.target_id != target_id
            || descriptor.lifecycle_state != SessionLifecycleState::Provisional
        {
            continue;
        }
        let Some(transaction_id) = descriptor.conversion_transaction_id.clone() else {
            return Err(BridgeRuntimeError::Invalid(
                "provisional session lacks conversion identity".to_owned(),
            ));
        };
        provisional_session_transactions.insert(transaction_id.clone());
        if protected.contains(&transaction_id) {
            continue;
        }
        if descriptor.ever_granted_writer_lease {
            skipped_ever_leased.insert(transaction_id);
            continue;
        }
        let created = descriptor
            .provisional_created_at
            .as_deref()
            .and_then(parse_fixed_rfc3339_millis)
            .ok_or_else(|| {
                BridgeRuntimeError::Invalid("provisional session timestamp is invalid".to_owned())
            })?;
        if now_millis.saturating_sub(created) < PROVISIONAL_TTL_MILLIS {
            continue;
        }
        let next_revision = parse_u64(&descriptor.remote_resource_revision)?
            .checked_add(1)
            .ok_or_else(|| BridgeRuntimeError::Invalid("revision exhausted".to_owned()))?;
        let next_revision_string = next_revision.to_string();
        let payload_hash = format!(
            "{:x}",
            Sha256::digest(format!("provisional-reclaim\0{transaction_id}").as_bytes())
        );
        let operation_id = format!("reclaim-{}", &payload_hash[..32]);
        if descriptor.state == SessionDescriptorState::Running {
            drop(session_lock);
            let (returned_lock, completed) = terminate_keeper_and_reacquire_lock(
                &path,
                &descriptor,
                &KeeperTerminateRequest {
                    message_type: "keeper.terminate",
                    keeper_generation: &descriptor.keeper_generation,
                    operation_id: &operation_id,
                    payload_hash: &payload_hash,
                    next_remote_resource_revision: &next_revision_string,
                    result_digest: &payload_hash,
                },
            )?;
            session_lock = returned_lock;
            descriptor = completed;
        }
        descriptor.lifecycle_state = SessionLifecycleState::Abandoned;
        descriptor.state = SessionDescriptorState::Terminated;
        descriptor.remote_resource_revision = next_revision.to_string();
        descriptor.last_operation_id = operation_id;
        descriptor.last_operation_payload_hash = payload_hash.clone();
        descriptor.last_result_digest = payload_hash;
        let unavailable_before = parse_u64(&descriptor.storage_status.journal_synced)?
            .checked_add(1)
            .ok_or_else(|| BridgeRuntimeError::Invalid("mutation sequence exhausted".to_owned()))?;
        descriptor.retained_checkpoint = None;
        descriptor.truncated_before_sequence = Some(unavailable_before.to_string());
        descriptor.updated_at = now_rfc3339();
        write_session_descriptor(&path, &descriptor)?;
        if cleanup_terminated_retained_data(&descriptor, &path).is_err() {
            descriptor.storage_status.state = kmux_compat::RemoteSessionStorageState::Degraded;
            descriptor.updated_at = now_rfc3339();
            let _ = write_session_descriptor(&path, &descriptor);
        }
        drop(session_lock);
        drop(session_operation_lock);
        if let Some(snapshot_hash) =
            mark_workspace_conversion_abandoned(roots, &descriptor.resource_key, &transaction_id)?
        {
            abandoned_snapshots.insert(transaction_id.clone(), snapshot_hash);
        }
        terminated.insert(transaction_id);
    }
    reclaim_workspace_only_provisionals(
        roots,
        desktop_installation_id,
        target_id,
        &protected,
        &provisional_session_transactions,
        now_millis,
        &mut terminated,
        &mut abandoned_snapshots,
    )?;
    for (transaction_id, snapshot_hash) in &abandoned_snapshots {
        if !skipped_ever_leased.contains(transaction_id) {
            remove_conversion_snapshot(roots, snapshot_hash)?;
        }
    }
    Ok(ProvisionalReclaimedResponse {
        protected_count: protected.len(),
        terminated_transaction_ids: terminated.into_iter().collect(),
        skipped_ever_leased_transaction_ids: skipped_ever_leased.into_iter().collect(),
    })
}

fn validate_conversion_scope(
    transaction_id: &str,
    workspace_create_operation_id: &str,
    session_create_operation_id: &str,
    workspace_resource_key: &RemoteResourceKey,
    session_resource_key: &RemoteResourceKey,
    remote_snapshot_hash: &str,
) -> Result<(), BridgeRuntimeError> {
    validate_id(transaction_id, "transactionId")?;
    validate_id(workspace_create_operation_id, "workspaceCreateOperationId")?;
    validate_id(session_create_operation_id, "sessionCreateOperationId")?;
    validate_resource_key(workspace_resource_key)?;
    validate_resource_key(session_resource_key)?;
    if workspace_resource_key.session_id.is_some()
        || session_resource_key.session_id.is_none()
        || workspace_resource_key.desktop_installation_id
            != session_resource_key.desktop_installation_id
        || workspace_resource_key.target_id != session_resource_key.target_id
        || workspace_resource_key.workspace_id != session_resource_key.workspace_id
        || !is_sha256(remote_snapshot_hash)
    {
        return Err(BridgeRuntimeError::Invalid(
            "conversion resource scope is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_workspace_conversion_descriptor(
    descriptor: &WorkspaceDescriptor,
    transaction_id: &str,
    create_operation_id: &str,
    resource_key: &RemoteResourceKey,
    remote_snapshot_hash: &str,
) -> Result<(), BridgeRuntimeError> {
    if descriptor.resource_key != *resource_key
        || descriptor.create_operation_id != create_operation_id
        || descriptor.canonical_create_payload_hash != remote_snapshot_hash
        || descriptor.conversion_transaction_id.as_deref() != Some(transaction_id)
        || descriptor.remote_snapshot_hash.as_deref() != Some(remote_snapshot_hash)
    {
        return Err(BridgeRuntimeError::Invalid(
            "conversion workspace descriptor identity differs".to_owned(),
        ));
    }
    Ok(())
}

fn workspace_descriptor_path(roots: &RemoteRuntimeRoots, key: &RemoteResourceKey) -> PathBuf {
    Path::new(&roots.state_root)
        .join("workspaces")
        .join(format!("{}.json", resource_key_digest(key)))
}

fn conversion_snapshot_path(roots: &RemoteRuntimeRoots, hash: &str) -> PathBuf {
    Path::new(&roots.state_root)
        .join("conversions")
        .join("snapshots")
        .join(format!("{hash}.json"))
}

fn mark_workspace_conversion_abandoned(
    roots: &RemoteRuntimeRoots,
    session_key: &RemoteResourceKey,
    transaction_id: &str,
) -> Result<Option<String>, BridgeRuntimeError> {
    let workspace_key = RemoteResourceKey {
        desktop_installation_id: session_key.desktop_installation_id.clone(),
        target_id: session_key.target_id.clone(),
        workspace_id: session_key.workspace_id.clone(),
        session_id: None,
    };
    let path = workspace_descriptor_path(roots, &workspace_key);
    let _workspace_lock = acquire_resource_lock(&path)?;
    if let Some(mut descriptor) = read_workspace_descriptor_optional(&path)?
        && descriptor.conversion_transaction_id.as_deref() == Some(transaction_id)
        && descriptor.state == "provisional"
    {
        let snapshot_hash = descriptor.remote_snapshot_hash.clone();
        descriptor.state = "abandoned".to_owned();
        descriptor.updated_at = now_rfc3339();
        write_json_atomic(&path, &descriptor)?;
        return Ok(snapshot_hash);
    }
    Ok(None)
}

#[allow(clippy::too_many_arguments)]
fn reclaim_workspace_only_provisionals(
    roots: &RemoteRuntimeRoots,
    desktop_installation_id: &str,
    target_id: &str,
    protected: &BTreeSet<String>,
    provisional_session_transactions: &BTreeSet<String>,
    now_millis: u64,
    terminated: &mut BTreeSet<String>,
    abandoned_snapshots: &mut BTreeMap<String, String>,
) -> Result<(), BridgeRuntimeError> {
    let directory = Path::new(&roots.state_root).join("workspaces");
    ensure_private_directory(&directory)?;
    let mut entries = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    if entries.len() > MAX_SESSION_DESCRIPTORS.saturating_mul(2) {
        return Err(BridgeRuntimeError::Invalid(
            "workspace inventory exceeds its hard bound".to_owned(),
        ));
    }
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let _workspace_lock = acquire_resource_lock(&path)?;
        let Some(mut descriptor) = read_workspace_descriptor_optional(&path)? else {
            continue;
        };
        if descriptor.resource_key.desktop_installation_id != desktop_installation_id
            || descriptor.resource_key.target_id != target_id
            || descriptor.resource_key.session_id.is_some()
            || descriptor.state != "provisional"
        {
            continue;
        }
        let Some(transaction_id) = descriptor.conversion_transaction_id.clone() else {
            return Err(BridgeRuntimeError::Invalid(
                "provisional workspace lacks conversion identity".to_owned(),
            ));
        };
        if protected.contains(&transaction_id)
            || provisional_session_transactions.contains(&transaction_id)
        {
            continue;
        }
        let created = descriptor
            .provisional_created_at
            .as_deref()
            .and_then(parse_fixed_rfc3339_millis)
            .ok_or_else(|| {
                BridgeRuntimeError::Invalid("provisional workspace timestamp is invalid".to_owned())
            })?;
        if now_millis.saturating_sub(created) < PROVISIONAL_TTL_MILLIS {
            continue;
        }
        let snapshot_hash = descriptor.remote_snapshot_hash.clone().ok_or_else(|| {
            BridgeRuntimeError::Invalid("provisional workspace lacks snapshot identity".to_owned())
        })?;
        if !is_sha256(&snapshot_hash) {
            return Err(BridgeRuntimeError::Invalid(
                "provisional workspace snapshot identity is invalid".to_owned(),
            ));
        }
        descriptor.state = "abandoned".to_owned();
        descriptor.updated_at = now_rfc3339();
        write_json_atomic(&path, &descriptor)?;
        abandoned_snapshots.insert(transaction_id.clone(), snapshot_hash);
        terminated.insert(transaction_id);
    }
    Ok(())
}

fn ensure_conversion_snapshot_capacity(path: &Path) -> Result<(), BridgeRuntimeError> {
    let directory = path.parent().ok_or_else(|| {
        BridgeRuntimeError::Invalid("conversion snapshot path has no parent".to_owned())
    })?;
    ensure_private_directory(directory)?;
    let entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    let snapshots = entries
        .iter()
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .count();
    if snapshots >= MAX_CONVERSION_SNAPSHOTS {
        return Err(BridgeRuntimeError::Invalid(
            "conversion snapshot inventory exceeds its hard bound".to_owned(),
        ));
    }
    Ok(())
}

fn remove_conversion_snapshot(
    roots: &RemoteRuntimeRoots,
    snapshot_hash: &str,
) -> Result<(), BridgeRuntimeError> {
    if !is_sha256(snapshot_hash) {
        return Err(BridgeRuntimeError::Invalid(
            "conversion snapshot identity is invalid".to_owned(),
        ));
    }
    let path = conversion_snapshot_path(roots, snapshot_hash);
    let inventory_path = path
        .parent()
        .ok_or_else(|| {
            BridgeRuntimeError::Invalid("conversion snapshot path has no parent".to_owned())
        })?
        .join("inventory");
    let _inventory_lock = acquire_resource_lock(&inventory_path)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(BridgeRuntimeError::Invalid(
            "conversion snapshot is unsafe".to_owned(),
        ));
    }
    fs::remove_file(&path)?;
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn parse_fixed_rfc3339_millis(value: &str) -> Option<u64> {
    if value.len() != 24
        || &value[4..5] != "-"
        || &value[7..8] != "-"
        || &value[10..11] != "T"
        || &value[13..14] != ":"
        || &value[16..17] != ":"
        || &value[19..20] != "."
        || &value[23..24] != "Z"
    {
        return None;
    }
    let year = value[0..4].parse::<i64>().ok()?;
    let month = value[5..7].parse::<i64>().ok()?;
    let day = value[8..10].parse::<i64>().ok()?;
    let hour = value[11..13].parse::<i64>().ok()?;
    let minute = value[14..16].parse::<i64>().ok()?;
    let second = value[17..19].parse::<i64>().ok()?;
    let millis = value[20..23].parse::<i64>().ok()?;
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => return None,
    };
    if !(1970..=9999).contains(&year)
        || !(1..=days_in_month).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=59).contains(&second)
    {
        return None;
    }
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    if days < 0 {
        return None;
    }
    u64::try_from((((days * 24 + hour) * 60 + minute) * 60 + second) * 1_000 + millis).ok()
}

fn observe(
    roots: &RemoteRuntimeRoots,
    bridge_generation: &str,
    desktop_installation_id: &str,
    target_id: &str,
) -> Result<ObservedResponse, BridgeRuntimeError> {
    validate_id(desktop_installation_id, "desktopInstallationId")?;
    validate_id(target_id, "targetId")?;
    let workspace_directory = Path::new(&roots.state_root).join("workspaces");
    ensure_private_directory(&workspace_directory)?;
    let mut workspace_entries =
        fs::read_dir(&workspace_directory)?.collect::<Result<Vec<_>, _>>()?;
    workspace_entries.sort_by_key(|entry| entry.file_name());
    if workspace_entries.len() > MAX_SESSION_DESCRIPTORS.saturating_mul(2) {
        return Err(BridgeRuntimeError::Invalid(
            "workspace inventory exceeds its hard bound".to_owned(),
        ));
    }
    let mut workspaces = Vec::new();
    for entry in workspace_entries {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let _workspace_lock = acquire_resource_lock(&path)?;
        let Some(descriptor) = read_workspace_descriptor_optional(&path)? else {
            continue;
        };
        if descriptor.resource_key.desktop_installation_id != desktop_installation_id
            || descriptor.resource_key.target_id != target_id
        {
            continue;
        }
        if descriptor.resource_key.session_id.is_some() {
            return Err(BridgeRuntimeError::Invalid(
                "workspace descriptor identifies a session".to_owned(),
            ));
        }
        if descriptor.pending_operation.is_some() {
            return Err(BridgeRuntimeError::Retryable(
                "workspace inventory contains an unresolved mutation".to_owned(),
            ));
        }
        workspaces.push(ObservedWorkspace {
            resource_key: descriptor.resource_key,
            state: descriptor.state,
            remote_resource_revision: descriptor.remote_resource_revision,
            create_operation_id: descriptor.create_operation_id,
            canonical_create_payload_hash: descriptor.canonical_create_payload_hash,
            last_operation_id: descriptor.last_operation_id,
            last_operation_payload_hash: descriptor.last_operation_payload_hash,
            last_result_digest: descriptor.last_result_digest,
        });
        if workspaces.len() > MAX_SESSION_DESCRIPTORS {
            return Err(BridgeRuntimeError::Invalid(
                "workspace inventory exceeds its hard bound".to_owned(),
            ));
        }
    }
    let directory = Path::new(&roots.state_root).join("sessions");
    ensure_private_directory(&directory)?;
    let mut entries = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    if entries.len() > MAX_SESSION_DESCRIPTORS.saturating_mul(2) {
        return Err(BridgeRuntimeError::Invalid(
            "session inventory exceeds its hard bound".to_owned(),
        ));
    }
    let mut keepers = Vec::new();
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let observed = {
            let _session_lock = acquire_resource_lock(&path)?;
            load_session_descriptor(&path)?
        };
        if observed.resource_key.desktop_installation_id != desktop_installation_id
            || observed.resource_key.target_id != target_id
        {
            continue;
        }
        if observed.state == SessionDescriptorState::Creating {
            return Err(BridgeRuntimeError::Retryable(
                "session inventory contains an unresolved creation".to_owned(),
            ));
        }
        // The keeper's single owner loop may already be admitting a first
        // writer and need this descriptor lock to persist its safety bit.
        // Never wait for keeper health while retaining the same lock.
        let observed_health = if observed.state == SessionDescriptorState::Running {
            match require_keeper_running(&observed) {
                Ok(storage) => Some(storage),
                Err(_) if keeper_process_is_definitively_absent(&observed)? => None,
                Err(_) => {
                    return Err(BridgeRuntimeError::Retryable(
                        "keeper liveness could not be authoritatively observed".to_owned(),
                    ));
                }
            }
        } else {
            None
        };
        let descriptor = {
            let _session_lock = acquire_resource_lock(&path)?;
            let current = load_session_descriptor(&path)?;
            if current.resource_key != observed.resource_key
                || current.keeper_generation != observed.keeper_generation
            {
                return Err(BridgeRuntimeError::Retryable(
                    "session generation advanced during observation".to_owned(),
                ));
            }
            current
        };
        let (process_state, storage_status) = if descriptor.state == SessionDescriptorState::Running
        {
            match observed_health {
                Some(storage) => ("running", storage),
                None => ("exited", descriptor.storage_status.clone()),
            }
        } else {
            ("exited", descriptor.storage_status.clone())
        };
        keepers.push(ObservedKeeper {
            resource_key: descriptor.resource_key,
            keeper_generation: descriptor.keeper_generation,
            descriptor_state: match descriptor.state {
                SessionDescriptorState::Creating => "creating",
                SessionDescriptorState::Running => "running",
                SessionDescriptorState::Exited => "exited",
                SessionDescriptorState::Terminated => "terminated",
            }
            .to_owned(),
            process_state: process_state.to_owned(),
            remote_resource_revision: descriptor.remote_resource_revision,
            exit_code: descriptor.exit_code,
            create_operation_id: descriptor.create_operation_id,
            canonical_create_payload_hash: descriptor.canonical_create_payload_hash,
            last_operation_id: descriptor.last_operation_id,
            last_operation_payload_hash: descriptor.last_operation_payload_hash,
            last_result_digest: descriptor.last_result_digest,
            launch: RemoteSessionLaunchPayload {
                cwd: descriptor.launch.cwd,
                shell: descriptor.launch.shell,
                args: descriptor.launch.args,
                env: user_launch_env(descriptor.launch.env.as_ref()),
                title: descriptor.launch.title,
            },
            lifecycle_state: match descriptor.lifecycle_state {
                SessionLifecycleState::Committed => "committed",
                SessionLifecycleState::Provisional => "provisional",
                SessionLifecycleState::Abandoned => "abandoned",
            }
            .to_owned(),
            conversion_transaction_id: descriptor.conversion_transaction_id,
            remote_snapshot_hash: descriptor.remote_snapshot_hash,
            provisional_created_at: descriptor.provisional_created_at,
            ever_granted_writer_lease: descriptor.ever_granted_writer_lease,
            storage_status,
            checkpoint_available: descriptor.retained_checkpoint.is_some(),
            retained_range_truncated: descriptor.truncated_before_sequence.is_some(),
        });
        if keepers.len() > MAX_SESSION_DESCRIPTORS {
            return Err(BridgeRuntimeError::Invalid(
                "session inventory exceeds its hard bound".to_owned(),
            ));
        }
    }
    Ok(ObservedResponse {
        target_id: target_id.to_owned(),
        bridge_generation: bridge_generation.to_owned(),
        observed_at: now_rfc3339(),
        workspaces,
        keepers,
    })
}

fn inject_terminal_input(
    roots: &RemoteRuntimeRoots,
    resource_key: RemoteResourceKey,
    expected_keeper_generation: &str,
    operation_id: &str,
    payload_hash: &str,
    input: &str,
) -> Result<TerminalInputAckResponse, BridgeRuntimeError> {
    validate_resource_key(&resource_key)?;
    validate_id(expected_keeper_generation, "expectedKeeperGeneration")?;
    validate_id(operation_id, "operationId")?;
    if !is_sha256(payload_hash)
        || input.len() > kmux_compat::REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES
        || format!("{:x}", Sha256::digest(input.as_bytes())) != payload_hash
    {
        return Err(BridgeRuntimeError::Invalid(
            "terminal injection payload is invalid".to_owned(),
        ));
    }
    let descriptor_path = session_descriptor_path(Path::new(&roots.state_root), &resource_key);
    let descriptor = {
        let _lock = acquire_resource_lock(&descriptor_path)?;
        let descriptor = load_session_descriptor(&descriptor_path)?;
        if descriptor.resource_key != resource_key
            || descriptor.keeper_generation != expected_keeper_generation
        {
            return Err(BridgeRuntimeError::Invalid(
                "terminal injection generation or resource changed".to_owned(),
            ));
        }
        descriptor
    };
    require_keeper_running(&descriptor)?;
    let response = invoke_keeper_rpc(
        &descriptor,
        &KeeperOperationInputRequest {
            message_type: "keeper.operation-input",
            resource_key: &resource_key,
            keeper_generation: expected_keeper_generation,
            operation_id,
            payload_hash,
            input,
        },
    )?;
    match response {
        KeeperRpcResponse::InputAck {
            operation_id: acknowledged_operation_id,
            keeper_generation,
            writer_lease_id,
            byte_length,
            boundary,
        } if acknowledged_operation_id == operation_id
            && keeper_generation == expected_keeper_generation
            && byte_length == input.len()
            && boundary == "pty-write" =>
        {
            Ok(TerminalInputAckResponse {
                resource_key,
                keeper_generation,
                operation_id: acknowledged_operation_id,
                writer_lease_id,
                byte_length,
                boundary,
            })
        }
        KeeperRpcResponse::Error {
            code,
            message,
            retryable,
        } if retryable => Err(BridgeRuntimeError::Retryable(format!("{code}: {message}"))),
        KeeperRpcResponse::Error { code, message, .. } => {
            Err(BridgeRuntimeError::Invalid(format!("{code}: {message}")))
        }
        _ => Err(BridgeRuntimeError::Invalid(
            "keeper returned an invalid terminal injection acknowledgement".to_owned(),
        )),
    }
}

fn capture_surface_request(
    roots: &RemoteRuntimeRoots,
    resource_key: RemoteResourceKey,
    expected_keeper_generation: &str,
    capture_id: &str,
    line_limit: usize,
    max_bytes: usize,
) -> Result<kmux_keeper::KeeperCaptureResult, BridgeRuntimeError> {
    validate_resource_key(&resource_key)?;
    validate_id(expected_keeper_generation, "expectedKeeperGeneration")?;
    validate_id(capture_id, "captureId")?;
    if line_limit == 0
        || line_limit > kmux_keeper::MAX_SURFACE_CAPTURE_LINES
        || max_bytes == 0
        || max_bytes > kmux_keeper::MAX_SURFACE_CAPTURE_BYTES
    {
        return Err(BridgeRuntimeError::Invalid(
            "surface capture bounds are invalid".to_owned(),
        ));
    }
    let descriptor_path = session_descriptor_path(Path::new(&roots.state_root), &resource_key);
    let descriptor = {
        let _lock = acquire_resource_lock(&descriptor_path)?;
        let descriptor = load_session_descriptor(&descriptor_path)?;
        if descriptor.resource_key != resource_key
            || descriptor.keeper_generation != expected_keeper_generation
        {
            return Err(BridgeRuntimeError::Invalid(
                "surface capture generation or resource changed".to_owned(),
            ));
        }
        descriptor
    };
    require_keeper_running(&descriptor)?;
    invoke_keeper_capture(
        &descriptor,
        &KeeperCaptureRequest {
            message_type: "keeper.capture",
            resource_key: &resource_key,
            keeper_generation: expected_keeper_generation,
            capture_id,
            line_limit,
            max_bytes,
        },
    )
    .map_err(Into::into)
}

fn replay_remote_events(
    roots: &RemoteRuntimeRoots,
    desktop_installation_id: &str,
    target_id: &str,
    after_sequence: &str,
) -> Result<EventsReplayedResponse, BridgeRuntimeError> {
    validate_id(desktop_installation_id, "desktopInstallationId")?;
    validate_id(target_id, "targetId")?;
    let after_sequence = parse_u64(after_sequence)?;
    let page = replay_events(
        Path::new(&roots.state_root),
        desktop_installation_id,
        target_id,
        after_sequence,
    )?;
    Ok(EventsReplayedResponse {
        target_id: target_id.to_owned(),
        events: page
            .events
            .into_iter()
            .map(|event| RemoteSpoolEvent {
                version: event.version,
                sequence: event.sequence,
                event_id: event.event_id,
                kind: event.kind,
                name: event.name,
                resource_key: event.resource_key,
                surface_id: event.surface_id,
                keeper_generation: event.keeper_generation,
                created_at_unix_ms: event.created_at_unix_ms,
                payload: event.payload,
            })
            .collect(),
        acknowledged_through: page.acknowledged_through,
        has_more: page.has_more,
        admitted_count: page.admitted_count.to_string(),
        dropped_low_value_count: page.dropped_low_value_count.to_string(),
    })
}

fn acknowledge_remote_events(
    roots: &RemoteRuntimeRoots,
    desktop_installation_id: &str,
    target_id: &str,
    through_sequence: &str,
) -> Result<EventsAcknowledgedResponse, BridgeRuntimeError> {
    validate_id(desktop_installation_id, "desktopInstallationId")?;
    validate_id(target_id, "targetId")?;
    let acknowledgement = acknowledge_events(
        Path::new(&roots.state_root),
        desktop_installation_id,
        target_id,
        parse_u64(through_sequence)?,
    )?;
    Ok(EventsAcknowledgedResponse {
        target_id: target_id.to_owned(),
        acknowledged_through: acknowledgement.acknowledged_through,
        removed_count: acknowledgement.removed_count,
    })
}

fn authorize_attach(
    roots: &RemoteRuntimeRoots,
    resource_key: RemoteResourceKey,
    expected_generation: Option<&str>,
    access: kmux_compat::AttachmentAccess,
) -> Result<AttachAuthorizedResponse, BridgeRuntimeError> {
    if resource_key.session_id.is_none() {
        return Err(BridgeRuntimeError::Invalid(
            "attach requires a session resource".to_owned(),
        ));
    }
    let descriptor_path = session_descriptor_path(Path::new(&roots.state_root), &resource_key);
    let observed = {
        let _session_lock = acquire_resource_lock(&descriptor_path)?;
        let descriptor = load_session_descriptor(&descriptor_path)?;
        validate_attach_descriptor(&descriptor, &resource_key, expected_generation)?;
        descriptor
    };

    // Keeper RPC handling may itself need the descriptor lock (the first
    // writer lease is persisted before it is granted). Never wait on a keeper
    // while holding that same lock: concurrent attachment authorization would
    // otherwise deadlock the single-threaded keeper owner loop.
    require_keeper_running(&observed)?;

    let _session_lock = acquire_resource_lock(&descriptor_path)?;
    let descriptor = load_session_descriptor(&descriptor_path)?;
    validate_attach_descriptor(&descriptor, &resource_key, expected_generation)?;
    if descriptor.keeper_generation != observed.keeper_generation {
        return Err(BridgeRuntimeError::Retryable(
            "keeper generation changed during attach authorization".to_owned(),
        ));
    }
    let (attach_capability, expires_at, terminal_proxy) = if descriptor.keeper_local_protocol_major
        == kmux_compat::KEEPER_LOCAL_PROTOCOL_MAJOR
    {
        let (capability, expires_at) =
            write_attach_capability(roots, &resource_key, &descriptor.keeper_generation, access)?;
        (capability, expires_at, TerminalProxyEndpoint::Direct)
    } else {
        if descriptor.terminal_wire_version != kmux_compat::TERMINAL_WIRE_VERSION {
            return Err(BridgeRuntimeError::Invalid(
                "terminal-wire-incompatible".to_owned(),
            ));
        }
        // Cohort startup/probing is an external bounded operation. The
        // generation-scoped capability remains fail-closed if the descriptor
        // changes, so it must not extend the descriptor lock's critical
        // section and block a keeper that is admitting another attachment.
        drop(_session_lock);
        let (capability, expires_at_unix_ms, expires_at) = new_attach_capability()?;
        let endpoint = ensure_cohort_proxy(roots, &descriptor)?;
        authorize_cohort_proxy(
            &endpoint.socket_path,
            CohortAttachCapability {
                roots: roots.clone(),
                resource_key: resource_key.clone(),
                keeper_generation: descriptor.keeper_generation.clone(),
                expires_at_unix_ms,
                access,
            },
            &capability,
        )?;
        (
            capability,
            expires_at,
            TerminalProxyEndpoint::Cohort {
                executable_path: endpoint.executable_path,
                socket_path: endpoint.socket_path.to_string_lossy().into_owned(),
                keeper_local_protocol_major: descriptor.keeper_local_protocol_major,
            },
        )
    };
    Ok(AttachAuthorizedResponse {
        resource_key,
        keeper_generation: descriptor.keeper_generation,
        attach_capability,
        expires_at,
        access,
        terminal_proxy,
    })
}

fn validate_attach_descriptor(
    descriptor: &SessionDescriptor,
    resource_key: &RemoteResourceKey,
    expected_generation: Option<&str>,
) -> Result<(), BridgeRuntimeError> {
    if descriptor.resource_key != *resource_key
        || expected_generation.is_some_and(|generation| generation != descriptor.keeper_generation)
    {
        return Err(BridgeRuntimeError::Invalid(
            "keeper generation mismatch".to_owned(),
        ));
    }
    if descriptor.state != SessionDescriptorState::Running {
        return Err(BridgeRuntimeError::Invalid(
            "keeper is not running".to_owned(),
        ));
    }
    Ok(())
}

struct CohortEndpoint {
    executable_path: String,
    socket_path: PathBuf,
}

fn ensure_cohort_proxy(
    roots: &RemoteRuntimeRoots,
    descriptor: &SessionDescriptor,
) -> Result<CohortEndpoint, BridgeRuntimeError> {
    let executable_path = verify_pinned_executable(descriptor)?;
    let cohort_directory = Path::new(&roots.runtime_root).join("cohorts");
    ensure_private_directory(&cohort_directory)?;
    let target_digest = format!(
        "{:x}",
        Sha256::digest(descriptor.resource_key.target_id.as_bytes())
    );
    let socket_path = cohort_directory.join(format!(
        "c-{}-p{}.sock",
        &target_digest[..12],
        descriptor.keeper_local_protocol_major
    ));
    if socket_path.as_os_str().as_encoded_bytes().len() > 103 {
        return Err(BridgeRuntimeError::Invalid(
            "cohort proxy socket path exceeds the portable Unix limit".to_owned(),
        ));
    }
    let _lock = acquire_resource_lock(&socket_path)?;
    match probe_cohort_proxy(&socket_path, descriptor)? {
        CohortProbe::Healthy => {}
        CohortProbe::Missing => {
            remove_stale_cohort_socket(&socket_path)?;
            let mut command = Command::new(&executable_path);
            command
                .arg("bridge")
                .arg("cohort-proxy")
                .arg("serve")
                .arg("--socket-path")
                .arg(&socket_path)
                .arg("--state-root")
                .arg(&roots.state_root)
                .arg("--runtime-root")
                .arg(&roots.runtime_root)
                .arg("--target-id")
                .arg(&descriptor.resource_key.target_id)
                .arg("--executable-generation")
                .arg(&descriptor.executable_generation)
                .arg("--keeper-local-protocol-major")
                .arg(descriptor.keeper_local_protocol_major.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            spawn_reparented(&mut command)?;
            let deadline = Instant::now() + COHORT_START_TIMEOUT;
            loop {
                match probe_cohort_proxy(&socket_path, descriptor)? {
                    CohortProbe::Healthy => break,
                    CohortProbe::Missing if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    CohortProbe::Missing => {
                        return Err(BridgeRuntimeError::Retryable(
                            "pinned cohort proxy did not become ready".to_owned(),
                        ));
                    }
                }
            }
        }
    }
    Ok(CohortEndpoint {
        executable_path: executable_path.to_string_lossy().into_owned(),
        socket_path,
    })
}

enum CohortProbe {
    Healthy,
    Missing,
}

fn probe_cohort_proxy(
    socket_path: &Path,
    descriptor: &SessionDescriptor,
) -> Result<CohortProbe, BridgeRuntimeError> {
    let mut stream = match UnixStream::connect(socket_path) {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(CohortProbe::Missing);
        }
        Err(error) => return Err(error.into()),
    };
    stream.set_read_timeout(Some(COHORT_CONNECT_TIMEOUT))?;
    stream.set_write_timeout(Some(COHORT_CONNECT_TIMEOUT))?;
    write_control(
        &mut stream,
        &CohortProxyRequest::Health {
            target_id: descriptor.resource_key.target_id.clone(),
            keeper_local_protocol_major: descriptor.keeper_local_protocol_major,
        },
    )?;
    match read_control(&mut stream)? {
        Some(CohortProxyResponse::Healthy {
            target_id,
            keeper_local_protocol_major,
            executable_generation,
        }) if target_id == descriptor.resource_key.target_id
            && keeper_local_protocol_major == descriptor.keeper_local_protocol_major
            && is_sha256(&executable_generation) =>
        {
            Ok(CohortProbe::Healthy)
        }
        _ => Err(BridgeRuntimeError::Invalid(
            "existing cohort proxy identity is incompatible".to_owned(),
        )),
    }
}

fn authorize_cohort_proxy(
    socket_path: &Path,
    capability: CohortAttachCapability,
    token: &str,
) -> Result<(), BridgeRuntimeError> {
    let mut stream = UnixStream::connect(socket_path)?;
    stream.set_read_timeout(Some(COHORT_CONNECT_TIMEOUT))?;
    stream.set_write_timeout(Some(COHORT_CONNECT_TIMEOUT))?;
    write_control(
        &mut stream,
        &CohortProxyRequest::Authorize {
            roots: capability.roots,
            resource_key: capability.resource_key,
            keeper_generation: capability.keeper_generation,
            attach_capability: token.to_owned(),
            expires_at_unix_ms: capability.expires_at_unix_ms,
            access: capability.access,
        },
    )?;
    match read_control(&mut stream)? {
        Some(CohortProxyResponse::Authorized {}) => Ok(()),
        Some(CohortProxyResponse::Error { message, .. }) => {
            Err(BridgeRuntimeError::Invalid(message))
        }
        _ => Err(BridgeRuntimeError::Invalid(
            "cohort proxy returned an invalid authorization response".to_owned(),
        )),
    }
}

fn verify_pinned_executable(descriptor: &SessionDescriptor) -> Result<PathBuf, BridgeRuntimeError> {
    let path = PathBuf::from(&descriptor.executable_path);
    verify_pinned_executable_contract(
        &path,
        &descriptor.executable_generation,
        descriptor.keeper_local_protocol_major,
        descriptor.terminal_wire_version,
    )?;
    Ok(path)
}

fn verify_pinned_executable_contract(
    path: &Path,
    executable_generation: &str,
    keeper_local_protocol_major: u16,
    terminal_wire_version: u16,
) -> Result<(), BridgeRuntimeError> {
    if !path.is_absolute() {
        return Err(BridgeRuntimeError::Invalid(
            "pinned executable path is not absolute".to_owned(),
        ));
    }
    if !is_sha256(executable_generation)
        || keeper_local_protocol_major == 0
        || terminal_wire_version == 0
    {
        return Err(BridgeRuntimeError::Invalid(
            "pinned executable protocol identity is invalid".to_owned(),
        ));
    }
    if path.file_name().and_then(|value| value.to_str()) != Some("kmuxd") {
        return Err(BridgeRuntimeError::Invalid(
            "pinned executable name is invalid".to_owned(),
        ));
    }
    let generation_directory = path.parent().ok_or_else(|| {
        BridgeRuntimeError::Invalid("pinned executable has no generation directory".to_owned())
    })?;
    let directory_metadata = fs::symlink_metadata(generation_directory)?;
    if !directory_metadata.file_type().is_dir()
        || directory_metadata.file_type().is_symlink()
        || directory_metadata.uid() != effective_uid()
        || directory_metadata.mode() & 0o077 != 0
    {
        return Err(BridgeRuntimeError::Invalid(
            "pinned generation directory is unsafe".to_owned(),
        ));
    }
    let mut executable = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = executable.metadata()?;
    if !metadata.file_type().is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_RUNTIME_EXECUTABLE_BYTES
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o111 == 0
        || metadata.mode() & 0o077 != 0
    {
        return Err(BridgeRuntimeError::Invalid(
            "pinned executable is missing, unsafe, or corrupt".to_owned(),
        ));
    }
    let actual_generation =
        hash_reader(&mut (&mut executable).take(MAX_RUNTIME_EXECUTABLE_BYTES.saturating_add(1)))?;
    let manifest_path = generation_directory.join("manifest.json");
    let mut manifest_file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&manifest_path)?;
    let manifest_metadata = manifest_file.metadata()?;
    if !manifest_metadata.file_type().is_file()
        || manifest_metadata.uid() != effective_uid()
        || manifest_metadata.mode() & 0o077 != 0
        || manifest_metadata.len() == 0
        || manifest_metadata.len() > MAX_REMOTE_RUNTIME_MANIFEST_BYTES
    {
        return Err(BridgeRuntimeError::Invalid(
            "pinned executable manifest is missing, unsafe, or corrupt".to_owned(),
        ));
    }
    let mut manifest_bytes = Vec::with_capacity(manifest_metadata.len() as usize);
    (&mut manifest_file)
        .take(MAX_REMOTE_RUNTIME_MANIFEST_BYTES.saturating_add(1))
        .read_to_end(&mut manifest_bytes)?;
    if manifest_bytes.len() as u64 > MAX_REMOTE_RUNTIME_MANIFEST_BYTES {
        return Err(BridgeRuntimeError::Invalid(
            "pinned executable manifest is oversized".to_owned(),
        ));
    }
    let manifest: RemoteRuntimeArtifactManifest = serde_json::from_slice(&manifest_bytes)?;
    if manifest.schema_version != 1
        || !valid_remote_runtime_manifest_tuple(&manifest)
        || manifest.runtime_version.is_empty()
        || manifest.runtime_version.len() > 256
        || manifest.runtime_version.chars().any(char::is_control)
        || manifest.remote_protocol_min == 0
        || manifest.remote_protocol_min > REMOTE_PROTOCOL_VERSION
        || manifest.remote_protocol_max < REMOTE_PROTOCOL_VERSION
        || manifest.remote_protocol_min > manifest.remote_protocol_max
        || manifest.keeper_local_protocol_major != keeper_local_protocol_major
        || manifest.terminal_wire_version != terminal_wire_version
        || manifest.executable != "kmuxd"
        || manifest.sha256 != executable_generation
        || actual_generation != executable_generation
        || manifest.bytes != metadata.len()
    {
        return Err(BridgeRuntimeError::Invalid(
            "pinned executable manifest does not match its descriptor".to_owned(),
        ));
    }
    Ok(())
}

fn valid_remote_runtime_manifest_tuple(manifest: &RemoteRuntimeArtifactManifest) -> bool {
    matches!(
        (
            manifest.target.as_str(),
            manifest.platform.as_str(),
            manifest.arch.as_str(),
            manifest.abi.as_str(),
            manifest.signed,
        ),
        ("darwin-arm64", "darwin", "arm64", "native", true)
            | ("darwin-x64", "darwin", "x64", "native", true)
            | ("linux-arm64-musl", "linux", "arm64", "musl", false)
            | ("linux-x64-musl", "linux", "x64", "musl", false)
    )
}

fn hash_reader(reader: &mut impl Read) -> Result<String, io::Error> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let bytes = reader.read(&mut buffer)?;
        if bytes == 0 {
            return Ok(format!("{:x}", hasher.finalize()));
        }
        hasher.update(&buffer[..bytes]);
    }
}

fn remove_stale_cohort_socket(path: &Path) -> Result<(), BridgeRuntimeError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_socket()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
    {
        return Err(BridgeRuntimeError::Invalid(
            "stale cohort endpoint is unsafe".to_owned(),
        ));
    }
    fs::remove_file(path)?;
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn validate_operation(
    intent: &RemoteOperationIntent,
    payload: &RemoteOperationPayload,
) -> Result<(), BridgeRuntimeError> {
    validate_id(&intent.operation_id, "operationId")?;
    if intent.kind != payload.kind() {
        return Err(BridgeRuntimeError::Invalid(
            "operation kind does not match its payload".to_owned(),
        ));
    }
    validate_resource_key(&intent.resource_key)?;
    let expected = parse_u64(&intent.expected_remote_resource_revision)?;
    let next = parse_u64(&intent.next_remote_resource_revision)?;
    if expected.checked_add(1) != Some(next) {
        return Err(BridgeRuntimeError::Invalid(
            "operation revision must advance by exactly one".to_owned(),
        ));
    }
    if !is_sha256(&intent.canonical_payload_hash)
        || canonical_payload_hash(payload)? != intent.canonical_payload_hash
    {
        return Err(BridgeRuntimeError::Invalid(
            "canonical payload hash mismatch".to_owned(),
        ));
    }
    let session_scoped = matches!(
        payload,
        RemoteOperationPayload::SessionCreate { .. }
            | RemoteOperationPayload::SessionRestart { .. }
            | RemoteOperationPayload::SessionAdopt { .. }
            | RemoteOperationPayload::SessionTerminate { .. }
            | RemoteOperationPayload::LaunchInput { .. }
    );
    if session_scoped != intent.resource_key.session_id.is_some() {
        return Err(BridgeRuntimeError::Invalid(
            "operation resource scope is invalid".to_owned(),
        ));
    }
    let payload_session_id = match payload {
        RemoteOperationPayload::SessionCreate { session_id, .. }
        | RemoteOperationPayload::SessionRestart { session_id, .. }
        | RemoteOperationPayload::SessionAdopt { session_id, .. }
        | RemoteOperationPayload::SessionTerminate { session_id }
        | RemoteOperationPayload::LaunchInput { session_id, .. } => Some(session_id),
        _ => None,
    };
    if payload_session_id != intent.resource_key.session_id.as_ref() {
        return Err(BridgeRuntimeError::Invalid(
            "payload session identity does not match its resource".to_owned(),
        ));
    }
    match payload {
        RemoteOperationPayload::WorktreeCreate {
            workspace_id,
            cwd,
            path,
            base_ref,
            branch,
        } => {
            if workspace_id != &intent.resource_key.workspace_id {
                return Err(BridgeRuntimeError::Invalid(
                    "worktree workspace identity does not match its resource".to_owned(),
                ));
            }
            normalize_absolute_path(cwd)?;
            normalize_absolute_path(path)?;
            validate_git_text(base_ref, "worktree base ref")?;
            validate_git_text(branch, "worktree branch")?;
        }
        RemoteOperationPayload::WorktreeRemove {
            workspace_id,
            cwd,
            path,
            expected_branch,
            expected_common_git_dir,
            ..
        } => {
            if workspace_id != &intent.resource_key.workspace_id {
                return Err(BridgeRuntimeError::Invalid(
                    "worktree workspace identity does not match its resource".to_owned(),
                ));
            }
            normalize_absolute_path(cwd)?;
            normalize_absolute_path(path)?;
            validate_git_text(expected_branch, "expected worktree branch")?;
            normalize_absolute_path(expected_common_git_dir)?;
        }
        RemoteOperationPayload::ForwardEnsure {
            forward_id,
            remote_host,
            remote_port,
            local_bind_host,
            local_port,
        } => {
            validate_id(forward_id, "forwardId")?;
            if remote_host.is_empty()
                || remote_host.len() > 4 * 1024
                || remote_host.chars().any(char::is_control)
                || *remote_port == 0
                || local_port == &Some(0)
                || !matches!(local_bind_host.as_str(), "127.0.0.1" | "::1")
            {
                return Err(BridgeRuntimeError::Invalid(
                    "forward endpoint is invalid".to_owned(),
                ));
            }
        }
        RemoteOperationPayload::ForwardRemove { forward_id } => {
            validate_id(forward_id, "forwardId")?;
        }
        _ => {}
    }
    Ok(())
}

fn validate_git_text(value: &str, field: &str) -> Result<(), BridgeRuntimeError> {
    if value.is_empty()
        || value.len() > MAX_GIT_ARGUMENT_BYTES
        || value.as_bytes().contains(&0)
        || value.chars().any(char::is_control)
    {
        return Err(BridgeRuntimeError::Invalid(format!("{field} is invalid")));
    }
    Ok(())
}

fn canonical_payload_hash(payload: &RemoteOperationPayload) -> Result<String, BridgeRuntimeError> {
    let value = serde_json::to_value(payload)?;
    let canonical = canonical_json(&value)?;
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}

fn canonical_json(value: &Value) -> Result<String, BridgeRuntimeError> {
    match value {
        Value::Null => Ok("null".to_owned()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) if value.is_i64() || value.is_u64() => Ok(value.to_string()),
        Value::String(value) => Ok(serde_json::to_string(value)?),
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let fields = keys
                .into_iter()
                .map(|key| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key)?,
                        canonical_json(&values[key])?
                    ))
                })
                .collect::<Result<Vec<String>, BridgeRuntimeError>>()?;
            Ok(format!("{{{}}}", fields.join(",")))
        }
        Value::Number(_) => Err(BridgeRuntimeError::Invalid(
            "canonical JSON rejects non-integer numbers".to_owned(),
        )),
    }
}

fn resolve_existing_operation(
    descriptor: &SessionDescriptor,
    intent: &RemoteOperationIntent,
) -> Result<OperationResult, BridgeRuntimeError> {
    let keeper_generation =
        (intent.kind != "session.terminate").then(|| descriptor.keeper_generation.clone());
    if descriptor.last_operation_id == intent.operation_id {
        if descriptor.last_operation_payload_hash != intent.canonical_payload_hash {
            return Ok(operation_failure(
                &intent.operation_id,
                "idempotency-conflict",
                "operation ID was reused with another payload",
            ));
        }
        return Ok(operation_success(
            intent,
            descriptor.last_result_digest.clone(),
            keeper_generation,
        ));
    }
    if descriptor.create_operation_id == intent.operation_id {
        if descriptor.canonical_create_payload_hash != intent.canonical_payload_hash {
            return Ok(operation_failure(
                &intent.operation_id,
                "idempotency-conflict",
                "create operation ID was reused with another payload",
            ));
        }
        return Ok(operation_success(
            intent,
            descriptor.create_result_digest.clone(),
            Some(descriptor.keeper_generation.clone()),
        ));
    }
    Ok(operation_failure(
        &intent.operation_id,
        "resource-exists",
        "session resource already exists",
    ))
}

fn revision_failure(
    descriptor: &SessionDescriptor,
    intent: &RemoteOperationIntent,
) -> Option<OperationResult> {
    if descriptor.remote_resource_revision != intent.expected_remote_resource_revision {
        return Some(operation_failure(
            &intent.operation_id,
            "operation-stale",
            "session resource revision is stale",
        ));
    }
    None
}

fn operation_success(
    intent: &RemoteOperationIntent,
    result_digest: String,
    keeper_generation: Option<String>,
) -> OperationResult {
    OperationResult {
        outcome: "succeeded".to_owned(),
        operation_id: intent.operation_id.clone(),
        remote_resource_revision: Some(intent.next_remote_resource_revision.clone()),
        result_digest,
        keeper_generation,
        code: None,
        message: None,
    }
}

fn operation_failure(operation_id: &str, code: &str, message: &str) -> OperationResult {
    let message = bounded_operation_message(message, "operation failed", false);
    let result_digest = format!(
        "{:x}",
        Sha256::digest(format!("{operation_id}\0{code}\0{message}").as_bytes())
    );
    OperationResult {
        outcome: "failed".to_owned(),
        operation_id: operation_id.to_owned(),
        remote_resource_revision: None,
        result_digest,
        keeper_generation: None,
        code: Some(code.to_owned()),
        message: Some(message),
    }
}

fn operation_result_digest(
    intent: &RemoteOperationIntent,
    keeper_generation: Option<&str>,
    outcome: &str,
) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}\0{}\0{}\0{}\0{}",
                intent.operation_id,
                intent.kind,
                intent.next_remote_resource_revision,
                keeper_generation.unwrap_or(""),
                outcome
            )
            .as_bytes()
        )
    )
}

pub fn rotate_bridge_token(
    reader: impl Read,
    mut writer: impl Write,
) -> Result<(), BridgeRuntimeError> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_BRIDGE_TOKEN_ROTATION_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BRIDGE_TOKEN_ROTATION_BYTES {
        return Err(BridgeRuntimeError::Invalid(
            "connection token rotation request is oversized".to_owned(),
        ));
    }
    let request: BridgeTokenRotationRequest = serde_json::from_slice(&bytes)?;
    if request.version != 1 {
        return Err(BridgeRuntimeError::Invalid(
            "connection token rotation version is unsupported".to_owned(),
        ));
    }
    validate_roots(&request.roots)?;
    validate_id(&request.desktop_installation_id, "desktopInstallationId")?;
    validate_id(&request.target_id, "targetId")?;
    validate_bridge_token_value(&request.token)?;
    prepare_runtime_directories(&request.roots)?;

    let directory = scoped_bridge_token_directory(&request.roots);
    ensure_private_directory(&directory)?;
    let scope_digest =
        bridge_token_scope_digest(&request.desktop_installation_id, &request.target_id);
    let path = directory.join(format!("{scope_digest}.json"));
    let _lock = acquire_resource_lock(&directory.join("store"))?;
    let existing = match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.file_type().is_file()
                || metadata.file_type().is_symlink()
                || metadata.uid() != effective_uid()
                || metadata.mode() & 0o077 != 0
                || metadata.len() > MAX_BRIDGE_TOKEN_RECORD_BYTES
            {
                return Err(BridgeRuntimeError::Invalid(
                    "scoped connection token record is unsafe".to_owned(),
                ));
            }
            true
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if !existing && scoped_bridge_token_record_count(&directory)? >= MAX_SCOPED_BRIDGE_TOKENS {
        return Err(BridgeRuntimeError::Invalid(
            "scoped connection token store is full".to_owned(),
        ));
    }
    let record = ScopedBridgeTokenRecord {
        version: 2,
        roots: request.roots.clone(),
        desktop_installation_id: request.desktop_installation_id,
        target_id: request.target_id,
        token_sha256: format!("{:x}", Sha256::digest(request.token.as_bytes())),
    };
    write_json_atomic(&path, &record)?;
    remove_legacy_bridge_token_record(&request.roots)?;
    serde_json::to_writer(
        &mut writer,
        &BridgeTokenRotationResponse {
            version: 1,
            status: "rotated",
        },
    )?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn verify_bridge_token(
    roots: &RemoteRuntimeRoots,
    token: &str,
) -> Result<VerifiedBridgeToken, BridgeRuntimeError> {
    validate_bridge_token_value(token)?;
    prepare_runtime_directories(roots)?;
    let token_sha256 = format!("{:x}", Sha256::digest(token.as_bytes()));
    let directory = scoped_bridge_token_directory(roots);
    let mut scoped_count = 0usize;
    let mut matched: Option<VerifiedBridgeToken> = None;
    match fs::read_dir(&directory) {
        Ok(entries) => {
            let metadata = fs::symlink_metadata(&directory)?;
            if !metadata.file_type().is_dir()
                || metadata.file_type().is_symlink()
                || metadata.uid() != effective_uid()
                || metadata.mode() & 0o077 != 0
            {
                return Err(BridgeRuntimeError::Invalid(
                    "scoped connection token directory is unsafe".to_owned(),
                ));
            }
            for entry in entries {
                let entry = entry?;
                if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                    continue;
                }
                scoped_count = scoped_count.checked_add(1).ok_or_else(|| {
                    BridgeRuntimeError::Invalid(
                        "scoped connection token store is invalid".to_owned(),
                    )
                })?;
                if scoped_count > MAX_SCOPED_BRIDGE_TOKENS {
                    return Err(BridgeRuntimeError::Invalid(
                        "scoped connection token store is full".to_owned(),
                    ));
                }
                let record: ScopedBridgeTokenRecord =
                    read_private_json(&entry.path(), MAX_BRIDGE_TOKEN_RECORD_BYTES)?;
                validate_scoped_bridge_token_record(&record)?;
                if record.token_sha256 != token_sha256 {
                    continue;
                }
                if record.roots != *roots || matched.is_some() {
                    return Err(BridgeRuntimeError::Invalid(
                        "connection token proof scope is ambiguous".to_owned(),
                    ));
                }
                matched = Some(VerifiedBridgeToken {
                    scope: Some(BridgeTokenScope {
                        desktop_installation_id: record.desktop_installation_id,
                        target_id: record.target_id,
                    }),
                });
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if let Some(matched) = matched {
        return Ok(matched);
    }
    if scoped_count > 0 {
        return Err(BridgeRuntimeError::Invalid(
            "connection token proof failed".to_owned(),
        ));
    }

    // A fresh root may still be used by standalone/native compatibility
    // clients that do not have the authenticated SSH promotion step. Preserve
    // one-time enrollment only while no scoped product token exists. Product
    // connections always pre-rotate a scoped record and remove this legacy
    // record before opening the bridge.
    let path = Path::new(&roots.state_root).join("bridge-token.json");
    let initial = LegacyBridgeTokenRecord {
        version: 1,
        token_sha256: token_sha256.clone(),
    };
    match write_json_create_new(&path, &initial) {
        Ok(()) => {}
        Err(BridgeRuntimeError::Io(error)) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let record: LegacyBridgeTokenRecord = read_private_json(&path, MAX_BRIDGE_TOKEN_RECORD_BYTES)?;
    if record.version != 1 || record.token_sha256 != token_sha256 {
        return Err(BridgeRuntimeError::Invalid(
            "connection token proof failed".to_owned(),
        ));
    }
    Ok(VerifiedBridgeToken { scope: None })
}

fn verify_bound_bridge_token(
    roots: &RemoteRuntimeRoots,
    token: &str,
    binding: &BridgeConnectionBinding,
) -> Result<VerifiedBridgeToken, BridgeRuntimeError> {
    validate_bridge_token_value(token)?;
    let token_sha256 = format!("{:x}", Sha256::digest(token.as_bytes()));
    let Some(scope) = &binding.token_scope else {
        validate_existing_private_directory(Path::new(&roots.state_root))?;
        let path = Path::new(&roots.state_root).join("bridge-token.json");
        let record: LegacyBridgeTokenRecord =
            read_private_json(&path, MAX_BRIDGE_TOKEN_RECORD_BYTES)
                .map_err(connection_token_read_error)?;
        if record.version != 1 || record.token_sha256 != token_sha256 {
            return Err(BridgeRuntimeError::Invalid(
                "connection token proof failed".to_owned(),
            ));
        }
        return Ok(VerifiedBridgeToken { scope: None });
    };

    let directory = scoped_bridge_token_directory(roots);
    validate_existing_private_directory(&directory)?;
    let path = directory.join(format!(
        "{}.json",
        bridge_token_scope_digest(&scope.desktop_installation_id, &scope.target_id)
    ));
    let record: ScopedBridgeTokenRecord = read_private_json(&path, MAX_BRIDGE_TOKEN_RECORD_BYTES)
        .map_err(connection_token_read_error)?;
    validate_scoped_bridge_token_record(&record)?;
    if record.roots != *roots
        || record.desktop_installation_id != scope.desktop_installation_id
        || record.target_id != scope.target_id
        || record.token_sha256 != token_sha256
    {
        return Err(BridgeRuntimeError::Invalid(
            "connection token proof failed".to_owned(),
        ));
    }
    Ok(VerifiedBridgeToken {
        scope: Some(scope.clone()),
    })
}

fn validate_scoped_bridge_token_record(
    record: &ScopedBridgeTokenRecord,
) -> Result<(), BridgeRuntimeError> {
    if record.version != 2 || !is_sha256(&record.token_sha256) {
        return Err(BridgeRuntimeError::Invalid(
            "scoped connection token record is invalid".to_owned(),
        ));
    }
    validate_roots(&record.roots)?;
    validate_id(&record.desktop_installation_id, "desktopInstallationId")?;
    validate_id(&record.target_id, "targetId")?;
    Ok(())
}

fn validate_existing_private_directory(path: &Path) -> Result<(), BridgeRuntimeError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| connection_token_read_error(error.into()))?;
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(BridgeRuntimeError::Invalid(
            "connection token directory is unsafe".to_owned(),
        ));
    }
    Ok(())
}

fn connection_token_read_error(error: BridgeRuntimeError) -> BridgeRuntimeError {
    match error {
        BridgeRuntimeError::Io(error) if error.kind() == io::ErrorKind::NotFound => {
            BridgeRuntimeError::Invalid("connection token proof failed".to_owned())
        }
        error => error,
    }
}

fn validate_bridge_token_value(token: &str) -> Result<(), BridgeRuntimeError> {
    if !(64..=128).contains(&token.len())
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(BridgeRuntimeError::Invalid(
            "connection token is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn scoped_bridge_token_directory(roots: &RemoteRuntimeRoots) -> PathBuf {
    Path::new(&roots.state_root).join("bridge-tokens")
}

fn bridge_token_scope_digest(desktop_installation_id: &str, target_id: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{desktop_installation_id}\0{target_id}").as_bytes())
    )
}

fn scoped_bridge_token_record_count(directory: &Path) -> Result<usize, BridgeRuntimeError> {
    let mut count = 0usize;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        count = count.checked_add(1).ok_or_else(|| {
            BridgeRuntimeError::Invalid("scoped connection token store is invalid".to_owned())
        })?;
        if count > MAX_SCOPED_BRIDGE_TOKENS {
            return Err(BridgeRuntimeError::Invalid(
                "scoped connection token store is full".to_owned(),
            ));
        }
    }
    Ok(count)
}

fn remove_legacy_bridge_token_record(roots: &RemoteRuntimeRoots) -> Result<(), BridgeRuntimeError> {
    let path = Path::new(&roots.state_root).join("bridge-token.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > MAX_BRIDGE_TOKEN_RECORD_BYTES
    {
        return Err(BridgeRuntimeError::Invalid(
            "legacy connection token record is unsafe".to_owned(),
        ));
    }
    fs::remove_file(&path)?;
    File::open(Path::new(&roots.state_root))?.sync_all()?;
    Ok(())
}

fn validate_roots(roots: &RemoteRuntimeRoots) -> Result<(), BridgeRuntimeError> {
    for value in [
        &roots.install_root,
        &roots.authority_root,
        &roots.state_root,
        &roots.runtime_root,
    ] {
        if !Path::new(value).is_absolute() || value.len() > 32 * 1024 || value.contains('\0') {
            return Err(BridgeRuntimeError::Invalid(
                "runtime roots must be bounded absolute paths".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_resource_key(key: &RemoteResourceKey) -> Result<(), BridgeRuntimeError> {
    validate_id(&key.desktop_installation_id, "desktopInstallationId")?;
    validate_id(&key.target_id, "targetId")?;
    validate_id(&key.workspace_id, "workspaceId")?;
    if let Some(session_id) = &key.session_id {
        validate_id(session_id, "sessionId")?;
    }
    Ok(())
}

fn validate_id(value: &str, field: &str) -> Result<(), BridgeRuntimeError> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(BridgeRuntimeError::Invalid(format!("{field} is invalid")));
    }
    Ok(())
}

fn parse_u64(value: &str) -> Result<u64, BridgeRuntimeError> {
    if value == "0" || (!value.starts_with('0') && value.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return value
            .parse()
            .map_err(|_| BridgeRuntimeError::Invalid("uint64 is invalid".to_owned()));
    }
    Err(BridgeRuntimeError::Invalid(
        "uint64 is not canonical".to_owned(),
    ))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hash_file(path: &Path) -> Result<String, BridgeRuntimeError> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > MAX_RUNTIME_EXECUTABLE_BYTES {
        return Err(BridgeRuntimeError::Invalid(
            "runtime executable is invalid or oversized".to_owned(),
        ));
    }
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    io::copy(&mut file, &mut DigestWriter(&mut digest))?;
    Ok(format!("{:x}", digest.finalize()))
}

struct DigestWriter<'a>(&'a mut Sha256);

impl Write for DigestWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.update(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn to_control_error(error: &BridgeRuntimeError) -> RemoteControlError {
    match error {
        BridgeRuntimeError::Retryable(message) => RemoteControlError {
            code: "temporarily-unavailable".to_owned(),
            message: message.clone(),
            retryable: true,
        },
        BridgeRuntimeError::Invalid(message) => RemoteControlError {
            code: if message == "protocol-incompatible" {
                "protocol-incompatible"
            } else {
                "invalid-request"
            }
            .to_owned(),
            message: message.clone(),
            retryable: false,
        },
        _ => RemoteControlError {
            code: "runtime-failed".to_owned(),
            message: error.to_string(),
            retryable: false,
        },
    }
}

fn load_descriptor_optional(path: &Path) -> Result<Option<SessionDescriptor>, BridgeRuntimeError> {
    match load_session_descriptor(path) {
        Ok(value) => Ok(Some(value)),
        Err(kmux_keeper::KeeperRuntimeError::Io(error))
            if error.kind() == io::ErrorKind::NotFound =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

fn read_workspace_descriptor_optional(
    path: &Path,
) -> Result<Option<WorkspaceDescriptor>, BridgeRuntimeError> {
    match read_private_json(path, 256 * 1024) {
        Ok(value) => Ok(Some(value)),
        Err(BridgeRuntimeError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

struct ResourceLock {
    _lock: Flock<File>,
}

fn acquire_resource_lock(path: &Path) -> Result<ResourceLock, BridgeRuntimeError> {
    let parent = path
        .parent()
        .ok_or_else(|| BridgeRuntimeError::Invalid("resource path has no parent".to_owned()))?;
    ensure_private_directory(parent)?;
    let lock_path = path.with_extension("lock");
    let deadline = Instant::now() + RESOURCE_LOCK_TIMEOUT;
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
        return Err(BridgeRuntimeError::Invalid(
            "resource operation lock is unsafe".to_owned(),
        ));
    }
    File::open(parent)?.sync_all()?;
    let mut file = file;
    loop {
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => return Ok(ResourceLock { _lock: lock }),
            Err((returned, Errno::EAGAIN)) => {
                file = returned;
                if Instant::now() >= deadline {
                    return Err(BridgeRuntimeError::Retryable(
                        "resource operation lock is busy".to_owned(),
                    ));
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err((_returned, error)) => {
                return Err(BridgeRuntimeError::Io(io::Error::from_raw_os_error(
                    error as i32,
                )));
            }
        }
    }
}

fn acquire_session_operation_lock(
    descriptor_path: &Path,
) -> Result<ResourceLock, BridgeRuntimeError> {
    let state_root = descriptor_path
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| {
            BridgeRuntimeError::Invalid(
                "session descriptor path is outside its state root".to_owned(),
            )
        })?;
    let file_name = descriptor_path.file_name().ok_or_else(|| {
        BridgeRuntimeError::Invalid("session descriptor path has no file name".to_owned())
    })?;
    acquire_resource_lock(&state_root.join("session-operation-locks").join(file_name))
}

fn ensure_private_directory(path: &Path) -> Result<(), BridgeRuntimeError> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(BridgeRuntimeError::Invalid(
            "runtime directory is unsafe".to_owned(),
        ));
    }
    Ok(())
}

fn ensure_remote_cli_shims(
    install_root: &Path,
    executable: &Path,
    executable_generation: &str,
) -> Result<PathBuf, BridgeRuntimeError> {
    if !install_root.is_absolute() || !is_sha256(executable_generation) {
        return Err(BridgeRuntimeError::Invalid(
            "remote CLI shim scope is invalid".to_owned(),
        ));
    }
    // `bin/` contains immutable content-addressed executable generations.
    // Mutable CLI wrappers belong to a separate namespace so shim refreshes
    // cannot make generation validation or GC race with live sessions.
    let directory = install_root
        .join("shims")
        .join(&executable_generation[..16]);
    ensure_private_directory(&directory)?;
    let _lock = acquire_resource_lock(&directory.join("shim-set"))?;
    let quoted_executable = quote_posix_word(&executable.to_string_lossy());
    let cli = format!("#!/bin/sh\nexec {quoted_executable} cli \"$@\"\n");
    let hook = format!(
        "#!/bin/sh\nagent=${{1:-unknown}}\nevent=${{2:-event}}\nif [ \"${{KMUX_AGENT_HOOK_OUTPUT_MODE:-silent}}\" = json ]; then\n  exec {quoted_executable} hook emit --kind agent-hook --name \"$agent.$event\"\nfi\nexec {quoted_executable} hook emit --kind agent-hook --name \"$agent.$event\" >/dev/null 2>&1\n"
    );
    write_executable_atomic(&directory.join("kmux"), cli.as_bytes())?;
    write_executable_atomic(&directory.join("kmux-agent-hook"), hook.as_bytes())?;
    Ok(directory)
}

fn quote_posix_word(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn write_executable_atomic(path: &Path, bytes: &[u8]) -> Result<(), BridgeRuntimeError> {
    let parent = path
        .parent()
        .ok_or_else(|| BridgeRuntimeError::Invalid("shim path has no parent".to_owned()))?;
    ensure_private_directory(parent)?;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.uid() != effective_uid()
            || metadata.mode() & 0o077 != 0
            || metadata.len() > 64 * 1024
        {
            return Err(BridgeRuntimeError::Invalid(
                "remote CLI shim is unsafe".to_owned(),
            ));
        }
        if fs::read(path)? == bytes {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
            return Ok(());
        }
    }
    let temporary = parent.join(format!(".shim-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .custom_flags(OFlag::O_NOFOLLOW.bits())
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        // Do not publish an executable while it still has a writable file
        // descriptor. Linux rejects an exec racing with that descriptor as
        // ETXTBSY ("Text file busy").
        drop(file);
        fs::rename(&temporary, path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_json_create_new(path: &Path, value: &impl Serialize) -> Result<(), BridgeRuntimeError> {
    let parent = path
        .parent()
        .ok_or_else(|| BridgeRuntimeError::Invalid("JSON path has no parent".to_owned()))?;
    ensure_private_directory(parent)?;
    let bytes = serde_json::to_vec(value)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), BridgeRuntimeError> {
    let parent = path
        .parent()
        .ok_or_else(|| BridgeRuntimeError::Invalid("JSON path has no parent".to_owned()))?;
    ensure_private_directory(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("record"),
        Uuid::new_v4()
    ));
    write_json_create_new(&temporary, value)?;
    fs::rename(&temporary, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn read_private_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
    maximum: u64,
) -> Result<T, BridgeRuntimeError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > maximum
    {
        return Err(BridgeRuntimeError::Invalid(
            "private JSON record is unsafe".to_owned(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        return Err(BridgeRuntimeError::Invalid(
            "private JSON record is oversized".to_owned(),
        ));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resource_key() -> RemoteResourceKey {
        RemoteResourceKey {
            desktop_installation_id: "desktop_1".to_owned(),
            target_id: "target_1".to_owned(),
            workspace_id: "workspace_1".to_owned(),
            session_id: Some("session_1".to_owned()),
        }
    }

    fn operation_intent(kind: &str, payload_hash: &str) -> RemoteOperationIntent {
        RemoteOperationIntent {
            operation_id: "operation_1".to_owned(),
            kind: kind.to_owned(),
            resource_key: resource_key(),
            expected_workspace_revision: "a".repeat(64),
            expected_remote_resource_revision: "0".to_owned(),
            next_remote_resource_revision: "1".to_owned(),
            conversion_transaction_id: None,
            create_operation_id: Some("operation_1".to_owned()),
            canonical_payload_hash: payload_hash.to_owned(),
            created_at: "2026-07-17T00:00:00.000Z".to_owned(),
        }
    }

    fn workspace_test_intent(
        resource_key: &RemoteResourceKey,
        operation_id: &str,
        expected_remote_resource_revision: &str,
        next_remote_resource_revision: &str,
        payload: &RemoteOperationPayload,
    ) -> RemoteOperationIntent {
        RemoteOperationIntent {
            operation_id: operation_id.to_owned(),
            kind: payload.kind().to_owned(),
            resource_key: resource_key.clone(),
            expected_workspace_revision: "c".repeat(64),
            expected_remote_resource_revision: expected_remote_resource_revision.to_owned(),
            next_remote_resource_revision: next_remote_resource_revision.to_owned(),
            conversion_transaction_id: None,
            create_operation_id: None,
            canonical_payload_hash: canonical_payload_hash(payload).unwrap(),
            created_at: "2026-07-18T00:00:00.000Z".to_owned(),
        }
    }

    #[test]
    fn scoped_bridge_token_rotation_fences_only_the_rotated_target() {
        let sandbox = tempfile::tempdir().unwrap();
        let roots = test_roots(sandbox.path());
        let first = "a".repeat(64);
        let replacement = "b".repeat(64);
        let other = "c".repeat(64);

        rotate_test_bridge_token(&roots, "desktop_1", "target_1", &first);
        let verified = verify_bridge_token(&roots, &first).unwrap();
        assert_eq!(
            verified
                .scope
                .as_ref()
                .map(|scope| scope.desktop_installation_id.as_str()),
            Some("desktop_1")
        );
        assert_eq!(
            verified
                .scope
                .as_ref()
                .map(|scope| scope.target_id.as_str()),
            Some("target_1")
        );

        rotate_test_bridge_token(&roots, "desktop_1", "target_1", &replacement);
        assert!(verify_bridge_token(&roots, &first).is_err());
        assert!(verify_bridge_token(&roots, &replacement).is_ok());

        rotate_test_bridge_token(&roots, "desktop_2", "target_2", &other);
        assert!(verify_bridge_token(&roots, &replacement).is_ok());
        assert!(verify_bridge_token(&roots, &other).is_ok());
        assert!(
            !Path::new(&roots.state_root)
                .join("bridge-token.json")
                .exists()
        );

        let record_files = fs::read_dir(scoped_bridge_token_directory(&roots))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .collect::<Vec<_>>();
        assert_eq!(record_files.len(), 2);
        for entry in record_files {
            let metadata = fs::symlink_metadata(entry.path()).unwrap();
            assert!(metadata.is_file());
            assert_eq!(metadata.mode() & 0o077, 0);
        }

        let binding = BridgeConnectionBinding {
            roots: roots.clone(),
            retention_policy: RemoteRetentionPolicy::default(),
            token_sha256: format!("{:x}", Sha256::digest(replacement.as_bytes())),
            token_scope: Some(BridgeTokenScope {
                desktop_installation_id: "desktop_1".to_owned(),
                target_id: "target_1".to_owned(),
            }),
            desktop_installation_id: Some("desktop_1".to_owned()),
            target_id: Some("target_1".to_owned()),
        };
        assert!(verify_bound_bridge_token(&roots, &replacement, &binding).is_ok());
        rotate_test_bridge_token(&roots, "desktop_1", "target_1", &"d".repeat(64));
        assert!(verify_bound_bridge_token(&roots, &replacement, &binding).is_err());

        let binding = Some(binding);
        let wrong_scope = BridgeRequestEnvelope {
            protocol_version: REMOTE_PROTOCOL_VERSION,
            request_id: "request_1".to_owned(),
            token: replacement,
            roots,
            retention_policy: RemoteRetentionPolicy::default(),
            request: BridgeRequest::Observe {
                desktop_installation_id: "desktop_1".to_owned(),
                target_id: "target_2".to_owned(),
            },
        };
        assert!(validate_bridge_connection_binding(&binding, &wrong_scope).is_err());
    }

    #[test]
    fn established_bridge_token_verification_is_isolated_to_its_scope() {
        let sandbox = tempfile::tempdir().unwrap();
        let roots = test_roots(sandbox.path());
        let token = "a".repeat(64);
        rotate_test_bridge_token(&roots, "desktop_1", "target_1", &token);
        rotate_test_bridge_token(&roots, "desktop_2", "target_2", &"b".repeat(64));

        let unrelated_path = scoped_bridge_token_directory(&roots).join(format!(
            "{}.json",
            bridge_token_scope_digest("desktop_2", "target_2")
        ));
        fs::write(&unrelated_path, b"{}").unwrap();
        fs::set_permissions(&unrelated_path, fs::Permissions::from_mode(0o600)).unwrap();

        let binding = BridgeConnectionBinding {
            roots: roots.clone(),
            retention_policy: RemoteRetentionPolicy::default(),
            token_sha256: format!("{:x}", Sha256::digest(token.as_bytes())),
            token_scope: Some(BridgeTokenScope {
                desktop_installation_id: "desktop_1".to_owned(),
                target_id: "target_1".to_owned(),
            }),
            desktop_installation_id: Some("desktop_1".to_owned()),
            target_id: Some("target_1".to_owned()),
        };

        assert!(verify_bound_bridge_token(&roots, &token, &binding).is_ok());
        assert!(verify_bridge_token(&roots, &token).is_err());
    }

    fn rotate_test_bridge_token(
        roots: &RemoteRuntimeRoots,
        desktop_installation_id: &str,
        target_id: &str,
        token: &str,
    ) {
        let request = serde_json::json!({
            "version": 1,
            "roots": roots,
            "desktopInstallationId": desktop_installation_id,
            "targetId": target_id,
            "token": token,
        });
        let mut output = Vec::new();
        rotate_bridge_token(
            io::Cursor::new(serde_json::to_vec(&request).unwrap()),
            &mut output,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&output).unwrap(),
            serde_json::json!({"version": 1, "status": "rotated"})
        );
    }

    #[test]
    fn pinned_cohort_executable_requires_matching_private_manifest() {
        let temporary = tempfile::tempdir().unwrap();
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let executable_path = temporary.path().join("kmuxd");
        let executable_bytes = b"kmux fixture executable";
        fs::write(&executable_path, executable_bytes).unwrap();
        fs::set_permissions(&executable_path, fs::Permissions::from_mode(0o700)).unwrap();
        let generation = format!("{:x}", Sha256::digest(executable_bytes));
        let (target, platform, arch, abi, signed) = if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                ("darwin-arm64", "darwin", "arm64", "native", true)
            } else {
                ("darwin-x64", "darwin", "x64", "native", true)
            }
        } else if cfg!(target_arch = "aarch64") {
            ("linux-arm64-musl", "linux", "arm64", "musl", false)
        } else {
            ("linux-x64-musl", "linux", "x64", "musl", false)
        };
        let manifest_path = temporary.path().join("manifest.json");
        let manifest = serde_json::json!({
            "schemaVersion": 1,
            "target": target,
            "platform": platform,
            "arch": arch,
            "abi": abi,
            "runtimeVersion": "0.1.0",
            "remoteProtocolMin": 1,
            "remoteProtocolMax": 1,
            "keeperLocalProtocolMajor": 2,
            "terminalWireVersion": 1,
            "executable": "kmuxd",
            "sha256": generation,
            "bytes": executable_bytes.len(),
            "signed": signed
        });
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        fs::set_permissions(&manifest_path, fs::Permissions::from_mode(0o600)).unwrap();

        verify_pinned_executable_contract(&executable_path, &generation, 2, 1).unwrap();

        let mut corrupt = manifest;
        corrupt["bytes"] = serde_json::json!(executable_bytes.len() + 1);
        fs::write(&manifest_path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
        assert!(verify_pinned_executable_contract(&executable_path, &generation, 2, 1).is_err());
    }

    #[test]
    fn crashed_keeper_descriptor_does_not_pin_its_cohort_process() {
        let sandbox = tempfile::tempdir().unwrap();
        let roots = test_roots(sandbox.path());
        prepare_runtime_directories(&roots).unwrap();
        let resource_key = test_resource_key("workspace_crashed_cohort", Some("session_crashed"));
        let mut descriptor = test_session_descriptor(
            sandbox.path(),
            resource_key.clone(),
            "crashed_cohort",
            "create_crashed_cohort",
            &"a".repeat(64),
            false,
        );
        descriptor.state = SessionDescriptorState::Running;
        descriptor.keeper_pid = Some(i32::MAX as u32);
        descriptor.exit_code = None;
        write_session_descriptor(
            &session_descriptor_path(Path::new(&roots.state_root), &resource_key),
            &descriptor,
        )
        .unwrap();

        let options = CohortProxyServeOptions {
            socket_path: Path::new(&roots.runtime_root)
                .join("cohorts")
                .join("test.sock"),
            state_root: PathBuf::from(&roots.state_root),
            runtime_root: PathBuf::from(&roots.runtime_root),
            target_id: resource_key.target_id,
            executable_generation: "d".repeat(64),
            keeper_local_protocol_major: kmux_compat::KEEPER_LOCAL_PROTOCOL_MAJOR,
        };
        assert!(!cohort_has_live_keeper(&options).unwrap());
    }

    #[test]
    fn canonical_payload_hash_matches_sorted_json_contract() {
        let payload = RemoteOperationPayload::SessionTerminate {
            session_id: "session_1".to_owned(),
        };
        let canonical = r#"{"kind":"session.terminate","sessionId":"session_1"}"#;
        assert_eq!(
            canonical_payload_hash(&payload).unwrap(),
            format!("{:x}", Sha256::digest(canonical.as_bytes()))
        );
    }

    #[test]
    fn canonical_payload_hash_omits_absent_optional_fields() {
        let payload = RemoteOperationPayload::SessionCreate {
            session_id: "session_1".to_owned(),
            surface_id: "surface_1".to_owned(),
            pane_id: "pane_1".to_owned(),
            direction: None,
            launch: kmux_compat::RemoteSessionLaunchPayload {
                cwd: "/tmp".to_owned(),
                shell: None,
                args: None,
                env: None,
                title: None,
            },
        };
        let canonical = r#"{"kind":"session.create","launch":{"cwd":"/tmp"},"paneId":"pane_1","sessionId":"session_1","surfaceId":"surface_1"}"#;
        assert_eq!(
            canonical_payload_hash(&payload).unwrap(),
            format!("{:x}", Sha256::digest(canonical.as_bytes()))
        );
    }

    #[test]
    fn canonical_adopt_payload_hash_includes_verified_launch_descriptor() {
        let payload = RemoteOperationPayload::SessionAdopt {
            session_id: "session_1".to_owned(),
            surface_id: "surface_adopted".to_owned(),
            pane_id: "pane_1".to_owned(),
            launch: kmux_compat::RemoteSessionLaunchPayload {
                cwd: "/tmp".to_owned(),
                shell: None,
                args: None,
                env: None,
                title: None,
            },
        };
        let canonical = r#"{"kind":"session.adopt","launch":{"cwd":"/tmp"},"paneId":"pane_1","sessionId":"session_1","surfaceId":"surface_adopted"}"#;
        assert_eq!(
            canonical_payload_hash(&payload).unwrap(),
            format!("{:x}", Sha256::digest(canonical.as_bytes()))
        );
    }

    #[test]
    fn create_retry_uses_permanent_create_result_after_later_mutation() {
        let payload_hash = "b".repeat(64);
        let intent = operation_intent("session.create", &payload_hash);
        let descriptor = SessionDescriptor {
            version: SESSION_DESCRIPTOR_VERSION,
            resource_key: resource_key(),
            keeper_generation: "keeper_current".to_owned(),
            executable_generation: "e".repeat(64),
            executable_path: "/tmp/kmuxd".to_owned(),
            keeper_local_protocol_major: kmux_compat::KEEPER_LOCAL_PROTOCOL_MAJOR,
            terminal_wire_version: kmux_compat::TERMINAL_WIRE_VERSION,
            create_operation_id: intent.operation_id.clone(),
            canonical_create_payload_hash: payload_hash,
            create_result_digest: "c".repeat(64),
            remote_resource_revision: "2".to_owned(),
            last_operation_id: "terminate_1".to_owned(),
            last_operation_payload_hash: "d".repeat(64),
            last_result_digest: "f".repeat(64),
            state: SessionDescriptorState::Running,
            socket_path: "/tmp/keeper.sock".to_owned(),
            journal_path: "/tmp/keeper.journal".to_owned(),
            launch: KeeperLaunchConfig {
                cwd: "/tmp".to_owned(),
                shell: None,
                args: None,
                env: None,
                title: None,
                cols: 80,
                rows: 24,
            },
            keeper_pid: Some(1),
            child_pid: Some(2),
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
        let result = resolve_existing_operation(&descriptor, &intent).unwrap();
        assert_eq!(result.outcome, "succeeded");
        assert_eq!(result.result_digest, "c".repeat(64));
        assert_eq!(result.keeper_generation.as_deref(), Some("keeper_current"));

        let mut terminate_intent = operation_intent("session.terminate", &"d".repeat(64));
        terminate_intent.operation_id = "terminate_1".to_owned();
        terminate_intent.create_operation_id = None;
        terminate_intent.expected_remote_resource_revision = "1".to_owned();
        terminate_intent.next_remote_resource_revision = "2".to_owned();
        let terminate_retry = resolve_existing_operation(&descriptor, &terminate_intent).unwrap();
        assert_eq!(terminate_retry.outcome, "succeeded");
        assert_eq!(terminate_retry.result_digest, "f".repeat(64));
        assert_eq!(terminate_retry.keeper_generation, None);
    }

    #[test]
    fn operation_result_digest_is_stable_for_retry_identity() {
        let mut intent = operation_intent("session.terminate", &"b".repeat(64));
        intent.expected_remote_resource_revision = "1".to_owned();
        intent.next_remote_resource_revision = "2".to_owned();
        intent.create_operation_id = None;
        assert_eq!(
            operation_result_digest(&intent, Some("keeper_1"), "succeeded"),
            operation_result_digest(&intent, Some("keeper_1"), "succeeded")
        );
    }

    #[test]
    fn stale_forward_retry_after_later_revision_cannot_replace_last_result() {
        let sandbox = tempfile::tempdir().unwrap();
        let roots = test_roots(sandbox.path());
        let resource_key = test_resource_key("workspace_forward", None);
        write_json_atomic(
            &workspace_descriptor_path(&roots, &resource_key),
            &WorkspaceDescriptor {
                version: 1,
                resource_key: resource_key.clone(),
                create_operation_id: "workspace_create_1".to_owned(),
                canonical_create_payload_hash: "a".repeat(64),
                create_result_digest: "b".repeat(64),
                remote_resource_revision: "1".to_owned(),
                last_operation_id: "workspace_create_1".to_owned(),
                last_operation_payload_hash: "a".repeat(64),
                last_result_digest: "b".repeat(64),
                state: "active".to_owned(),
                updated_at: now_rfc3339(),
                conversion_transaction_id: None,
                remote_snapshot_hash: None,
                provisional_created_at: None,
                source_workspace_revision: None,
                pending_operation: None,
                failed_operation: None,
            },
        )
        .unwrap();
        let first_payload = RemoteOperationPayload::ForwardEnsure {
            forward_id: "forward_1".to_owned(),
            remote_host: "127.0.0.1".to_owned(),
            remote_port: 3000,
            local_bind_host: "127.0.0.1".to_owned(),
            local_port: None,
        };
        let first_intent =
            workspace_test_intent(&resource_key, "forward_ensure_1", "1", "2", &first_payload);
        let first = execute_operation(
            &roots,
            RemoteRetentionPolicy::default(),
            Path::new("/unused-kmuxd"),
            first_intent.clone(),
            first_payload.clone(),
        )
        .unwrap();
        assert_eq!(first.outcome, "succeeded");

        let last_payload = RemoteOperationPayload::ForwardEnsure {
            forward_id: "forward_1".to_owned(),
            remote_host: "127.0.0.1".to_owned(),
            remote_port: 3000,
            local_bind_host: "127.0.0.1".to_owned(),
            local_port: Some(41_000),
        };
        let last_intent =
            workspace_test_intent(&resource_key, "forward_ensure_2", "2", "3", &last_payload);
        let last = execute_operation(
            &roots,
            RemoteRetentionPolicy::default(),
            Path::new("/unused-kmuxd"),
            last_intent.clone(),
            last_payload.clone(),
        )
        .unwrap();
        assert_eq!(last.outcome, "succeeded");

        let stale = execute_operation(
            &roots,
            RemoteRetentionPolicy::default(),
            Path::new("/unused-kmuxd"),
            first_intent,
            first_payload,
        )
        .unwrap();
        assert_eq!(stale.outcome, "failed");
        assert_eq!(stale.code.as_deref(), Some("operation-stale"));

        let retained = execute_operation(
            &roots,
            RemoteRetentionPolicy::default(),
            Path::new("/unused-kmuxd"),
            last_intent,
            last_payload,
        )
        .unwrap();
        assert_eq!(retained.outcome, "succeeded");
        assert_eq!(retained.result_digest, last.result_digest);
        assert_eq!(retained.remote_resource_revision.as_deref(), Some("3"));

        let observed = observe_forwards(
            &roots,
            &resource_key.desktop_installation_id,
            &resource_key.target_id,
        )
        .unwrap();
        assert_eq!(observed.forwards.len(), 1);
        assert_eq!(observed.forwards[0].local_port, Some(41_000));
        assert_eq!(observed.forwards[0].operation_id, "forward_ensure_2");
    }

    #[test]
    fn definitive_worktree_failure_is_durable_across_external_state_change() {
        let sandbox = tempfile::tempdir().unwrap();
        let roots = test_roots(sandbox.path());
        let repository = sandbox.path().join("repository");
        fs::create_dir_all(&repository).unwrap();
        let run_git = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .status()
                .unwrap();
            assert!(status.success(), "git command failed: {arguments:?}");
        };
        run_git(&["init", "-b", "main"]);
        fs::write(repository.join("README.md"), "kmux\n").unwrap();
        run_git(&["add", "README.md"]);
        run_git(&[
            "-c",
            "user.name=kmux",
            "-c",
            "user.email=kmux@example.invalid",
            "commit",
            "-m",
            "initial",
        ]);
        let branch = "kmux/already-exists";
        run_git(&["branch", branch]);

        let resource_key = test_resource_key("workspace_worktree", None);
        write_json_atomic(
            &workspace_descriptor_path(&roots, &resource_key),
            &WorkspaceDescriptor {
                version: 1,
                resource_key: resource_key.clone(),
                create_operation_id: "workspace_create_1".to_owned(),
                canonical_create_payload_hash: "a".repeat(64),
                create_result_digest: "b".repeat(64),
                remote_resource_revision: "1".to_owned(),
                last_operation_id: "workspace_create_1".to_owned(),
                last_operation_payload_hash: "a".repeat(64),
                last_result_digest: "b".repeat(64),
                state: "active".to_owned(),
                updated_at: now_rfc3339(),
                conversion_transaction_id: None,
                remote_snapshot_hash: None,
                provisional_created_at: None,
                source_workspace_revision: None,
                pending_operation: None,
                failed_operation: None,
            },
        )
        .unwrap();
        let worktree_path = sandbox.path().join("worktree");
        let payload = RemoteOperationPayload::WorktreeCreate {
            workspace_id: resource_key.workspace_id.clone(),
            cwd: repository.to_string_lossy().into_owned(),
            path: worktree_path.to_string_lossy().into_owned(),
            base_ref: "main".to_owned(),
            branch: branch.to_owned(),
        };
        let payload_hash = canonical_payload_hash(&payload).unwrap();
        let intent = RemoteOperationIntent {
            operation_id: "worktree_create_1".to_owned(),
            kind: "worktree.create".to_owned(),
            resource_key,
            expected_workspace_revision: "c".repeat(64),
            expected_remote_resource_revision: "1".to_owned(),
            next_remote_resource_revision: "2".to_owned(),
            conversion_transaction_id: None,
            create_operation_id: None,
            canonical_payload_hash: payload_hash,
            created_at: "2026-07-18T00:00:00.000Z".to_owned(),
        };

        let first = execute_operation(
            &roots,
            RemoteRetentionPolicy::default(),
            Path::new("/unused-kmuxd"),
            intent.clone(),
            payload.clone(),
        )
        .unwrap();
        assert_eq!(first.outcome, "failed");
        assert_eq!(first.code.as_deref(), Some("branch-exists"));

        run_git(&["branch", "-D", branch]);
        let retry = execute_operation(
            &roots,
            RemoteRetentionPolicy::default(),
            Path::new("/unused-kmuxd"),
            intent,
            payload,
        )
        .unwrap();

        assert_eq!(retry.outcome, "failed");
        assert_eq!(retry.code, first.code);
        assert_eq!(retry.message, first.message);
        assert_eq!(retry.result_digest, first.result_digest);
        assert!(!worktree_path.exists());
    }

    #[test]
    fn managed_worktree_create_prepares_private_parent_and_rejects_escape() {
        let sandbox = tempfile::tempdir().unwrap();
        let roots = test_roots(sandbox.path());
        let repository = sandbox.path().join("repository");
        fs::create_dir_all(&repository).unwrap();
        let run_git = |arguments: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(arguments)
                .status()
                .unwrap();
            assert!(status.success(), "git command failed: {arguments:?}");
        };
        run_git(&["init", "-b", "main"]);
        fs::write(repository.join("README.md"), "kmux\n").unwrap();
        run_git(&["add", "README.md"]);
        run_git(&[
            "-c",
            "user.name=kmux",
            "-c",
            "user.email=kmux@example.invalid",
            "commit",
            "-m",
            "initial",
        ]);
        let managed = Path::new(&roots.state_root).join("worktrees/repository/kmux-feature");

        apply_worktree_create(
            &roots,
            &repository.to_string_lossy(),
            &managed.to_string_lossy(),
            "main",
            "kmux/feature",
        )
        .unwrap();

        assert!(managed.join("README.md").is_file());
        let parent = fs::symlink_metadata(managed.parent().unwrap()).unwrap();
        assert_eq!(parent.mode() & 0o077, 0);
        let common_git_dir = inspect_git_repository(&repository.to_string_lossy(), 0, None)
            .unwrap()
            .repository
            .unwrap()
            .common_git_dir;
        assert!(matches!(
            apply_worktree_remove(
                &repository.to_string_lossy(),
                &managed.to_string_lossy(),
                true,
                "kmux/replacement",
                &common_git_dir,
            ),
            Err(TargetLocalEffectError::Definitive {
                code: "worktree-changed",
                ..
            })
        ));
        assert!(managed.is_dir());
        assert!(matches!(
            apply_worktree_remove(
                &repository.to_string_lossy(),
                &managed.to_string_lossy(),
                true,
                "kmux/feature",
                &sandbox
                    .path()
                    .join("another-repository/.git")
                    .to_string_lossy(),
            ),
            Err(TargetLocalEffectError::Definitive {
                code: "worktree-changed",
                ..
            })
        ));
        assert!(managed.is_dir());
        assert!(matches!(
            apply_worktree_create(
                &roots,
                &repository.to_string_lossy(),
                &sandbox.path().join("outside").to_string_lossy(),
                "main",
                "kmux/outside",
            ),
            Err(TargetLocalEffectError::Definitive {
                code: "invalid-worktree-path",
                ..
            })
        ));
        assert!(!sandbox.path().join("outside").exists());
        apply_worktree_remove(
            &repository.to_string_lossy(),
            &managed.to_string_lossy(),
            true,
            "kmux/feature",
            &common_git_dir,
        )
        .unwrap();
        assert!(!managed.exists());
    }

    #[test]
    fn operation_failure_messages_are_bounded_by_utf8_bytes() {
        let failure = operation_failure("operation_1", "git-failed", &"界".repeat(4_096));
        let message = failure.message.unwrap();

        assert!(message.len() <= MAX_OPERATION_MESSAGE_BYTES);
        assert!(message.ends_with(" (truncated)"));
    }

    #[test]
    fn bounded_commands_terminate_their_process_group_after_timeout() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "trap '' TERM; sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let started = Instant::now();

        let result = run_bounded_command(
            &mut command,
            1_024,
            Duration::from_millis(50),
            "test command",
        );

        assert!(matches!(
            result,
            Err(BridgeRuntimeError::Retryable(message)) if message.contains("timeout")
        ));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn conversion_promotion_is_idempotent_and_keeps_stable_descriptor_evidence() {
        let sandbox = tempfile::tempdir().unwrap();
        let roots = test_roots(sandbox.path());
        let transaction_id = "conversion_1";
        let workspace_operation_id = "workspace_create_1";
        let session_operation_id = "session_create_1";
        let workspace_key = test_resource_key("workspace_conversion", None);
        let session_key = test_resource_key("workspace_conversion", Some("session_conversion"));
        let payload = r#"{"workspaceId":"workspace_conversion"}"#;
        let snapshot_hash = format!("{:x}", Sha256::digest(payload.as_bytes()));

        let workspace_path = workspace_descriptor_path(&roots, &workspace_key);
        write_json_atomic(
            &workspace_path,
            &test_workspace_descriptor(
                workspace_key.clone(),
                transaction_id,
                workspace_operation_id,
                &snapshot_hash,
            ),
        )
        .unwrap();
        let session_path = session_descriptor_path(Path::new(&roots.state_root), &session_key);
        write_session_descriptor(
            &session_path,
            &test_session_descriptor(
                sandbox.path(),
                session_key.clone(),
                transaction_id,
                session_operation_id,
                &snapshot_hash,
                false,
            ),
        )
        .unwrap();
        write_json_atomic(
            &conversion_snapshot_path(&roots, &snapshot_hash),
            &ConversionSnapshotRecord {
                version: 1,
                transaction_id: transaction_id.to_owned(),
                remote_snapshot_hash: snapshot_hash.clone(),
                payload: payload.to_owned(),
                written_at: "2026-07-18T00:00:00.000Z".to_owned(),
            },
        )
        .unwrap();

        let first = promote_conversion(
            &roots,
            transaction_id,
            workspace_operation_id,
            session_operation_id,
            &workspace_key,
            &session_key,
            &snapshot_hash,
        )
        .unwrap();
        let first_workspace_hash = hash_file(&workspace_path).unwrap();
        let first_session_hash = hash_file(&session_path).unwrap();
        let second = promote_conversion(
            &roots,
            transaction_id,
            workspace_operation_id,
            session_operation_id,
            &workspace_key,
            &session_key,
            &snapshot_hash,
        )
        .unwrap();

        assert_eq!(first.remote_promotion_hash, second.remote_promotion_hash);
        assert_eq!(hash_file(&workspace_path).unwrap(), first_workspace_hash);
        assert_eq!(hash_file(&session_path).unwrap(), first_session_hash);
        assert_eq!(
            load_session_descriptor(&session_path)
                .unwrap()
                .lifecycle_state,
            SessionLifecycleState::Committed
        );
    }

    #[test]
    fn provisional_reclaim_terminates_only_never_leased_expired_sessions() {
        let sandbox = tempfile::tempdir().unwrap();
        let roots = test_roots(sandbox.path());
        let snapshot_hash = "a".repeat(64);
        for (workspace_id, session_id, transaction_id, ever_leased) in [
            ("workspace_expired", "session_expired", "tx_expired", false),
            ("workspace_leased", "session_leased", "tx_leased", true),
        ] {
            let workspace_key = test_resource_key(workspace_id, None);
            write_json_atomic(
                &workspace_descriptor_path(&roots, &workspace_key),
                &test_workspace_descriptor(
                    workspace_key,
                    transaction_id,
                    &format!("workspace_{transaction_id}"),
                    &snapshot_hash,
                ),
            )
            .unwrap();
            let session_key = test_resource_key(workspace_id, Some(session_id));
            let mut descriptor = test_session_descriptor(
                sandbox.path(),
                session_key.clone(),
                transaction_id,
                &format!("session_{transaction_id}"),
                &snapshot_hash,
                ever_leased,
            );
            descriptor.state = SessionDescriptorState::Exited;
            descriptor.exit_code = Some(0);
            descriptor.provisional_created_at = Some("2026-07-16T00:00:00.000Z".to_owned());
            write_session_descriptor(
                &session_descriptor_path(Path::new(&roots.state_root), &session_key),
                &descriptor,
            )
            .unwrap();
        }

        let reclaimed = reclaim_provisionals(
            &roots,
            "desktop_1",
            "target_1",
            &[],
            "2026-07-18T00:00:00.000Z",
        )
        .unwrap();

        assert_eq!(
            reclaimed.terminated_transaction_ids,
            vec!["tx_expired".to_owned()]
        );
        assert_eq!(
            reclaimed.skipped_ever_leased_transaction_ids,
            vec!["tx_leased".to_owned()]
        );
        let expired = load_session_descriptor(&session_descriptor_path(
            Path::new(&roots.state_root),
            &test_resource_key("workspace_expired", Some("session_expired")),
        ))
        .unwrap();
        assert_eq!(expired.lifecycle_state, SessionLifecycleState::Abandoned);
        let leased = load_session_descriptor(&session_descriptor_path(
            Path::new(&roots.state_root),
            &test_resource_key("workspace_leased", Some("session_leased")),
        ))
        .unwrap();
        assert_eq!(leased.lifecycle_state, SessionLifecycleState::Provisional);
    }

    #[test]
    fn provisional_reclaim_bounds_workspace_only_orphans_and_removes_their_snapshots() {
        let sandbox = tempfile::tempdir().unwrap();
        let roots = test_roots(sandbox.path());
        let mut snapshot_paths = BTreeMap::new();
        for (workspace_id, transaction_id) in [
            ("workspace_orphan", "tx_orphan"),
            ("workspace_protected", "tx_protected"),
        ] {
            let payload = format!(r#"{{"workspaceId":"{workspace_id}"}}"#);
            let snapshot_hash = format!("{:x}", Sha256::digest(payload.as_bytes()));
            let workspace_key = test_resource_key(workspace_id, None);
            write_json_atomic(
                &workspace_descriptor_path(&roots, &workspace_key),
                &test_workspace_descriptor(
                    workspace_key,
                    transaction_id,
                    &format!("workspace_{transaction_id}"),
                    &snapshot_hash,
                ),
            )
            .unwrap();
            let snapshot_path = conversion_snapshot_path(&roots, &snapshot_hash);
            write_json_atomic(
                &snapshot_path,
                &ConversionSnapshotRecord {
                    version: 1,
                    transaction_id: transaction_id.to_owned(),
                    remote_snapshot_hash: snapshot_hash,
                    payload,
                    written_at: "2026-07-16T00:00:00.000Z".to_owned(),
                },
            )
            .unwrap();
            snapshot_paths.insert(transaction_id, snapshot_path);
        }

        let reclaimed = reclaim_provisionals(
            &roots,
            "desktop_1",
            "target_1",
            &["tx_protected".to_owned()],
            "2026-07-18T00:00:00.000Z",
        )
        .unwrap();

        assert_eq!(reclaimed.protected_count, 1);
        assert_eq!(
            reclaimed.terminated_transaction_ids,
            vec!["tx_orphan".to_owned()]
        );
        assert!(!snapshot_paths["tx_orphan"].exists());
        assert!(snapshot_paths["tx_protected"].exists());
        let orphan: WorkspaceDescriptor = read_private_json(
            &workspace_descriptor_path(&roots, &test_resource_key("workspace_orphan", None)),
            256 * 1024,
        )
        .unwrap();
        assert_eq!(orphan.state, "abandoned");
        let protected: WorkspaceDescriptor = read_private_json(
            &workspace_descriptor_path(&roots, &test_resource_key("workspace_protected", None)),
            256 * 1024,
        )
        .unwrap();
        assert_eq!(protected.state, "provisional");
    }

    #[test]
    fn remote_agent_hook_shim_is_silent_unless_json_output_is_requested() {
        let sandbox = tempfile::tempdir().unwrap();
        let executable = sandbox.path().join("fake-kmuxd");
        fs::write(
            &executable,
            "#!/bin/sh\nprintf '{\"decision\":\"allow\"}\\n'\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let bin = ensure_remote_cli_shims(sandbox.path(), &executable, &"a".repeat(64)).unwrap();
        let hook = bin.join("kmux-agent-hook");

        let silent = std::process::Command::new(&hook)
            .args(["codex", "Stop"])
            .env_remove("KMUX_AGENT_HOOK_OUTPUT_MODE")
            .output()
            .unwrap();
        assert!(silent.status.success());
        assert!(silent.stdout.is_empty());

        let json = std::process::Command::new(&hook)
            .args(["antigravity", "Stop"])
            .env("KMUX_AGENT_HOOK_OUTPUT_MODE", "json")
            .output()
            .unwrap();
        assert!(json.status.success());
        assert_eq!(json.stdout, b"{\"decision\":\"allow\"}\n");
    }

    #[test]
    fn launch_input_ack_repairs_an_older_durable_completion_record() {
        let sandbox = tempfile::tempdir().unwrap();
        let mut descriptor = test_session_descriptor(
            sandbox.path(),
            test_resource_key("workspace_1", Some("session_1")),
            "tx_1",
            "create_1",
            &"a".repeat(64),
            false,
        );
        let payload_hash = format!("{:x}", Sha256::digest(b"hello"));
        descriptor.launch_input = Some(kmux_keeper::LaunchInputRecord {
            operation_id: "launch_1".to_owned(),
            payload_hash: payload_hash.clone(),
            byte_length: 5,
            written_offset: 2,
            outcome: LaunchInputOutcome::OutcomeUnknown,
        });

        mark_launch_input_written(&mut descriptor, "launch_1", &payload_hash, 5, 5).unwrap();
        assert_eq!(
            descriptor.launch_input,
            Some(kmux_keeper::LaunchInputRecord {
                operation_id: "launch_1".to_owned(),
                payload_hash,
                byte_length: 5,
                written_offset: 5,
                outcome: LaunchInputOutcome::Written,
            })
        );
    }

    #[test]
    fn managed_remote_environment_does_not_change_the_user_launch_descriptor() {
        let env = BTreeMap::from([
            ("KMUX_CLI_PATH".to_owned(), "/kmux/bin/kmux".to_owned()),
            ("KMUX_AGENT_BIN_DIR".to_owned(), "/kmux/bin".to_owned()),
            ("KMUX_AUTH_TOKEN".to_owned(), "secret".to_owned()),
            ("PATH".to_owned(), "/custom/bin:/usr/bin".to_owned()),
            ("USER_VALUE".to_owned(), "preserved".to_owned()),
        ]);

        assert_eq!(
            user_launch_env(Some(&env)),
            Some(BTreeMap::from([
                ("PATH".to_owned(), "/custom/bin:/usr/bin".to_owned()),
                ("USER_VALUE".to_owned(), "preserved".to_owned()),
            ]))
        );
    }

    #[test]
    fn attach_health_probe_never_holds_the_descriptor_lock_needed_by_the_keeper() {
        let sandbox = tempfile::tempdir().unwrap();
        let roots = test_roots(sandbox.path());
        prepare_runtime_directories(&roots).unwrap();
        let resource_key = test_resource_key("workspace_attach", Some("session_attach"));
        let descriptor_path = session_descriptor_path(Path::new(&roots.state_root), &resource_key);
        let mut descriptor = test_session_descriptor(
            sandbox.path(),
            resource_key.clone(),
            "tx_attach",
            "create_attach",
            &"a".repeat(64),
            false,
        );
        descriptor.state = SessionDescriptorState::Running;
        descriptor.keeper_pid = Some(std::process::id());
        descriptor.child_pid = Some(std::process::id());
        descriptor.exit_code = None;
        let socket_path = PathBuf::from(&descriptor.socket_path);
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();
        let (server, lock_result_rx) = spawn_health_lock_probe(&descriptor_path, &socket_path);

        let authorized = authorize_attach(
            &roots,
            resource_key,
            Some(&descriptor.keeper_generation),
            AttachmentAccess::Write,
        );
        assert!(
            lock_result_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "keeper health RPC observed the descriptor lock held"
        );
        server.join().unwrap();
        let authorized = authorized.unwrap();
        assert_eq!(authorized.keeper_generation, descriptor.keeper_generation);
        assert!(matches!(
            authorized.terminal_proxy,
            TerminalProxyEndpoint::Direct
        ));
    }

    #[test]
    fn observation_health_probe_never_holds_the_descriptor_lock_needed_by_the_keeper() {
        let sandbox = tempfile::tempdir().unwrap();
        let roots = test_roots(sandbox.path());
        prepare_runtime_directories(&roots).unwrap();
        let resource_key = test_resource_key("workspace_observe", Some("session_observe"));
        let descriptor_path = session_descriptor_path(Path::new(&roots.state_root), &resource_key);
        let mut descriptor = test_session_descriptor(
            sandbox.path(),
            resource_key,
            "tx_observe",
            "create_observe",
            &"a".repeat(64),
            false,
        );
        descriptor.state = SessionDescriptorState::Running;
        descriptor.keeper_pid = Some(std::process::id());
        descriptor.child_pid = Some(std::process::id());
        descriptor.exit_code = None;
        let socket_path = PathBuf::from(&descriptor.socket_path);
        write_session_descriptor(&descriptor_path, &descriptor).unwrap();
        let (server, lock_result_rx) = spawn_health_lock_probe(&descriptor_path, &socket_path);

        let response = observe(&roots, "bridge_1", "desktop_1", "target_1");
        assert!(
            lock_result_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "observation health RPC retained the descriptor lock"
        );
        server.join().unwrap();
        let response = response.unwrap();
        assert_eq!(response.keepers.len(), 1);
        assert_eq!(response.keepers[0].process_state, "running");
        assert_eq!(
            response.keepers[0].keeper_generation,
            descriptor.keeper_generation
        );
    }

    #[test]
    fn observe_reports_a_definitively_absent_running_keeper_as_exited() {
        let sandbox = tempfile::tempdir().unwrap();
        let roots = test_roots(sandbox.path());
        let resource_key = test_resource_key("workspace_crashed", Some("session_crashed"));
        let mut descriptor = test_session_descriptor(
            sandbox.path(),
            resource_key.clone(),
            "tx_crashed",
            "create_crashed",
            &"a".repeat(64),
            false,
        );
        descriptor.state = SessionDescriptorState::Running;
        descriptor.keeper_pid = Some(i32::MAX as u32);
        descriptor.exit_code = None;
        write_json_atomic(
            &session_descriptor_path(Path::new(&roots.state_root), &resource_key),
            &descriptor,
        )
        .unwrap();

        let response = observe(&roots, "bridge_1", "desktop_1", "target_1").unwrap();
        assert_eq!(response.keepers.len(), 1);
        assert_eq!(response.keepers[0].keeper_generation, "keeper_tx_crashed");
        assert_eq!(response.keepers[0].process_state, "exited");
        assert_eq!(response.keepers[0].exit_code, None);
    }

    #[test]
    fn fixed_timestamp_parser_rejects_impossible_calendar_dates() {
        assert!(parse_fixed_rfc3339_millis("2024-02-29T23:59:59.999Z").is_some());
        assert!(parse_fixed_rfc3339_millis("2025-02-29T00:00:00.000Z").is_none());
        assert!(parse_fixed_rfc3339_millis("2026-04-31T00:00:00.000Z").is_none());
    }

    fn spawn_health_lock_probe(
        descriptor_path: &Path,
        socket_path: &Path,
    ) -> (std::thread::JoinHandle<()>, std::sync::mpsc::Receiver<bool>) {
        let listener = UnixListener::bind(socket_path).unwrap();
        let descriptor_path = descriptor_path.to_path_buf();
        let (lock_result_tx, lock_result_rx) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request: Value = read_control(&mut stream).unwrap().unwrap();
            assert_eq!(request["type"], "keeper.health");

            let lock_path = descriptor_path.with_extension("lock");
            let lock_file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .mode(0o600)
                .custom_flags(OFlag::O_NOFOLLOW.bits())
                .open(lock_path)
                .unwrap();
            match Flock::lock(lock_file, FlockArg::LockExclusiveNonblock) {
                Ok(lock) => {
                    lock_result_tx.send(true).unwrap();
                    write_control(
                        &mut stream,
                        &KeeperRpcResponse::Health {
                            outcome: "running".to_owned(),
                            storage: RemoteSessionStorageStatus::default(),
                        },
                    )
                    .unwrap();
                    drop(lock);
                }
                Err((_file, Errno::EAGAIN)) => {
                    lock_result_tx.send(false).unwrap();
                    write_control(
                        &mut stream,
                        &KeeperRpcResponse::Error {
                            code: "lock-busy".to_owned(),
                            message: "health probe retained the descriptor lock".to_owned(),
                            retryable: false,
                        },
                    )
                    .unwrap();
                }
                Err((_file, error)) => panic!("unexpected descriptor lock error: {error}"),
            }
        });
        (server, lock_result_rx)
    }

    fn test_roots(root: &Path) -> RemoteRuntimeRoots {
        RemoteRuntimeRoots {
            install_root: root.join("install").to_string_lossy().into_owned(),
            authority_root: root.join("authority").to_string_lossy().into_owned(),
            state_root: root.join("state").to_string_lossy().into_owned(),
            runtime_root: root.join("run").to_string_lossy().into_owned(),
        }
    }

    fn test_resource_key(workspace_id: &str, session_id: Option<&str>) -> RemoteResourceKey {
        RemoteResourceKey {
            desktop_installation_id: "desktop_1".to_owned(),
            target_id: "target_1".to_owned(),
            workspace_id: workspace_id.to_owned(),
            session_id: session_id.map(str::to_owned),
        }
    }

    fn test_workspace_descriptor(
        resource_key: RemoteResourceKey,
        transaction_id: &str,
        operation_id: &str,
        snapshot_hash: &str,
    ) -> WorkspaceDescriptor {
        WorkspaceDescriptor {
            version: 1,
            resource_key,
            create_operation_id: operation_id.to_owned(),
            canonical_create_payload_hash: snapshot_hash.to_owned(),
            create_result_digest: "b".repeat(64),
            remote_resource_revision: "1".to_owned(),
            last_operation_id: operation_id.to_owned(),
            last_operation_payload_hash: snapshot_hash.to_owned(),
            last_result_digest: "b".repeat(64),
            state: "provisional".to_owned(),
            updated_at: "2026-07-16T00:00:00.000Z".to_owned(),
            conversion_transaction_id: Some(transaction_id.to_owned()),
            remote_snapshot_hash: Some(snapshot_hash.to_owned()),
            provisional_created_at: Some("2026-07-16T00:00:00.000Z".to_owned()),
            source_workspace_revision: Some("c".repeat(64)),
            pending_operation: None,
            failed_operation: None,
        }
    }

    fn test_session_descriptor(
        root: &Path,
        resource_key: RemoteResourceKey,
        transaction_id: &str,
        operation_id: &str,
        snapshot_hash: &str,
        ever_granted_writer_lease: bool,
    ) -> SessionDescriptor {
        SessionDescriptor {
            version: SESSION_DESCRIPTOR_VERSION,
            resource_key,
            keeper_generation: format!("keeper_{transaction_id}"),
            executable_generation: "d".repeat(64),
            executable_path: root.join("kmuxd").to_string_lossy().into_owned(),
            keeper_local_protocol_major: kmux_compat::KEEPER_LOCAL_PROTOCOL_MAJOR,
            terminal_wire_version: kmux_compat::TERMINAL_WIRE_VERSION,
            create_operation_id: operation_id.to_owned(),
            canonical_create_payload_hash: snapshot_hash.to_owned(),
            create_result_digest: "e".repeat(64),
            remote_resource_revision: "1".to_owned(),
            last_operation_id: operation_id.to_owned(),
            last_operation_payload_hash: snapshot_hash.to_owned(),
            last_result_digest: "e".repeat(64),
            state: SessionDescriptorState::Exited,
            socket_path: root
                .join(format!("{transaction_id}.sock"))
                .to_string_lossy()
                .into_owned(),
            journal_path: root
                .join(format!("{transaction_id}.journal"))
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
            keeper_pid: Some(1),
            child_pid: Some(2),
            exit_code: Some(0),
            launch_input: None,
            updated_at: "2026-07-16T00:00:00.000Z".to_owned(),
            lifecycle_state: SessionLifecycleState::Provisional,
            conversion_transaction_id: Some(transaction_id.to_owned()),
            remote_snapshot_hash: Some(snapshot_hash.to_owned()),
            provisional_created_at: Some("2026-07-16T00:00:00.000Z".to_owned()),
            ever_granted_writer_lease,
            storage_status: RemoteSessionStorageStatus::default(),
            retention_policy: RemoteRetentionPolicy::default(),
            retained_checkpoint: None,
            truncated_before_sequence: None,
        }
    }
}
