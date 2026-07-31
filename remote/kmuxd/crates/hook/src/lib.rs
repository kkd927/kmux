#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kmux_compat::RemoteResourceKey;
use kmux_platform::effective_uid;
use nix::errno::Errno;
use nix::fcntl::{Flock, FlockArg, OFlag};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

pub const MAX_HOOK_PAYLOAD_BYTES: usize = 64 * 1024;
pub const MAX_SPOOL_EVENTS: usize = 4_096;
pub const MAX_SPOOL_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_REPLAY_EVENTS: usize = 128;
pub const MAX_REPLAY_BYTES: usize = 192 * 1024;
pub const MAX_OWNED_AGENT_SESSIONS: usize = 500;
pub const OWNED_AGENT_SESSION_TTL_MILLIS: u64 = 30 * 24 * 60 * 60 * 1_000;
const MAX_EVENT_FILE_BYTES: u64 = 96 * 1024;
const MAX_METADATA_BYTES: u64 = 2 * 1024 * 1024;
const MAX_OWNED_AGENT_REGISTRY_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ENDPOINT_BYTES: u64 = 64 * 1024;
const MAX_DESCRIPTOR_BYTES: u64 = 256 * 1024;
const MAX_RECENT_EVENT_IDENTITIES: usize = MAX_SPOOL_EVENTS;
const MAX_CONTROL_ID_BYTES: usize = 256;
const MAX_EVENT_NAME_BYTES: usize = 512;
const SPOOL_VERSION: u16 = 1;
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookCapabilities {
    pub process_role: &'static str,
    pub available: bool,
    pub durable_spool: bool,
}

#[must_use]
pub fn capabilities() -> HookCapabilities {
    HookCapabilities {
        process_role: "hook",
        available: true,
        durable_spool: true,
    }
}

#[derive(Debug, Error)]
pub enum HookError {
    #[error("hook spool I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("hook spool JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("hook request is invalid: {0}")]
    Invalid(&'static str),
    #[error("hook request is not authorized")]
    Unauthorized,
    #[error("hook spool is full")]
    SpoolFull,
    #[error("hook spool lock timed out")]
    LockTimedOut,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionControlEndpoint {
    pub version: u16,
    pub resource_key: RemoteResourceKey,
    pub surface_id: String,
    pub keeper_generation: String,
    pub state_root: String,
    pub descriptor_path: String,
    pub token_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_title: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpoolEvent {
    pub version: u16,
    pub sequence: String,
    pub event_id: String,
    pub kind: String,
    pub name: String,
    pub resource_key: RemoteResourceKey,
    pub surface_id: String,
    pub keeper_generation: String,
    pub created_at_unix_ms: String,
    pub payload: Value,
}

#[derive(Clone, Debug)]
pub struct AdmitEventRequest {
    pub event_id: Option<String>,
    pub kind: String,
    pub name: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventAdmission {
    pub event_id: String,
    pub sequence: String,
    pub durable: bool,
    pub duplicate: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventReplayPage {
    pub events: Vec<SpoolEvent>,
    pub acknowledged_through: String,
    pub has_more: bool,
    pub admitted_count: u64,
    pub dropped_low_value_count: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EventAcknowledgement {
    pub acknowledged_through: String,
    pub removed_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnedAgentSession {
    pub vendor: String,
    pub vendor_session_id: String,
    #[serde(rename = "claimedAt")]
    pub claimed_at_unix_ms: u64,
    #[serde(rename = "lastKmuxSeenAt")]
    pub last_kmux_seen_at_unix_ms: u64,
    pub workspace_id: String,
    pub kmux_session_id: String,
    pub surface_id: String,
    pub keeper_generation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspace_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_directory_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_title: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnedAgentSessionSourceKind {
    History,
    Usage,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnedAgentSessionSourceUpdate {
    pub vendor: String,
    pub vendor_session_id: String,
    pub kind: OwnedAgentSessionSourceKind,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnedAgentSessionRegistry {
    version: u16,
    desktop_installation_id: String,
    target_id: String,
    sessions: Vec<OwnedAgentSession>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecentEventIdentity {
    event_id: String,
    sequence: u64,
    identity_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpoolMetadata {
    version: u16,
    next_sequence: u64,
    acknowledged_through: u64,
    admitted_count: u64,
    dropped_low_value_count: u64,
    #[serde(default)]
    recent_events: Vec<RecentEventIdentity>,
}

impl Default for SpoolMetadata {
    fn default() -> Self {
        Self {
            version: SPOOL_VERSION,
            next_sequence: 1,
            acknowledged_through: 0,
            admitted_count: 0,
            dropped_low_value_count: 0,
            recent_events: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveSessionDescriptor {
    version: u16,
    resource_key: RemoteResourceKey,
    keeper_generation: String,
    state: String,
}

struct StoredEvent {
    path: PathBuf,
    sequence: u64,
    byte_length: usize,
    event: SpoolEvent,
}

pub fn write_session_control_endpoint(
    path: &Path,
    endpoint: &SessionControlEndpoint,
) -> Result<(), HookError> {
    validate_endpoint(endpoint)?;
    let parent = path
        .parent()
        .ok_or(HookError::Invalid("control endpoint has no parent"))?;
    ensure_private_directory(parent)?;
    write_json_atomic(path, endpoint)
}

pub fn load_session_control_endpoint(path: &Path) -> Result<SessionControlEndpoint, HookError> {
    let endpoint: SessionControlEndpoint = read_private_json(path, MAX_ENDPOINT_BYTES)?;
    validate_endpoint(&endpoint)?;
    Ok(endpoint)
}

pub fn authorize_session_control_endpoint(
    path: &Path,
    token: &str,
) -> Result<SessionControlEndpoint, HookError> {
    if token.is_empty() || token.len() > 4_096 || token.chars().any(char::is_control) {
        return Err(HookError::Unauthorized);
    }
    let endpoint = load_session_control_endpoint(path)?;
    let actual = format!("{:x}", Sha256::digest(token.as_bytes()));
    if actual != endpoint.token_sha256 {
        return Err(HookError::Unauthorized);
    }
    Ok(endpoint)
}

pub fn admit_event_from_endpoint(
    endpoint_path: &Path,
    token: &str,
    request: AdmitEventRequest,
) -> Result<EventAdmission, HookError> {
    let endpoint = authorize_session_control_endpoint(endpoint_path, token)?;
    require_active_session_descriptor(&endpoint)?;
    let admission = admit_event(&endpoint, request.clone())?;
    // Ownership metadata is a derived projection. Its failure must not undo a
    // hook event that is already durable in the primary spool.
    record_owned_agent_session_event_best_effort(&endpoint, &request);
    Ok(admission)
}

pub fn load_owned_agent_sessions(
    state_root: &Path,
    desktop_installation_id: &str,
    target_id: &str,
) -> Result<Vec<OwnedAgentSession>, HookError> {
    load_owned_agent_sessions_at(
        state_root,
        desktop_installation_id,
        target_id,
        unix_millis()?,
    )
}

pub fn cache_owned_agent_session_sources(
    state_root: &Path,
    desktop_installation_id: &str,
    target_id: &str,
    updates: &[OwnedAgentSessionSourceUpdate],
) -> Result<(), HookError> {
    if updates.is_empty() {
        return Ok(());
    }
    let directory = owned_agent_registry_directory(state_root, desktop_installation_id, target_id)?;
    ensure_private_directory(&directory)?;
    let _lock = acquire_owned_agent_registry_lock(&directory)?;
    let Some(mut registry) =
        read_owned_agent_registry(&directory, desktop_installation_id, target_id)?
    else {
        return Ok(());
    };
    let mut changed = false;
    for update in updates {
        validate_owned_agent_vendor(&update.vendor)?;
        validate_control_id(&update.vendor_session_id)?;
        let path = normalized_absolute_path(Some(&update.path));
        let Some(path) = path else {
            continue;
        };
        let Some(session) = registry.sessions.iter_mut().find(|session| {
            session.vendor == update.vendor && session.vendor_session_id == update.vendor_session_id
        }) else {
            continue;
        };
        let slot = match update.kind {
            OwnedAgentSessionSourceKind::History => &mut session.history_source_path,
            OwnedAgentSessionSourceKind::Usage => &mut session.usage_source_path,
        };
        if slot.as_deref() != Some(path.as_str()) {
            *slot = Some(path);
            changed = true;
        }
    }
    if changed {
        write_owned_agent_registry(&directory, &registry)?;
    }
    Ok(())
}

/// Durably records low-value events that were intentionally compacted by a
/// producer. This counter does not allocate an event sequence, so a bell storm
/// cannot fill the important-event spool or delay PTY ownership. The endpoint
/// and live keeper generation are still authorized exactly like an admitted
/// event.
pub fn record_low_value_drops_from_endpoint(
    endpoint_path: &Path,
    token: &str,
    dropped: u64,
) -> Result<(), HookError> {
    if dropped == 0 || dropped > 1_000_000 {
        return Err(HookError::Invalid(
            "low-value drop increment is outside its bound",
        ));
    }
    let endpoint = authorize_session_control_endpoint(endpoint_path, token)?;
    require_active_session_descriptor(&endpoint)?;
    let spool = scoped_spool_path(
        Path::new(&endpoint.state_root),
        &endpoint.resource_key.desktop_installation_id,
        &endpoint.resource_key.target_id,
    )?;
    ensure_private_directory(&spool)?;
    let _lock = acquire_spool_lock(&spool)?;
    // Drop accounting is independent of sequence allocation. Loading only the
    // bounded metadata avoids an O(event-count) scan for every compacted bell;
    // ordinary admission/replay still performs full crash reconciliation.
    let mut metadata = load_metadata(&spool)?;
    metadata.dropped_low_value_count = metadata
        .dropped_low_value_count
        .checked_add(dropped)
        .ok_or(HookError::Invalid("low-value drop counter exhausted"))?;
    let bytes = serde_json::to_vec(&metadata)?;
    if bytes.len() > MAX_METADATA_BYTES as usize {
        return Err(HookError::SpoolFull);
    }
    write_json_atomic(&metadata_path(&spool), &metadata)
}

pub fn admit_event(
    endpoint: &SessionControlEndpoint,
    request: AdmitEventRequest,
) -> Result<EventAdmission, HookError> {
    validate_endpoint(endpoint)?;
    validate_event_kind(&request.kind)?;
    validate_event_name(&request.name)?;
    let payload_bytes = serde_json::to_vec(&request.payload)?;
    if payload_bytes.len() > MAX_HOOK_PAYLOAD_BYTES {
        return Err(HookError::Invalid("hook payload exceeds 64 KiB"));
    }
    let event_id = request
        .event_id
        .unwrap_or_else(|| format!("remote-event_{}", Uuid::new_v4()));
    validate_control_id(&event_id)?;
    let spool = scoped_spool_path(
        Path::new(&endpoint.state_root),
        &endpoint.resource_key.desktop_installation_id,
        &endpoint.resource_key.target_id,
    )?;
    ensure_private_directory(&spool)?;
    let _lock = acquire_spool_lock(&spool)?;
    let (mut metadata, files) = reconcile_spool(&spool)?;
    let identity_sha256 = event_identity_sha256(
        &request.kind,
        &request.name,
        &endpoint.resource_key,
        &endpoint.surface_id,
        &endpoint.keeper_generation,
        &request.payload,
    )?;
    if let Some(existing) = metadata
        .recent_events
        .iter()
        .find(|existing| existing.event_id == event_id)
    {
        if existing.identity_sha256 != identity_sha256 {
            return Err(HookError::Invalid("event ID payload changed"));
        }
        return Ok(EventAdmission {
            event_id,
            sequence: existing.sequence.to_string(),
            durable: true,
            duplicate: true,
        });
    }
    if files.len() >= MAX_SPOOL_EVENTS {
        return Err(HookError::SpoolFull);
    }
    let sequence = metadata.next_sequence;
    let event = SpoolEvent {
        version: SPOOL_VERSION,
        sequence: sequence.to_string(),
        event_id: event_id.clone(),
        kind: request.kind,
        name: request.name,
        resource_key: endpoint.resource_key.clone(),
        surface_id: endpoint.surface_id.clone(),
        keeper_generation: endpoint.keeper_generation.clone(),
        created_at_unix_ms: unix_millis()?.to_string(),
        payload: request.payload,
    };
    let encoded = serde_json::to_vec(&event)?;
    if encoded.len() > MAX_EVENT_FILE_BYTES as usize {
        return Err(HookError::Invalid("encoded hook event is too large"));
    }
    metadata.next_sequence = sequence
        .checked_add(1)
        .ok_or(HookError::Invalid("hook sequence exhausted"))?;
    metadata.admitted_count = metadata
        .admitted_count
        .checked_add(1)
        .ok_or(HookError::Invalid("hook admitted count exhausted"))?;
    add_recent_event_identity(
        &mut metadata,
        RecentEventIdentity {
            event_id: event_id.clone(),
            sequence,
            identity_sha256,
        },
    )?;
    let metadata_bytes = serde_json::to_vec(&metadata)?;
    if metadata_bytes.len() > MAX_METADATA_BYTES as usize
        || stored_event_bytes(&files)
            .checked_add(encoded.len())
            .and_then(|total| total.checked_add(metadata_bytes.len()))
            .is_none_or(|total| total > MAX_SPOOL_BYTES)
    {
        return Err(HookError::SpoolFull);
    }
    let event_path = event_path(&spool, sequence);
    // The event becomes durable before the sequence allocator advances. If the
    // process dies between these two atomic writes, reconciliation adopts this
    // exact file instead of reusing and overwriting its sequence.
    write_bytes_atomic(&event_path, &encoded)?;
    write_json_atomic(&metadata_path(&spool), &metadata)?;
    Ok(EventAdmission {
        event_id,
        sequence: sequence.to_string(),
        durable: true,
        duplicate: false,
    })
}

pub fn replay_events(
    state_root: &Path,
    desktop_installation_id: &str,
    target_id: &str,
    after_sequence: u64,
) -> Result<EventReplayPage, HookError> {
    validate_control_id(desktop_installation_id)?;
    validate_control_id(target_id)?;
    let spool = scoped_spool_path(state_root, desktop_installation_id, target_id)?;
    ensure_private_directory(&spool)?;
    let _lock = acquire_spool_lock(&spool)?;
    let (metadata, stored_events) = reconcile_spool(&spool)?;
    let cursor = after_sequence.max(metadata.acknowledged_through);
    let mut events = Vec::new();
    let mut bytes = 0_usize;
    let mut has_more = false;
    for stored in stored_events {
        let event = stored.event;
        let sequence = stored.sequence;
        if sequence <= cursor {
            continue;
        }
        if event.resource_key.desktop_installation_id != desktop_installation_id
            || event.resource_key.target_id != target_id
        {
            return Err(HookError::Invalid("spooled event scope changed"));
        }
        let event_bytes = serde_json::to_vec(&event)?.len();
        if events.len() >= MAX_REPLAY_EVENTS
            || (!events.is_empty() && bytes.saturating_add(event_bytes) > MAX_REPLAY_BYTES)
        {
            has_more = true;
            break;
        }
        bytes = bytes.saturating_add(event_bytes);
        events.push(event);
    }
    Ok(EventReplayPage {
        events,
        acknowledged_through: metadata.acknowledged_through.to_string(),
        has_more,
        admitted_count: metadata.admitted_count,
        dropped_low_value_count: metadata.dropped_low_value_count,
    })
}

pub fn acknowledge_events(
    state_root: &Path,
    desktop_installation_id: &str,
    target_id: &str,
    through_sequence: u64,
) -> Result<EventAcknowledgement, HookError> {
    validate_control_id(desktop_installation_id)?;
    validate_control_id(target_id)?;
    let spool = scoped_spool_path(state_root, desktop_installation_id, target_id)?;
    ensure_private_directory(&spool)?;
    let _lock = acquire_spool_lock(&spool)?;
    let (mut metadata, _) = reconcile_spool(&spool)?;
    if through_sequence >= metadata.next_sequence {
        return Err(HookError::Invalid(
            "event acknowledgement is ahead of admission",
        ));
    }
    if through_sequence > metadata.acknowledged_through {
        metadata.acknowledged_through = through_sequence;
        // The durable acknowledgement always precedes reclamation. A crash can
        // therefore leave an already-acked file behind, but can never delete an
        // event that the desktop has not acknowledged.
        write_json_atomic(&metadata_path(&spool), &metadata)?;
    }
    let removed_count = cleanup_acknowledged_files(&spool, metadata.acknowledged_through)?;
    Ok(EventAcknowledgement {
        acknowledged_through: metadata.acknowledged_through.to_string(),
        removed_count,
    })
}

fn scoped_spool_path(
    state_root: &Path,
    desktop_installation_id: &str,
    target_id: &str,
) -> Result<PathBuf, HookError> {
    if !state_root.is_absolute() {
        return Err(HookError::Invalid("hook state root must be absolute"));
    }
    validate_control_id(desktop_installation_id)?;
    validate_control_id(target_id)?;
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("{desktop_installation_id}\0{target_id}").as_bytes())
    );
    Ok(state_root.join("events").join(&digest[..32]))
}

fn record_owned_agent_session_event(
    endpoint: &SessionControlEndpoint,
    request: &AdmitEventRequest,
    now_unix_ms: u64,
) -> Result<(), HookError> {
    if request.kind != "agent-hook" {
        return Ok(());
    }
    let Some((agent, hook_event)) = request.name.split_once('.') else {
        return Ok(());
    };
    let Some(vendor) = normalized_owned_agent_vendor(agent) else {
        return Ok(());
    };
    let normalized_event = hook_event
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>();
    let creates_claim = matches!(
        (vendor, normalized_event.as_str()),
        ("codex" | "claude", "sessionstart") | ("antigravity", "preinvocation")
    );
    let payload = request.payload.as_object();
    let vendor_session_id = owned_vendor_session_id(vendor, payload);
    if vendor_session_id
        .as_deref()
        .is_some_and(|value| validate_control_id(value).is_err())
    {
        return Ok(());
    }
    let directory = owned_agent_registry_directory(
        Path::new(&endpoint.state_root),
        &endpoint.resource_key.desktop_installation_id,
        &endpoint.resource_key.target_id,
    )?;
    ensure_private_directory(&directory)?;
    let _lock = acquire_owned_agent_registry_lock(&directory)?;
    let mut registry = read_owned_agent_registry(
        &directory,
        &endpoint.resource_key.desktop_installation_id,
        &endpoint.resource_key.target_id,
    )?
    .unwrap_or_else(|| OwnedAgentSessionRegistry {
        version: 1,
        desktop_installation_id: endpoint.resource_key.desktop_installation_id.clone(),
        target_id: endpoint.resource_key.target_id.clone(),
        sessions: Vec::new(),
    });
    gc_owned_agent_sessions(&mut registry.sessions, now_unix_ms);

    let kmux_session_id = endpoint
        .resource_key
        .session_id
        .as_ref()
        .expect("validated endpoint has a session ID");
    let existing_index = vendor_session_id
        .as_ref()
        .and_then(|vendor_session_id| {
            registry.sessions.iter().position(|session| {
                session.vendor == vendor && session.vendor_session_id == *vendor_session_id
            })
        })
        .or_else(|| {
            (!creates_claim).then(|| {
                let matches = registry
                    .sessions
                    .iter()
                    .enumerate()
                    .filter(|(_, session)| {
                        session.vendor == vendor && session.kmux_session_id == *kmux_session_id
                    })
                    .map(|(index, _)| index)
                    .collect::<Vec<_>>();
                if matches.len() == 1 {
                    Some(matches[0])
                } else {
                    None
                }
            })?
        });

    let workspace_paths = payload
        .and_then(|payload| payload.get("workspacePaths"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|value| normalized_absolute_path(Some(value)))
        .take(10)
        .collect::<Vec<_>>();
    let cwd = payload
        .and_then(|payload| json_string(payload, &["cwd", "projectRoot", "project_path"]))
        .and_then(|value| normalized_absolute_path(Some(&value)))
        .or_else(|| endpoint.cwd.clone())
        .or_else(|| workspace_paths.first().cloned());
    let transcript_path = payload
        .and_then(|payload| json_string(payload, &["transcriptPath", "transcript_path"]))
        .and_then(|value| normalized_absolute_path(Some(&value)));
    let artifact_directory_path = payload
        .and_then(|payload| {
            json_string(
                payload,
                &["artifactDirectoryPath", "artifact_directory_path"],
            )
        })
        .and_then(|value| normalized_absolute_path(Some(&value)));

    if let Some(index) = existing_index {
        let session = &mut registry.sessions[index];
        session.last_kmux_seen_at_unix_ms = session.last_kmux_seen_at_unix_ms.max(now_unix_ms);
        session.workspace_id = endpoint.resource_key.workspace_id.clone();
        session.kmux_session_id = kmux_session_id.clone();
        session.surface_id = endpoint.surface_id.clone();
        session.keeper_generation = endpoint.keeper_generation.clone();
        if cwd.is_some() {
            session.cwd = cwd;
        }
        if !workspace_paths.is_empty() {
            session.workspace_paths = workspace_paths;
        }
        if transcript_path.is_some() {
            session.transcript_path = transcript_path;
        }
        if artifact_directory_path.is_some() {
            session.artifact_directory_path = artifact_directory_path;
        }
        if endpoint.launch_title.is_some() {
            session.launch_title = endpoint.launch_title.clone();
        }
    } else if creates_claim {
        let Some(vendor_session_id) = vendor_session_id else {
            return Ok(());
        };
        registry.sessions.push(OwnedAgentSession {
            vendor: vendor.to_owned(),
            vendor_session_id,
            claimed_at_unix_ms: now_unix_ms,
            last_kmux_seen_at_unix_ms: now_unix_ms,
            workspace_id: endpoint.resource_key.workspace_id.clone(),
            kmux_session_id: kmux_session_id.clone(),
            surface_id: endpoint.surface_id.clone(),
            keeper_generation: endpoint.keeper_generation.clone(),
            cwd,
            workspace_paths,
            transcript_path,
            artifact_directory_path,
            history_source_path: None,
            usage_source_path: None,
            launch_title: endpoint.launch_title.clone(),
        });
    } else {
        return Ok(());
    }

    gc_owned_agent_sessions(&mut registry.sessions, now_unix_ms);
    write_owned_agent_registry(&directory, &registry)
}

fn record_owned_agent_session_event_best_effort(
    endpoint: &SessionControlEndpoint,
    request: &AdmitEventRequest,
) {
    let Ok(now_unix_ms) = unix_millis() else {
        return;
    };
    let _ = record_owned_agent_session_event(endpoint, request, now_unix_ms);
}

fn load_owned_agent_sessions_at(
    state_root: &Path,
    desktop_installation_id: &str,
    target_id: &str,
    now_unix_ms: u64,
) -> Result<Vec<OwnedAgentSession>, HookError> {
    let directory = owned_agent_registry_directory(state_root, desktop_installation_id, target_id)?;
    ensure_private_directory(&directory)?;
    let _lock = acquire_owned_agent_registry_lock(&directory)?;
    let Some(mut registry) =
        read_owned_agent_registry(&directory, desktop_installation_id, target_id)?
    else {
        return Ok(Vec::new());
    };
    let previous = registry.sessions.clone();
    gc_owned_agent_sessions(&mut registry.sessions, now_unix_ms);
    if registry.sessions != previous {
        write_owned_agent_registry(&directory, &registry)?;
    }
    registry.sessions.sort_by(|left, right| {
        right
            .last_kmux_seen_at_unix_ms
            .cmp(&left.last_kmux_seen_at_unix_ms)
            .then_with(|| left.vendor.cmp(&right.vendor))
            .then_with(|| left.vendor_session_id.cmp(&right.vendor_session_id))
    });
    Ok(registry.sessions)
}

fn gc_owned_agent_sessions(sessions: &mut Vec<OwnedAgentSession>, now_unix_ms: u64) {
    sessions.retain(|session| {
        now_unix_ms.saturating_sub(session.last_kmux_seen_at_unix_ms)
            <= OWNED_AGENT_SESSION_TTL_MILLIS
    });
    sessions.sort_by(|left, right| {
        left.last_kmux_seen_at_unix_ms
            .cmp(&right.last_kmux_seen_at_unix_ms)
            .then_with(|| left.claimed_at_unix_ms.cmp(&right.claimed_at_unix_ms))
            .then_with(|| left.vendor.cmp(&right.vendor))
            .then_with(|| left.vendor_session_id.cmp(&right.vendor_session_id))
    });
    if sessions.len() > MAX_OWNED_AGENT_SESSIONS {
        sessions.drain(..sessions.len() - MAX_OWNED_AGENT_SESSIONS);
    }
}

fn owned_agent_registry_directory(
    state_root: &Path,
    desktop_installation_id: &str,
    target_id: &str,
) -> Result<PathBuf, HookError> {
    if !state_root.is_absolute() {
        return Err(HookError::Invalid(
            "owned agent session state root must be absolute",
        ));
    }
    validate_control_id(desktop_installation_id)?;
    validate_control_id(target_id)?;
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("{desktop_installation_id}\0{target_id}").as_bytes())
    );
    Ok(state_root
        .join("agent-session-registries")
        .join(&digest[..32]))
}

fn read_owned_agent_registry(
    directory: &Path,
    desktop_installation_id: &str,
    target_id: &str,
) -> Result<Option<OwnedAgentSessionRegistry>, HookError> {
    let path = directory.join("registry.json");
    let registry: OwnedAgentSessionRegistry =
        match read_private_json(&path, MAX_OWNED_AGENT_REGISTRY_BYTES) {
            Ok(registry) => registry,
            Err(HookError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
    if registry.version != 1
        || registry.desktop_installation_id != desktop_installation_id
        || registry.target_id != target_id
    {
        return Err(HookError::Invalid(
            "owned agent session registry scope is invalid",
        ));
    }
    for session in &registry.sessions {
        validate_owned_agent_session(session)?;
    }
    Ok(Some(registry))
}

fn write_owned_agent_registry(
    directory: &Path,
    registry: &OwnedAgentSessionRegistry,
) -> Result<(), HookError> {
    let encoded = serde_json::to_vec(registry)?;
    if encoded.len() as u64 > MAX_OWNED_AGENT_REGISTRY_BYTES {
        return Err(HookError::Invalid(
            "owned agent session registry is too large",
        ));
    }
    write_bytes_atomic(&directory.join("registry.json"), &encoded)
}

fn validate_owned_agent_session(session: &OwnedAgentSession) -> Result<(), HookError> {
    validate_owned_agent_vendor(&session.vendor)?;
    for value in [
        &session.vendor_session_id,
        &session.workspace_id,
        &session.kmux_session_id,
        &session.surface_id,
        &session.keeper_generation,
    ] {
        validate_control_id(value)?;
    }
    if session.claimed_at_unix_ms == 0
        || session.last_kmux_seen_at_unix_ms < session.claimed_at_unix_ms
        || session.workspace_paths.len() > 10
    {
        return Err(HookError::Invalid(
            "owned agent session registry entry is invalid",
        ));
    }
    for path in [
        session.cwd.as_ref(),
        session.transcript_path.as_ref(),
        session.artifact_directory_path.as_ref(),
        session.history_source_path.as_ref(),
        session.usage_source_path.as_ref(),
    ]
    .into_iter()
    .flatten()
    .chain(session.workspace_paths.iter())
    {
        if normalized_absolute_path(Some(path)).as_deref() != Some(path.as_str()) {
            return Err(HookError::Invalid(
                "owned agent session registry path is invalid",
            ));
        }
    }
    Ok(())
}

fn validate_owned_agent_vendor(vendor: &str) -> Result<(), HookError> {
    if matches!(vendor, "codex" | "claude" | "antigravity") {
        Ok(())
    } else {
        Err(HookError::Invalid("owned agent session vendor is invalid"))
    }
}

fn normalized_owned_agent_vendor(agent: &str) -> Option<&'static str> {
    match agent.trim().to_ascii_lowercase().as_str() {
        "codex" => Some("codex"),
        "claude" => Some("claude"),
        "agy" | "antigravity" | "antigravity-cli" => Some("antigravity"),
        _ => None,
    }
}

fn owned_vendor_session_id(
    vendor: &str,
    payload: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    let payload = payload?;
    match vendor {
        "codex" | "claude" => json_string(payload, &["session_id", "sessionId"]),
        "antigravity" => json_string(payload, &["conversationId", "conversation_id"]),
        _ => None,
    }
}

fn json_string(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalized_absolute_path(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    (Path::new(value).is_absolute()
        && value.len() <= 32 * 1024
        && !value.contains(['\0', '\r', '\n']))
    .then(|| value.to_owned())
}

fn validate_endpoint(endpoint: &SessionControlEndpoint) -> Result<(), HookError> {
    if endpoint.version != SPOOL_VERSION
        || endpoint.resource_key.session_id.is_none()
        || !Path::new(&endpoint.state_root).is_absolute()
        || !Path::new(&endpoint.descriptor_path).is_absolute()
        || endpoint.token_sha256.len() != 64
        || !endpoint
            .token_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(HookError::Invalid("session control endpoint is invalid"));
    }
    for value in [
        &endpoint.resource_key.desktop_installation_id,
        &endpoint.resource_key.target_id,
        &endpoint.resource_key.workspace_id,
        endpoint
            .resource_key
            .session_id
            .as_ref()
            .expect("session ID was checked"),
        &endpoint.surface_id,
        &endpoint.keeper_generation,
    ] {
        validate_control_id(value)?;
    }
    for path in [endpoint.cwd.as_ref()].into_iter().flatten() {
        if normalized_absolute_path(Some(path)).as_deref() != Some(path.as_str()) {
            return Err(HookError::Invalid(
                "session control endpoint cwd is invalid",
            ));
        }
    }
    Ok(())
}

fn require_active_session_descriptor(endpoint: &SessionControlEndpoint) -> Result<(), HookError> {
    let descriptor: ActiveSessionDescriptor =
        read_private_json(Path::new(&endpoint.descriptor_path), MAX_DESCRIPTOR_BYTES)
            .map_err(|_| HookError::Unauthorized)?;
    if descriptor.version != SPOOL_VERSION
        || descriptor.state != "running"
        || descriptor.resource_key != endpoint.resource_key
        || descriptor.keeper_generation != endpoint.keeper_generation
    {
        return Err(HookError::Unauthorized);
    }
    Ok(())
}

fn validate_event_kind(kind: &str) -> Result<(), HookError> {
    match kind {
        "agent-hook" | "notification" | "osc-notification" => Ok(()),
        _ => Err(HookError::Invalid("unsupported hook event kind")),
    }
}

fn validate_control_id(value: &str) -> Result<(), HookError> {
    if value.is_empty() || value.len() > MAX_CONTROL_ID_BYTES || value.chars().any(char::is_control)
    {
        return Err(HookError::Invalid("event identity is invalid"));
    }
    Ok(())
}

fn validate_event_name(value: &str) -> Result<(), HookError> {
    if value.is_empty() || value.len() > MAX_EVENT_NAME_BYTES || value.chars().any(char::is_control)
    {
        return Err(HookError::Invalid("event name is invalid"));
    }
    Ok(())
}

fn parse_sequence(value: &str) -> Result<u64, HookError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(HookError::Invalid("event sequence is invalid"));
    }
    value
        .parse()
        .map_err(|_| HookError::Invalid("event sequence is invalid"))
}

fn event_path(spool: &Path, sequence: u64) -> PathBuf {
    spool.join(format!("event-{sequence:020}.json"))
}

fn metadata_path(spool: &Path) -> PathBuf {
    spool.join("metadata.json")
}

fn load_metadata(spool: &Path) -> Result<SpoolMetadata, HookError> {
    let path = metadata_path(spool);
    let metadata = match read_private_json(&path, MAX_METADATA_BYTES) {
        Ok(value) => value,
        Err(HookError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
            let value = SpoolMetadata::default();
            write_json_atomic(&path, &value)?;
            value
        }
        Err(error) => return Err(error),
    };
    if metadata.version != SPOOL_VERSION
        || metadata.next_sequence == 0
        || metadata.acknowledged_through >= metadata.next_sequence
        || metadata.admitted_count != metadata.next_sequence.saturating_sub(1)
        || metadata.recent_events.len() > MAX_RECENT_EVENT_IDENTITIES
    {
        return Err(HookError::Invalid("hook spool metadata is invalid"));
    }
    let mut event_ids = HashSet::new();
    let mut sequences = HashSet::new();
    let mut previous_sequence = 0_u64;
    for identity in &metadata.recent_events {
        validate_control_id(&identity.event_id)?;
        if identity.sequence == 0
            || identity.sequence >= metadata.next_sequence
            || identity.sequence <= previous_sequence
            || !event_ids.insert(identity.event_id.as_str())
            || !sequences.insert(identity.sequence)
            || !is_sha256(&identity.identity_sha256)
        {
            return Err(HookError::Invalid("hook spool event identity is invalid"));
        }
        previous_sequence = identity.sequence;
    }
    Ok(metadata)
}

fn reconcile_spool(spool: &Path) -> Result<(SpoolMetadata, Vec<StoredEvent>), HookError> {
    let mut metadata = load_metadata(spool)?;
    let original_metadata = metadata.clone();
    let events = load_event_files(spool)?;
    let mut active_events = Vec::with_capacity(events.len());
    let mut removed_acknowledged = false;
    for stored in events {
        if stored.sequence <= metadata.acknowledged_through {
            fs::remove_file(stored.path)?;
            removed_acknowledged = true;
        } else {
            active_events.push(stored);
        }
    }
    let events = active_events;
    if removed_acknowledged {
        File::open(spool)?.sync_all()?;
    }
    if events.len() > MAX_SPOOL_EVENTS {
        return Err(HookError::Invalid("hook spool event bound was exceeded"));
    }

    let mut expected = metadata
        .acknowledged_through
        .checked_add(1)
        .ok_or(HookError::Invalid("hook sequence exhausted"))?;
    for stored in &events {
        if stored.sequence != expected {
            return Err(HookError::Invalid("hook spool sequence is not contiguous"));
        }
        expected = expected
            .checked_add(1)
            .ok_or(HookError::Invalid("hook sequence exhausted"))?;
    }
    if expected < metadata.next_sequence
        || expected
            > metadata
                .next_sequence
                .checked_add(1)
                .ok_or(HookError::Invalid("hook sequence exhausted"))?
    {
        return Err(HookError::Invalid(
            "hook spool files disagree with sequence metadata",
        ));
    }

    for stored in &events {
        add_recent_event_identity(
            &mut metadata,
            RecentEventIdentity {
                event_id: stored.event.event_id.clone(),
                sequence: stored.sequence,
                identity_sha256: event_identity_sha256_from_event(&stored.event)?,
            },
        )?;
    }

    // Exactly one file at nextSequence can exist after a crash between the
    // durable event-file rename and the metadata commit. Adopt it before any
    // caller is allowed to allocate another sequence.
    if expected > metadata.next_sequence {
        metadata.next_sequence = metadata
            .next_sequence
            .checked_add(1)
            .ok_or(HookError::Invalid("hook sequence exhausted"))?;
        metadata.admitted_count = metadata
            .admitted_count
            .checked_add(1)
            .ok_or(HookError::Invalid("hook admitted count exhausted"))?;
    }

    let metadata_bytes = serde_json::to_vec(&metadata)?;
    if metadata_bytes.len() > MAX_METADATA_BYTES as usize
        || stored_event_bytes(&events)
            .checked_add(metadata_bytes.len())
            .is_none_or(|total| total > MAX_SPOOL_BYTES)
    {
        return Err(HookError::SpoolFull);
    }
    if metadata != original_metadata {
        write_json_atomic(&metadata_path(spool), &metadata)?;
    }
    Ok((metadata, events))
}

fn load_event_files(spool: &Path) -> Result<Vec<StoredEvent>, HookError> {
    let mut events = Vec::new();
    for entry in fs::read_dir(spool)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("event-") && name.ends_with(".json") {
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.uid() != effective_uid()
                || metadata.mode() & 0o077 != 0
                || metadata.len() > MAX_EVENT_FILE_BYTES
            {
                return Err(HookError::Invalid("hook event file is unsafe"));
            }
            let event: SpoolEvent = read_private_json(&entry.path(), MAX_EVENT_FILE_BYTES)?;
            let sequence = validate_spool_event(&event)?;
            if entry.path() != event_path(spool, sequence) {
                return Err(HookError::Invalid(
                    "hook event filename does not match its sequence",
                ));
            }
            events.push(StoredEvent {
                path: entry.path(),
                sequence,
                byte_length: metadata.len() as usize,
                event,
            });
        }
    }
    events.sort_by_key(|stored| stored.sequence);
    for pair in events.windows(2) {
        if pair[0].sequence == pair[1].sequence {
            return Err(HookError::Invalid("duplicate hook event sequence"));
        }
    }
    Ok(events)
}

fn cleanup_acknowledged_files(spool: &Path, through: u64) -> Result<usize, HookError> {
    let mut removed = 0;
    for stored in load_event_files(spool)? {
        if stored.sequence <= through {
            fs::remove_file(stored.path)?;
            removed += 1;
        }
    }
    if removed > 0 {
        File::open(spool)?.sync_all()?;
    }
    Ok(removed)
}

fn validate_spool_event(event: &SpoolEvent) -> Result<u64, HookError> {
    if event.version != SPOOL_VERSION || event.resource_key.session_id.is_none() {
        return Err(HookError::Invalid("spooled event is invalid"));
    }
    validate_control_id(&event.event_id)?;
    validate_event_kind(&event.kind)?;
    validate_event_name(&event.name)?;
    for value in [
        &event.resource_key.desktop_installation_id,
        &event.resource_key.target_id,
        &event.resource_key.workspace_id,
        event
            .resource_key
            .session_id
            .as_ref()
            .expect("session ID was checked"),
        &event.surface_id,
        &event.keeper_generation,
    ] {
        validate_control_id(value)?;
    }
    let sequence = parse_sequence(&event.sequence)?;
    if sequence == 0 || parse_sequence(&event.created_at_unix_ms).is_err() {
        return Err(HookError::Invalid("spooled event sequence is invalid"));
    }
    if serde_json::to_vec(&event.payload)?.len() > MAX_HOOK_PAYLOAD_BYTES {
        return Err(HookError::Invalid("spooled event payload is too large"));
    }
    Ok(sequence)
}

fn add_recent_event_identity(
    metadata: &mut SpoolMetadata,
    identity: RecentEventIdentity,
) -> Result<(), HookError> {
    if let Some(existing) = metadata
        .recent_events
        .iter()
        .find(|existing| existing.event_id == identity.event_id)
    {
        if existing == &identity {
            return Ok(());
        }
        return Err(HookError::Invalid("event ID payload changed"));
    }
    if metadata
        .recent_events
        .iter()
        .any(|existing| existing.sequence == identity.sequence)
    {
        return Err(HookError::Invalid("event sequence identity changed"));
    }
    metadata.recent_events.push(identity);
    metadata
        .recent_events
        .sort_by_key(|identity| identity.sequence);
    while metadata.recent_events.len() > MAX_RECENT_EVENT_IDENTITIES {
        if metadata
            .recent_events
            .first()
            .is_some_and(|identity| identity.sequence <= metadata.acknowledged_through)
        {
            metadata.recent_events.remove(0);
        } else {
            return Err(HookError::SpoolFull);
        }
    }
    Ok(())
}

fn event_identity_sha256_from_event(event: &SpoolEvent) -> Result<String, HookError> {
    event_identity_sha256(
        &event.kind,
        &event.name,
        &event.resource_key,
        &event.surface_id,
        &event.keeper_generation,
        &event.payload,
    )
}

fn event_identity_sha256(
    kind: &str,
    name: &str,
    resource_key: &RemoteResourceKey,
    surface_id: &str,
    keeper_generation: &str,
    payload: &Value,
) -> Result<String, HookError> {
    let identity = serde_json::to_vec(&(
        kind,
        name,
        resource_key,
        surface_id,
        keeper_generation,
        payload,
    ))?;
    Ok(format!("{:x}", Sha256::digest(identity)))
}

fn stored_event_bytes(events: &[StoredEvent]) -> usize {
    events.iter().fold(0_usize, |total, stored| {
        total.saturating_add(stored.byte_length)
    })
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn ensure_private_directory(path: &Path) -> Result<(), HookError> {
    if !path.is_absolute() {
        return Err(HookError::Invalid("hook directory must be absolute"));
    }
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(HookError::Invalid("hook directory is not private"));
    }
    Ok(())
}

fn read_private_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
    max_bytes: u64,
) -> Result<T, HookError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > max_bytes
    {
        return Err(HookError::Invalid("private JSON file is unsafe"));
    }
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(HookError::Invalid("private JSON file is too large"));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), HookError> {
    write_bytes_atomic(path, &serde_json::to_vec(value)?)
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), HookError> {
    let parent = path
        .parent()
        .ok_or(HookError::Invalid("durable hook file has no parent"))?;
    ensure_private_directory(parent)?;
    let temporary_path = parent.join(format!(".hook-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(OFlag::O_NOFOLLOW.bits())
            .open(&temporary_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary_path, path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

struct SpoolLock {
    _lock: Flock<File>,
}

struct OwnedAgentRegistryLock {
    _lock: Flock<File>,
}

fn acquire_owned_agent_registry_lock(
    directory: &Path,
) -> Result<OwnedAgentRegistryLock, HookError> {
    let path = directory.join("registry.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(OFlag::O_NOFOLLOW.bits())
        .open(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != effective_uid() || metadata.mode() & 0o077 != 0 {
        return Err(HookError::Invalid(
            "owned agent session registry lock is unsafe",
        ));
    }
    File::open(directory)?.sync_all()?;
    let deadline = Instant::now() + LOCK_TIMEOUT;
    let mut file = file;
    loop {
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => return Ok(OwnedAgentRegistryLock { _lock: lock }),
            Err((returned, Errno::EAGAIN)) => {
                file = returned;
                if Instant::now() >= deadline {
                    return Err(HookError::LockTimedOut);
                }
                thread::sleep(Duration::from_millis(5));
            }
            Err((_returned, error)) => {
                return Err(io::Error::from_raw_os_error(error as i32).into());
            }
        }
    }
}

fn acquire_spool_lock(spool: &Path) -> Result<SpoolLock, HookError> {
    let path = spool.join("spool.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(OFlag::O_NOFOLLOW.bits())
        .open(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != effective_uid() || metadata.mode() & 0o077 != 0 {
        return Err(HookError::Invalid("hook spool lock is unsafe"));
    }
    File::open(spool)?.sync_all()?;
    let deadline = Instant::now() + LOCK_TIMEOUT;
    let mut file = file;
    loop {
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => return Ok(SpoolLock { _lock: lock }),
            Err((returned, Errno::EAGAIN)) => {
                file = returned;
                if Instant::now() >= deadline {
                    return Err(HookError::LockTimedOut);
                }
                thread::sleep(Duration::from_millis(5));
            }
            Err((_returned, error)) => {
                return Err(io::Error::from_raw_os_error(error as i32).into());
            }
        }
    }
}

fn unix_millis() -> Result<u64, HookError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| HookError::Invalid("system clock is before the Unix epoch"))?
        .as_millis()
        .try_into()
        .map_err(|_| HookError::Invalid("system clock value is too large"))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use tempfile::TempDir;

    use super::*;

    fn endpoint(root: &Path) -> SessionControlEndpoint {
        SessionControlEndpoint {
            version: 1,
            resource_key: RemoteResourceKey {
                desktop_installation_id: "desktop_1".to_owned(),
                target_id: "target_1".to_owned(),
                workspace_id: "workspace_1".to_owned(),
                session_id: Some("session_1".to_owned()),
            },
            surface_id: "surface_1".to_owned(),
            keeper_generation: "keeper_1".to_owned(),
            state_root: root.join("state").to_string_lossy().into_owned(),
            descriptor_path: root
                .join("state/sessions/session.json")
                .to_string_lossy()
                .into_owned(),
            token_sha256: format!("{:x}", Sha256::digest(b"secret")),
            cwd: Some("/tmp".to_owned()),
            launch_title: None,
        }
    }

    fn event(event_id: &str) -> AdmitEventRequest {
        AdmitEventRequest {
            event_id: Some(event_id.to_owned()),
            kind: "notification".to_owned(),
            name: "agent-finished".to_owned(),
            payload: serde_json::json!({"title": "Done", "message": "ready"}),
        }
    }

    fn agent_event(name: &str, payload: Value) -> AdmitEventRequest {
        AdmitEventRequest {
            event_id: None,
            kind: "agent-hook".to_owned(),
            name: name.to_owned(),
            payload,
        }
    }

    #[test]
    fn only_start_hooks_claim_sessions_and_registries_are_scope_isolated() {
        let sandbox = TempDir::new().unwrap();
        let first = endpoint(sandbox.path());
        record_owned_agent_session_event(
            &first,
            &agent_event(
                "codex.Stop",
                serde_json::json!({"session_id": "codex-unclaimed"}),
            ),
            1_000,
        )
        .unwrap();
        assert!(
            load_owned_agent_sessions_at(
                Path::new(&first.state_root),
                "desktop_1",
                "target_1",
                1_000
            )
            .unwrap()
            .is_empty()
        );

        record_owned_agent_session_event(
            &first,
            &agent_event(
                "codex.SessionStart",
                serde_json::json!({
                    "session_id": "codex-owned",
                    "cwd": "/srv/owned",
                    "transcript_path": "/srv/owned/rollout.jsonl"
                }),
            ),
            2_000,
        )
        .unwrap();
        let owned = load_owned_agent_sessions_at(
            Path::new(&first.state_root),
            "desktop_1",
            "target_1",
            2_000,
        )
        .unwrap();
        assert_eq!(owned.len(), 1);
        assert_eq!(owned[0].vendor_session_id, "codex-owned");
        assert_eq!(owned[0].claimed_at_unix_ms, 2_000);

        let mut second = first.clone();
        second.resource_key.desktop_installation_id = "desktop_2".to_owned();
        record_owned_agent_session_event(
            &second,
            &agent_event(
                "claude.SessionStart",
                serde_json::json!({"session_id": "claude-owned"}),
            ),
            3_000,
        )
        .unwrap();
        assert_eq!(
            load_owned_agent_sessions_at(
                Path::new(&first.state_root),
                "desktop_1",
                "target_1",
                3_000
            )
            .unwrap()
            .iter()
            .map(|session| session.vendor_session_id.as_str())
            .collect::<Vec<_>>(),
            vec!["codex-owned"]
        );
        assert_eq!(
            load_owned_agent_sessions_at(
                Path::new(&first.state_root),
                "desktop_2",
                "target_1",
                3_000
            )
            .unwrap()
            .iter()
            .map(|session| session.vendor_session_id.as_str())
            .collect::<Vec<_>>(),
            vec!["claude-owned"]
        );

        let mut third = first.clone();
        third.resource_key.target_id = "target_2".to_owned();
        record_owned_agent_session_event(
            &third,
            &agent_event(
                "antigravity.PreInvocation",
                serde_json::json!({"conversationId": "antigravity-owned"}),
            ),
            4_000,
        )
        .unwrap();
        assert_eq!(
            load_owned_agent_sessions_at(
                Path::new(&first.state_root),
                "desktop_1",
                "target_1",
                4_000
            )
            .unwrap()
            .iter()
            .map(|session| session.vendor_session_id.as_str())
            .collect::<Vec<_>>(),
            vec!["codex-owned"]
        );
        assert_eq!(
            load_owned_agent_sessions_at(
                Path::new(&first.state_root),
                "desktop_1",
                "target_2",
                4_000
            )
            .unwrap()
            .iter()
            .map(|session| session.vendor_session_id.as_str())
            .collect::<Vec<_>>(),
            vec!["antigravity-owned"]
        );
    }

    #[test]
    fn owned_session_gc_expires_caps_and_reclaims_sessions() {
        let sandbox = TempDir::new().unwrap();
        let endpoint = endpoint(sandbox.path());
        record_owned_agent_session_event(
            &endpoint,
            &agent_event(
                "codex.SessionStart",
                serde_json::json!({"session_id": "codex-initial"}),
            ),
            10_000,
        )
        .unwrap();
        let template = load_owned_agent_sessions_at(
            Path::new(&endpoint.state_root),
            "desktop_1",
            "target_1",
            10_000,
        )
        .unwrap()
        .remove(0);
        let mut sessions = (0..=MAX_OWNED_AGENT_SESSIONS)
            .map(|index| OwnedAgentSession {
                vendor_session_id: format!("codex-{index:04}"),
                claimed_at_unix_ms: 10_000 + index as u64,
                last_kmux_seen_at_unix_ms: 10_000 + index as u64,
                ..template.clone()
            })
            .collect::<Vec<_>>();
        gc_owned_agent_sessions(&mut sessions, 10_000 + MAX_OWNED_AGENT_SESSIONS as u64);
        assert_eq!(sessions.len(), MAX_OWNED_AGENT_SESSIONS);
        assert!(
            sessions
                .iter()
                .all(|session| session.vendor_session_id != "codex-0000")
        );

        let expired_at = 10_000 + OWNED_AGENT_SESSION_TTL_MILLIS + 1;
        assert!(
            load_owned_agent_sessions_at(
                Path::new(&endpoint.state_root),
                "desktop_1",
                "target_1",
                expired_at
            )
            .unwrap()
            .is_empty()
        );
        record_owned_agent_session_event(
            &endpoint,
            &agent_event(
                "codex.SessionStart",
                serde_json::json!({"session_id": "codex-0500"}),
            ),
            expired_at,
        )
        .unwrap();
        let reclaimed = load_owned_agent_sessions_at(
            Path::new(&endpoint.state_root),
            "desktop_1",
            "target_1",
            expired_at,
        )
        .unwrap();
        assert_eq!(reclaimed.len(), 1);
        assert_eq!(reclaimed[0].claimed_at_unix_ms, expired_at);
    }

    #[test]
    fn followup_hooks_refresh_only_existing_claims_and_source_cache_does_not() {
        let sandbox = TempDir::new().unwrap();
        let endpoint = endpoint(sandbox.path());
        record_owned_agent_session_event(
            &endpoint,
            &agent_event(
                "antigravity.PreInvocation",
                serde_json::json!({"conversationId": "agy-owned"}),
            ),
            1_000,
        )
        .unwrap();
        record_owned_agent_session_event(
            &endpoint,
            &agent_event("antigravity.Stop", serde_json::json!({})),
            2_000,
        )
        .unwrap();
        cache_owned_agent_session_sources(
            Path::new(&endpoint.state_root),
            "desktop_1",
            "target_1",
            &[OwnedAgentSessionSourceUpdate {
                vendor: "antigravity".to_owned(),
                vendor_session_id: "agy-owned".to_owned(),
                kind: OwnedAgentSessionSourceKind::Usage,
                path: "/srv/agy/transcript.jsonl".to_owned(),
            }],
        )
        .unwrap();
        let sessions = load_owned_agent_sessions_at(
            Path::new(&endpoint.state_root),
            "desktop_1",
            "target_1",
            2_000,
        )
        .unwrap();
        assert_eq!(sessions[0].claimed_at_unix_ms, 1_000);
        assert_eq!(sessions[0].last_kmux_seen_at_unix_ms, 2_000);
        assert_eq!(
            sessions[0].usage_source_path.as_deref(),
            Some("/srv/agy/transcript.jsonl")
        );

        record_owned_agent_session_event(
            &endpoint,
            &agent_event("antigravity.Stop", serde_json::json!({})),
            1_500,
        )
        .unwrap();
        let after_clock_rollback = load_owned_agent_sessions_at(
            Path::new(&endpoint.state_root),
            "desktop_1",
            "target_1",
            1_500,
        )
        .unwrap();
        assert_eq!(after_clock_rollback[0].last_kmux_seen_at_unix_ms, 2_000);
    }

    fn write_descriptor(endpoint: &SessionControlEndpoint, state: &str, keeper_generation: &str) {
        write_json_atomic(
            Path::new(&endpoint.descriptor_path),
            &serde_json::json!({
                "version": 1,
                "resourceKey": endpoint.resource_key,
                "keeperGeneration": keeper_generation,
                "state": state,
            }),
        )
        .unwrap();
    }

    #[test]
    fn bridge_down_admission_replays_once_and_ack_reclaims_after_durable_cursor() {
        let root = TempDir::new().unwrap();
        let endpoint = endpoint(root.path());
        let first = admit_event(&endpoint, event("event_1")).unwrap();
        let duplicate = admit_event(&endpoint, event("event_1")).unwrap();
        assert_eq!(first.sequence, "1");
        assert!(!first.duplicate);
        assert_eq!(duplicate.sequence, "1");
        assert!(duplicate.duplicate);

        let page =
            replay_events(Path::new(&endpoint.state_root), "desktop_1", "target_1", 0).unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].event_id, "event_1");
        assert!(!page.has_more);

        let ack = acknowledge_events(Path::new(&endpoint.state_root), "desktop_1", "target_1", 1)
            .unwrap();
        assert_eq!(ack.acknowledged_through, "1");
        assert_eq!(ack.removed_count, 1);
        assert!(
            replay_events(Path::new(&endpoint.state_root), "desktop_1", "target_1", 0,)
                .unwrap()
                .events
                .is_empty()
        );

        let duplicate_after_ack = admit_event(&endpoint, event("event_1")).unwrap();
        assert!(duplicate_after_ack.duplicate);
        assert_eq!(duplicate_after_ack.sequence, "1");
        assert!(
            replay_events(Path::new(&endpoint.state_root), "desktop_1", "target_1", 0,)
                .unwrap()
                .events
                .is_empty()
        );

        let mut changed = event("event_1");
        changed.payload = serde_json::json!({"title": "changed"});
        assert!(matches!(
            admit_event(&endpoint, changed),
            Err(HookError::Invalid("event ID payload changed"))
        ));
    }

    #[test]
    fn event_file_written_before_metadata_is_adopted_without_sequence_reuse() {
        let root = TempDir::new().unwrap();
        let endpoint = endpoint(root.path());
        let spool =
            scoped_spool_path(Path::new(&endpoint.state_root), "desktop_1", "target_1").unwrap();
        ensure_private_directory(&spool).unwrap();
        let metadata = load_metadata(&spool).unwrap();
        assert_eq!(metadata.next_sequence, 1);

        let interrupted = SpoolEvent {
            version: 1,
            sequence: "1".to_owned(),
            event_id: "event_interrupted".to_owned(),
            kind: "notification".to_owned(),
            name: "agent-finished".to_owned(),
            resource_key: endpoint.resource_key.clone(),
            surface_id: endpoint.surface_id.clone(),
            keeper_generation: endpoint.keeper_generation.clone(),
            created_at_unix_ms: unix_millis().unwrap().to_string(),
            payload: serde_json::json!({"title": "first"}),
        };
        write_json_atomic(&event_path(&spool, 1), &interrupted).unwrap();

        let admitted = admit_event(&endpoint, event("event_2")).unwrap();
        assert_eq!(admitted.sequence, "2");
        let page =
            replay_events(Path::new(&endpoint.state_root), "desktop_1", "target_1", 0).unwrap();
        assert_eq!(
            page.events
                .iter()
                .map(|event| event.event_id.as_str())
                .collect::<Vec<_>>(),
            ["event_interrupted", "event_2"]
        );
        let ack = acknowledge_events(Path::new(&endpoint.state_root), "desktop_1", "target_1", 2)
            .unwrap();
        assert_eq!(ack.acknowledged_through, "2");
    }

    #[test]
    fn acknowledgement_metadata_survives_leftover_event_file_without_replay() {
        let root = TempDir::new().unwrap();
        let endpoint = endpoint(root.path());
        admit_event(&endpoint, event("event_1")).unwrap();
        let spool =
            scoped_spool_path(Path::new(&endpoint.state_root), "desktop_1", "target_1").unwrap();
        let original = fs::read(event_path(&spool, 1)).unwrap();
        acknowledge_events(Path::new(&endpoint.state_root), "desktop_1", "target_1", 1).unwrap();
        // Simulate a crash after the ack metadata became durable but before
        // reclamation completed.
        write_bytes_atomic(&event_path(&spool, 1), &original).unwrap();
        let page =
            replay_events(Path::new(&endpoint.state_root), "desktop_1", "target_1", 0).unwrap();
        assert!(page.events.is_empty());
        assert!(!event_path(&spool, 1).exists());
    }

    #[test]
    fn endpoint_token_and_private_file_checks_fail_closed() {
        let root = TempDir::new().unwrap();
        let endpoint = endpoint(root.path());
        let endpoint_path = root.path().join("runtime/hooks/session.json");
        write_session_control_endpoint(&endpoint_path, &endpoint).unwrap();
        assert!(authorize_session_control_endpoint(&endpoint_path, "wrong").is_err());
        assert!(authorize_session_control_endpoint(&endpoint_path, "secret").is_ok());

        let victim = root.path().join("victim.json");
        fs::write(&victim, b"preserve").unwrap();
        let symlink_path = root.path().join("runtime/hooks/symlink.json");
        symlink(&victim, &symlink_path).unwrap();
        assert!(load_session_control_endpoint(&symlink_path).is_err());
        assert_eq!(fs::read(&victim).unwrap(), b"preserve");
    }

    #[test]
    fn endpoint_admission_is_fenced_by_current_descriptor_state_and_generation() {
        let root = TempDir::new().unwrap();
        let endpoint = endpoint(root.path());
        let endpoint_path = root.path().join("runtime/hooks/session.json");
        write_session_control_endpoint(&endpoint_path, &endpoint).unwrap();
        write_descriptor(&endpoint, "running", "keeper_1");

        assert!(admit_event_from_endpoint(&endpoint_path, "secret", event("event_active")).is_ok());
        write_descriptor(&endpoint, "terminated", "keeper_1");
        assert!(matches!(
            admit_event_from_endpoint(&endpoint_path, "secret", event("event_stale_state")),
            Err(HookError::Unauthorized)
        ));
        write_descriptor(&endpoint, "running", "keeper_2");
        assert!(matches!(
            admit_event_from_endpoint(&endpoint_path, "secret", event("event_stale_generation")),
            Err(HookError::Unauthorized)
        ));
    }

    #[test]
    fn ownership_registry_failure_does_not_drop_agent_hook_events() {
        let root = TempDir::new().unwrap();
        let endpoint = endpoint(root.path());
        let endpoint_path = root.path().join("runtime/hooks/session.json");
        write_session_control_endpoint(&endpoint_path, &endpoint).unwrap();
        write_descriptor(&endpoint, "running", "keeper_1");
        let registry_directory = owned_agent_registry_directory(
            Path::new(&endpoint.state_root),
            "desktop_1",
            "target_1",
        )
        .unwrap();
        ensure_private_directory(&registry_directory).unwrap();
        let registry_path = registry_directory.join("registry.json");
        fs::write(&registry_path, b"{invalid").unwrap();
        fs::set_permissions(&registry_path, fs::Permissions::from_mode(0o600)).unwrap();

        let admission = admit_event_from_endpoint(
            &endpoint_path,
            "secret",
            agent_event(
                "claude.PermissionRequest",
                serde_json::json!({"session_id": "claude-owned"}),
            ),
        )
        .unwrap();

        assert!(admission.durable);
        let replay =
            replay_events(Path::new(&endpoint.state_root), "desktop_1", "target_1", 0).unwrap();
        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].name, "claude.PermissionRequest");
    }

    #[test]
    fn important_events_fail_bounded_instead_of_being_reported_delivered() {
        let root = TempDir::new().unwrap();
        let endpoint = endpoint(root.path());
        let oversized = AdmitEventRequest {
            event_id: Some("oversized".to_owned()),
            kind: "agent-hook".to_owned(),
            name: "stop".to_owned(),
            payload: Value::String("x".repeat(MAX_HOOK_PAYLOAD_BYTES + 1)),
        };
        assert!(matches!(
            admit_event(&endpoint, oversized),
            Err(HookError::Invalid("hook payload exceeds 64 KiB"))
        ));
        let page =
            replay_events(Path::new(&endpoint.state_root), "desktop_1", "target_1", 0).unwrap();
        assert_eq!(page.admitted_count, 0);
    }
}
