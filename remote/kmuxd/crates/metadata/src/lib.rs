#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::env;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use thiserror::Error;

pub const MAX_METADATA_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_HISTORY_RECORDS: usize = 100;
pub const MAX_USAGE_RECORDS: usize = 64;
const MAX_SESSION_DEPTH: usize = 10;
const MAX_HISTORY_DIRECTORIES: usize = 4_096;
const MAX_HISTORY_ENTRIES: usize = 65_536;
const MAX_HISTORY_EDGE_BYTES: usize = 256 * 1024;
const MAX_TITLE_CHARS: usize = 96;
const MAX_PREVIEW_CHARS: usize = 220;
const MAX_MODEL_CHARS: usize = 128;
const MAX_SESSION_ID_BYTES: usize = 4 * 1024;
const MAX_PATH_BYTES: usize = 32 * 1024;
const MAX_ANTIGRAVITY_PROMPT_PAYLOAD_BYTES: usize = 1024 * 1024;
const MAX_ANTIGRAVITY_PROMPT_FIELD_BYTES: usize = 128 * 1024;
const MAX_ANTIGRAVITY_PROMPT_PARSE_DEPTH: usize = 8;
const MAX_OWNED_CLAUDE_SUBAGENT_ENTRIES: usize = 512;

#[derive(Clone, Copy)]
struct SessionInventoryLimits {
    max_depth: usize,
    max_directories: usize,
    max_entries: usize,
}

const SESSION_INVENTORY_LIMITS: SessionInventoryLimits = SessionInventoryLimits {
    max_depth: MAX_SESSION_DEPTH,
    max_directories: MAX_HISTORY_DIRECTORIES,
    max_entries: MAX_HISTORY_ENTRIES,
};

#[derive(Debug, Error, PartialEq, Eq)]
#[error("metadata chunk exceeds {MAX_METADATA_CHUNK_BYTES} bytes")]
pub struct MetadataChunkTooLarge;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MetadataScanError {
    #[error("history scan root or bound is invalid")]
    InvalidRequest,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalHistoryRecord {
    pub vendor: &'static str,
    pub session_id: String,
    pub updated_at_unix_ms: u64,
    pub can_resume: bool,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub recent_conversation: Option<String>,
    pub model: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalHistoryScan {
    pub records: Vec<ExternalHistoryRecord>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalUsageRecord {
    pub vendor: &'static str,
    pub sample_id: String,
    pub timestamp_unix_ms: u64,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub project_path: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub thinking_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_write_tokens_known: bool,
    pub total_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalUsageScan {
    pub records: Vec<ExternalUsageRecord>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExternalAgentSettings {
    pub command: Option<String>,
    pub args: Vec<String>,
    pub additional_session_roots: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExternalAgentScanSettings {
    pub claude: Option<ExternalAgentSettings>,
    pub codex: Option<ExternalAgentSettings>,
    pub antigravity: Option<ExternalAgentSettings>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalSessionClaim {
    pub vendor: String,
    pub vendor_session_id: String,
    pub claimed_at_unix_ms: u64,
    pub last_kmux_seen_at_unix_ms: u64,
    pub cwd: Option<String>,
    pub workspace_paths: Vec<String>,
    pub transcript_path: Option<String>,
    pub artifact_directory_path: Option<String>,
    pub history_source_path: Option<String>,
    pub usage_source_path: Option<String>,
    pub launch_title: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExternalSourceCacheKind {
    History,
    Usage,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalSourceCacheUpdate {
    pub vendor: String,
    pub vendor_session_id: String,
    pub kind: ExternalSourceCacheKind,
    pub path: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct TokenMetrics {
    input_tokens: u64,
    output_tokens: u64,
    thinking_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    cache_write_tokens_known: bool,
}

impl TokenMetrics {
    fn total_tokens(self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.thinking_tokens)
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_write_tokens)
    }

    fn add_assign(&mut self, value: Self) {
        self.input_tokens = self.input_tokens.saturating_add(value.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(value.output_tokens);
        self.thinking_tokens = self.thinking_tokens.saturating_add(value.thinking_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(value.cache_read_tokens);
        self.cache_write_tokens = self
            .cache_write_tokens
            .saturating_add(value.cache_write_tokens);
        self.cache_write_tokens_known |= value.cache_write_tokens_known;
    }
}

#[derive(Clone, Debug)]
struct CandidateFile {
    path: PathBuf,
    modified_unix_ms: u64,
    size: u64,
}

struct CodexUsageCandidate {
    session_id: Option<String>,
    subagent: bool,
    record: Option<ExternalUsageRecord>,
}

struct CandidateInventory {
    candidates: Vec<CandidateFile>,
    truncated: bool,
    diagnostics: Vec<InventoryDiagnostic>,
}

impl CandidateInventory {
    fn is_partial(&self) -> bool {
        self.truncated || !self.diagnostics.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InventoryDiagnosticKind {
    MaxDepth,
    MaxDirectories,
    MaxEntries,
    RootUnavailable,
    DirectoryUnreadable,
    EntryUnreadable,
}

#[derive(Clone, Debug)]
struct InventoryDiagnostic {
    _root: PathBuf,
    _path: PathBuf,
    _kind: InventoryDiagnosticKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionVendor {
    Codex,
    Claude,
    Antigravity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionCandidateRole {
    CodexSession,
    ClaudeSession,
    ClaudeSubagent,
    AntigravityHistory,
    AntigravityTranscript,
    AntigravityConversation,
}

#[derive(Default)]
struct ParsedRecord {
    session_id: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
    first_user_title: Option<String>,
    recent_conversation: Option<String>,
    model: Option<String>,
    subagent: bool,
}

pub fn validate_metadata_chunk(bytes: &[u8]) -> Result<(), MetadataChunkTooLarge> {
    if bytes.len() > MAX_METADATA_CHUNK_BYTES {
        return Err(MetadataChunkTooLarge);
    }
    Ok(())
}

pub fn scan_owned_external_history_with_settings(
    home: &Path,
    max_records: usize,
    settings: &ExternalAgentScanSettings,
    claims: &[ExternalSessionClaim],
) -> Result<(ExternalHistoryScan, Vec<ExternalSourceCacheUpdate>), MetadataScanError> {
    if !home.is_absolute()
        || max_records == 0
        || max_records > MAX_HISTORY_RECORDS
        || claims.len() > 500
    {
        return Err(MetadataScanError::InvalidRequest);
    }
    validate_agent_scan_settings(settings)?;
    validate_external_session_claims(claims)?;

    let mut records = Vec::with_capacity(claims.len());
    let mut cache_updates = Vec::new();
    let mut truncated = false;
    for claim in claims {
        let mut parsed = ParsedRecord::default();
        let mut updated_at_unix_ms = claim.last_kmux_seen_at_unix_ms;
        let mut source_path = None;
        match claim.vendor.as_str() {
            "codex" | "claude" => {
                let roots = owned_session_roots(home, settings, &claim.vendor);
                for candidate in
                    claimed_jsonl_candidates(claim, &roots, ExternalSourceCacheKind::History)
                {
                    truncated |= candidate_uses_edge_parsing(&candidate);
                    let candidate_parsed = if claim.vendor == "codex" {
                        parse_codex_candidate(&candidate)
                    } else {
                        parse_claude_candidate(&candidate)
                    };
                    if candidate_parsed.subagent
                        || sanitize_identifier(candidate_parsed.session_id.clone()).as_deref()
                            != Some(claim.vendor_session_id.as_str())
                    {
                        continue;
                    }
                    updated_at_unix_ms = updated_at_unix_ms.max(candidate.modified_unix_ms);
                    parsed = candidate_parsed;
                    source_path = Some(candidate.path);
                    break;
                }
            }
            "antigravity" => {
                let roots = owned_session_roots(home, settings, &claim.vendor);
                if let Some(record) = antigravity_owned_history_record(claim, &roots) {
                    truncated |= record.truncated;
                    updated_at_unix_ms = updated_at_unix_ms.max(record.updated_at_unix_ms);
                    parsed.cwd = record.cwd;
                    parsed.title = record.title;
                    parsed.first_user_title = record.first_user_title;
                    parsed.recent_conversation = record.recent_conversation;
                    parsed.model = record.model;
                    source_path = record.source_path;
                }
            }
            _ => unreachable!("claims were validated"),
        }
        if let Some(path) = source_path {
            cache_updates.push(ExternalSourceCacheUpdate {
                vendor: claim.vendor.clone(),
                vendor_session_id: claim.vendor_session_id.clone(),
                kind: ExternalSourceCacheKind::History,
                path: path.to_string_lossy().into_owned(),
            });
        }
        let cwd = sanitize_absolute_path(parsed.cwd)
            .or_else(|| sanitize_absolute_path(claim.cwd.clone()))
            .or_else(|| {
                claim
                    .workspace_paths
                    .iter()
                    .find_map(|path| sanitize_absolute_path(Some(path.clone())))
            });
        let title = owned_session_title(
            &claim.vendor,
            &claim.vendor_session_id,
            parsed.title,
            parsed.first_user_title,
            claim.launch_title.clone(),
        );
        records.push(ExternalHistoryRecord {
            vendor: owned_vendor_name(&claim.vendor),
            session_id: claim.vendor_session_id.clone(),
            updated_at_unix_ms,
            // Resume runs in the remote login shell, so the daemon's PATH is not authoritative.
            can_resume: true,
            cwd,
            title: Some(title),
            recent_conversation: sanitize_text(parsed.recent_conversation, MAX_PREVIEW_CHARS),
            model: sanitize_text(parsed.model, MAX_MODEL_CHARS),
        });
    }
    records.sort_by(|left, right| {
        right
            .updated_at_unix_ms
            .cmp(&left.updated_at_unix_ms)
            .then_with(|| left.vendor.cmp(right.vendor))
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    truncated |= records.len() > max_records;
    records.truncate(max_records);
    Ok((ExternalHistoryScan { records, truncated }, cache_updates))
}

pub fn scan_owned_external_usage_with_settings(
    home: &Path,
    start_at_unix_ms: u64,
    max_records: usize,
    settings: &ExternalAgentScanSettings,
    claims: &[ExternalSessionClaim],
) -> Result<(ExternalUsageScan, Vec<ExternalSourceCacheUpdate>), MetadataScanError> {
    if !home.is_absolute()
        || max_records == 0
        || max_records > MAX_USAGE_RECORDS
        || claims.len() > 500
    {
        return Err(MetadataScanError::InvalidRequest);
    }
    validate_agent_scan_settings(settings)?;
    validate_external_session_claims(claims)?;

    let mut records = BTreeMap::<String, ExternalUsageRecord>::new();
    let mut cache_updates = Vec::new();
    let mut truncated = false;
    for claim in claims {
        let effective_start = start_at_unix_ms.max(claim.claimed_at_unix_ms);
        let roots = owned_session_roots(home, settings, &claim.vendor);
        if claim.vendor == "claude" {
            let mut selected_path = None;
            for candidate in claimed_jsonl_candidates(claim, &roots, ExternalSourceCacheKind::Usage)
                .filter(|candidate| !is_claude_subagent_path(&candidate.path))
            {
                truncated |= candidate_uses_edge_parsing(&candidate);
                let parsed = parse_claude_candidate(&candidate);
                if parsed.subagent
                    || sanitize_identifier(parsed.session_id).as_deref()
                        != Some(claim.vendor_session_id.as_str())
                {
                    continue;
                }
                selected_path = Some(candidate.path.clone());
                let mut seen_requests = BTreeSet::new();
                if let Some(record) = parse_claude_usage_for_session(
                    &candidate,
                    effective_start,
                    &mut seen_requests,
                    &claim.vendor_session_id,
                ) {
                    upsert_usage_record(&mut records, record);
                }

                let (subagents, subagents_truncated) =
                    adjacent_claude_subagent_candidates(&candidate);
                truncated |= subagents_truncated;
                for subagent in subagents {
                    truncated |= candidate_uses_edge_parsing(&subagent);
                    let Some(record) = parse_claude_usage_for_session(
                        &subagent,
                        effective_start,
                        &mut seen_requests,
                        &claim.vendor_session_id,
                    ) else {
                        continue;
                    };
                    upsert_usage_record(&mut records, record);
                }
                break;
            }
            if let Some(path) = selected_path {
                cache_updates.push(ExternalSourceCacheUpdate {
                    vendor: claim.vendor.clone(),
                    vendor_session_id: claim.vendor_session_id.clone(),
                    kind: ExternalSourceCacheKind::Usage,
                    path: path.to_string_lossy().into_owned(),
                });
            }
            continue;
        }

        let mut selected_path = None;
        let mut selected_record = None;
        for candidate in claimed_jsonl_candidates(claim, &roots, ExternalSourceCacheKind::Usage) {
            truncated |= candidate_uses_edge_parsing(&candidate);
            match claim.vendor.as_str() {
                "codex" => {
                    let parsed = parse_codex_usage_candidate(&candidate, effective_start);
                    if parsed.subagent
                        || parsed.session_id.as_deref() != Some(claim.vendor_session_id.as_str())
                    {
                        continue;
                    }
                    selected_path = Some(candidate.path);
                    selected_record = parsed.record;
                    break;
                }
                "antigravity" => {
                    let direct_source = antigravity_usage_source_matches_claim(&candidate, claim);
                    let workspaces = BTreeMap::from([(
                        claim.vendor_session_id.clone(),
                        claim
                            .cwd
                            .clone()
                            .or_else(|| claim.workspace_paths.first().cloned())
                            .unwrap_or_default(),
                    )]);
                    let record = parse_antigravity_usage_for_session(
                        &candidate,
                        effective_start,
                        &workspaces,
                        Some(&claim.vendor_session_id),
                    );
                    if !direct_source && record.is_none() {
                        continue;
                    }
                    if record.as_ref().is_some_and(|record| {
                        record.session_id.as_deref() != Some(claim.vendor_session_id.as_str())
                            || record.timestamp_unix_ms < effective_start
                    }) {
                        continue;
                    }
                    selected_path = Some(candidate.path);
                    selected_record = record;
                    break;
                }
                "claude" => unreachable!("Claude claims are handled above"),
                _ => unreachable!("claims were validated"),
            }
        }
        if let Some(path) = selected_path {
            cache_updates.push(ExternalSourceCacheUpdate {
                vendor: claim.vendor.clone(),
                vendor_session_id: claim.vendor_session_id.clone(),
                kind: ExternalSourceCacheKind::Usage,
                path: path.to_string_lossy().into_owned(),
            });
        }
        if let Some(record) = selected_record {
            upsert_usage_record(&mut records, record);
        }
    }

    let mut records = records.into_values().collect::<Vec<_>>();
    records.sort_by(|left, right| {
        right
            .timestamp_unix_ms
            .cmp(&left.timestamp_unix_ms)
            .then_with(|| left.sample_id.cmp(&right.sample_id))
    });
    truncated |= records.len() > max_records;
    records.truncate(max_records);
    Ok((ExternalUsageScan { records, truncated }, cache_updates))
}

struct OwnedAntigravityHistoryRecord {
    updated_at_unix_ms: u64,
    cwd: Option<String>,
    title: Option<String>,
    first_user_title: Option<String>,
    recent_conversation: Option<String>,
    model: Option<String>,
    source_path: Option<PathBuf>,
    truncated: bool,
}

fn antigravity_owned_history_record(
    claim: &ExternalSessionClaim,
    roots: &[PathBuf],
) -> Option<OwnedAntigravityHistoryRecord> {
    let mut result = OwnedAntigravityHistoryRecord {
        updated_at_unix_ms: claim.last_kmux_seen_at_unix_ms,
        cwd: claim.cwd.clone(),
        title: None,
        first_user_title: None,
        recent_conversation: None,
        model: None,
        source_path: None,
        truncated: false,
    };
    let mut found = false;
    let mut paths = Vec::new();
    if let Some(path) = claim.history_source_path.as_ref() {
        paths.push(PathBuf::from(path));
    }
    for root in roots {
        paths.push(root.join("history.jsonl"));
    }
    let mut seen = BTreeSet::new();
    for path in paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        let Some(candidate) = candidate_for_regular_file(&path) else {
            continue;
        };
        result.truncated |= candidate_uses_edge_parsing(&candidate);
        for value in parse_jsonl_edges(&candidate) {
            let Some(object) = value.as_object() else {
                continue;
            };
            if first_string(
                object
                    .get("conversationId")
                    .or_else(|| object.get("conversation_id")),
            )
            .as_deref()
                != Some(claim.vendor_session_id.as_str())
            {
                continue;
            }
            found = true;
            result.updated_at_unix_ms = result
                .updated_at_unix_ms
                .max(value_timestamp_unix_ms(&value).unwrap_or(candidate.modified_unix_ms));
            result.cwd = sanitize_absolute_path(first_string(
                object.get("workspace").or_else(|| object.get("cwd")),
            ))
            .or(result.cwd);
            let display = first_string(
                object
                    .get("display")
                    .or_else(|| object.get("title"))
                    .or_else(|| object.get("summary")),
            );
            result.title = sanitize_title(display.clone()).or(result.title);
            result.recent_conversation =
                sanitize_text(display, MAX_PREVIEW_CHARS).or(result.recent_conversation);
            result.model =
                sanitize_text(first_string(object.get("model")), MAX_MODEL_CHARS).or(result.model);
            result.source_path = Some(candidate.path.clone());
        }
    }

    for root in roots {
        let path = root
            .join("conversations")
            .join(format!("{}.db", claim.vendor_session_id));
        let Some(candidate) = candidate_for_regular_file(&path) else {
            continue;
        };
        let details = antigravity_conversation_details(&candidate.path);
        if details.title.is_none() && details.recent_conversation.is_none() {
            continue;
        }
        found = true;
        result.updated_at_unix_ms = result
            .updated_at_unix_ms
            .max(antigravity_database_modified_unix_ms(&candidate));
        if let Some(title) = details.title {
            result.first_user_title = Some(title.clone());
            result.title = Some(title);
        }
        result.recent_conversation = details.recent_conversation.or(result.recent_conversation);
        result.source_path = Some(candidate.path);
        break;
    }

    let transcript = claimed_jsonl_candidates(claim, roots, ExternalSourceCacheKind::History).find(
        |candidate| {
            antigravity_conversation_id(&candidate.path).as_deref()
                == Some(claim.vendor_session_id.as_str())
                || claim
                    .transcript_path
                    .as_ref()
                    .is_some_and(|path| candidate.path == Path::new(path))
        },
    );
    if let Some(candidate) = transcript {
        result.truncated |= candidate_uses_edge_parsing(&candidate);
        let parsed = parse_antigravity_transcript_history(&candidate);
        found = true;
        result.updated_at_unix_ms = result.updated_at_unix_ms.max(candidate.modified_unix_ms);
        result.first_user_title = result
            .first_user_title
            .or(parsed.first_user_title)
            .or(parsed.title);
        result.recent_conversation = parsed.recent_conversation.or(result.recent_conversation);
        result.model = parsed.model.or(result.model);
        result.source_path.get_or_insert(candidate.path);
    }
    (found || result.truncated).then_some(result)
}

struct AntigravityConversationDetails {
    title: Option<String>,
    recent_conversation: Option<String>,
}

fn antigravity_conversation_details(path: &Path) -> AntigravityConversationDetails {
    let Ok(connection) = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return AntigravityConversationDetails {
            title: None,
            recent_conversation: None,
        };
    };
    let prompt = |sql: &str| -> Option<String> {
        let maximum_payload_bytes = i64::try_from(MAX_ANTIGRAVITY_PROMPT_PAYLOAD_BYTES).ok()?;
        let mut statement = connection.prepare(sql).ok()?;
        let payload = statement
            .query_row([maximum_payload_bytes], |row| {
                row.get::<_, Option<Vec<u8>>>(0)
            })
            .ok()??;
        extract_antigravity_prompt_from_payload(&payload, 0)
    };
    AntigravityConversationDetails {
        title: prompt(
            "SELECT CASE WHEN length(step_payload) <= ?1 THEN step_payload END \
             FROM steps WHERE idx = 0 AND step_type = 14 LIMIT 1",
        )
        .and_then(|value| sanitize_title(Some(value))),
        recent_conversation: prompt(
            "SELECT CASE WHEN length(step_payload) <= ?1 THEN step_payload END \
             FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1",
        )
        .and_then(|value| sanitize_text(Some(value), MAX_PREVIEW_CHARS)),
    }
}

fn antigravity_database_modified_unix_ms(candidate: &CandidateFile) -> u64 {
    let wal_path = PathBuf::from(format!("{}-wal", candidate.path.to_string_lossy()));
    candidate_for_regular_file(&wal_path)
        .map(|wal| wal.modified_unix_ms)
        .unwrap_or(0)
        .max(candidate.modified_unix_ms)
}

fn extract_antigravity_prompt_from_payload(payload: &[u8], depth: usize) -> Option<String> {
    if payload.len() > MAX_ANTIGRAVITY_PROMPT_PAYLOAD_BYTES
        || depth > MAX_ANTIGRAVITY_PROMPT_PARSE_DEPTH
    {
        return None;
    }
    let mut offset = 0_usize;
    while offset < payload.len() {
        let (tag, next_offset) = read_protobuf_varint(payload, offset)?;
        if tag == 0 {
            break;
        }
        offset = next_offset;
        let wire_type = tag & 0x07;
        let field_number = tag >> 3;
        match wire_type {
            2 => {
                let (length, next_offset) = read_protobuf_varint(payload, offset)?;
                offset = next_offset;
                let length = usize::try_from(length).ok()?;
                let end = offset.checked_add(length)?;
                if end > payload.len() {
                    break;
                }
                if length <= MAX_ANTIGRAVITY_PROMPT_FIELD_BYTES {
                    let field = &payload[offset..end];
                    if field_number == 2
                        && let Ok(value) = std::str::from_utf8(field)
                        && printable_antigravity_prompt(value)
                    {
                        return Some(value.trim().to_owned());
                    }
                    if let Some(nested) =
                        extract_antigravity_prompt_from_payload(field, depth.saturating_add(1))
                    {
                        return Some(nested);
                    }
                }
                offset = end;
            }
            0 => {
                let (_, next_offset) = read_protobuf_varint(payload, offset)?;
                offset = next_offset;
            }
            1 => offset = offset.checked_add(8)?,
            5 => offset = offset.checked_add(4)?,
            _ => break,
        }
    }
    None
}

fn read_protobuf_varint(payload: &[u8], mut offset: usize) -> Option<(u64, usize)> {
    let mut value = 0_u64;
    for shift in (0..70).step_by(7) {
        let byte = *payload.get(offset)?;
        offset = offset.saturating_add(1);
        value |= u64::from(byte & 0x7f).checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some((value, offset));
        }
    }
    None
}

fn printable_antigravity_prompt(value: &str) -> bool {
    value.chars().count() >= 2
        && value
            .chars()
            .all(|character| !character.is_control() || character.is_whitespace())
}

fn parse_antigravity_transcript_history(candidate: &CandidateFile) -> ParsedRecord {
    let mut parsed = ParsedRecord::default();
    for value in parse_jsonl_edges(candidate) {
        let Some(object) = value.as_object() else {
            continue;
        };
        let content = extract_text(object.get("content"), 0);
        let source = object
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_uppercase();
        let record_type = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_uppercase();
        let is_user = source.contains("USER") || record_type.contains("USER");
        if is_user && parsed.title.is_none() {
            parsed.title = content.clone();
            parsed.first_user_title = content.clone();
        }
        if content.is_some() {
            parsed.recent_conversation = content.clone();
        }
        parsed.model = first_nested_string(&value, &["model", "model_name", "modelName"], 0)
            .or_else(|| content.as_deref().and_then(infer_gemini_model))
            .or(parsed.model);
    }
    parsed
}

fn claimed_jsonl_candidates<'a>(
    claim: &'a ExternalSessionClaim,
    roots: &'a [PathBuf],
    kind: ExternalSourceCacheKind,
) -> impl Iterator<Item = CandidateFile> + 'a {
    let mut paths = Vec::new();
    let cached = match kind {
        ExternalSourceCacheKind::History => claim.history_source_path.as_ref(),
        ExternalSourceCacheKind::Usage => claim.usage_source_path.as_ref(),
    };
    if let Some(path) = cached {
        paths.push(PathBuf::from(path));
    }
    if let Some(path) = claim.transcript_path.as_ref() {
        paths.push(PathBuf::from(path));
    }
    if let Some(path) = claim.artifact_directory_path.as_ref()
        && let Some(parent) = Path::new(path).parent()
    {
        paths.push(parent.join("transcript.jsonl"));
    }
    if claim.vendor == "antigravity" {
        for root in roots {
            paths.push(
                root.join("brain")
                    .join(&claim.vendor_session_id)
                    .join(".system_generated/logs/transcript.jsonl"),
            );
        }
    }
    let mut seen = BTreeSet::new();
    let direct_candidates = paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .filter_map(|path| candidate_for_regular_file(&path))
        .collect::<Vec<_>>();
    direct_candidates.into_iter().chain(
        std::iter::once_with(move || {
            bounded_claim_source_lookup(roots, claim, &seen)
                .and_then(|path| candidate_for_regular_file(&path))
        })
        .flatten(),
    )
}

fn adjacent_claude_subagent_candidates(parent: &CandidateFile) -> (Vec<CandidateFile>, bool) {
    let Some(parent_directory) = parent.path.parent() else {
        return (Vec::new(), false);
    };
    let subagent_directory = parent_directory.join("subagents");
    let Ok(directory_metadata) = fs::symlink_metadata(&subagent_directory) else {
        return (Vec::new(), false);
    };
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return (Vec::new(), false);
    }
    let Ok(entries) = fs::read_dir(subagent_directory) else {
        return (Vec::new(), true);
    };

    let mut candidates = Vec::new();
    let mut truncated = false;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_OWNED_CLAUDE_SUBAGENT_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else {
            truncated = true;
            continue;
        };
        let path = entry.path();
        if path.extension().and_then(OsStr::to_str) != Some("jsonl") {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            truncated = true;
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        if let Some(candidate) = candidate_from_metadata(path, &metadata) {
            candidates.push(candidate);
        }
    }
    candidates.sort_by(|left, right| left.path.cmp(&right.path));
    (candidates, truncated)
}

fn candidate_uses_edge_parsing(candidate: &CandidateFile) -> bool {
    candidate.size > (MAX_HISTORY_EDGE_BYTES * 2) as u64
}

fn bounded_claim_source_lookup(
    roots: &[PathBuf],
    claim: &ExternalSessionClaim,
    excluded_paths: &BTreeSet<PathBuf>,
) -> Option<PathBuf> {
    const MAX_LOOKUP_DIRECTORIES: usize = 512;
    const MAX_LOOKUP_ENTRIES: usize = 4_096;
    let mut directories = VecDeque::new();
    for root in roots {
        directories.push_back((root.clone(), 0_usize));
        if claim.vendor == "claude" {
            let direct = root.join(format!("{}.jsonl", claim.vendor_session_id));
            if !excluded_paths.contains(&direct) && direct.is_file() {
                return Some(direct);
            }
        }
    }
    let mut directory_count = directories.len();
    let mut entry_count = 0_usize;
    while let Some((directory, depth)) = directories.pop_front() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            entry_count = entry_count.saturating_add(1);
            if entry_count > MAX_LOOKUP_ENTRIES {
                return None;
            }
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if depth < MAX_SESSION_DEPTH && directory_count < MAX_LOOKUP_DIRECTORIES {
                    directory_count = directory_count.saturating_add(1);
                    directories.push_back((path, depth.saturating_add(1)));
                }
                continue;
            }
            if !metadata.is_file() || path.extension().and_then(OsStr::to_str) != Some("jsonl") {
                continue;
            }
            let name = path.file_name().and_then(OsStr::to_str).unwrap_or("");
            if name.contains(&claim.vendor_session_id) && !excluded_paths.contains(&path) {
                return Some(path);
            }
        }
    }
    None
}

fn candidate_for_regular_file(path: &Path) -> Option<CandidateFile> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    candidate_from_metadata(path.to_owned(), &metadata)
}

fn owned_session_roots(
    home: &Path,
    settings: &ExternalAgentScanSettings,
    vendor: &str,
) -> Vec<PathBuf> {
    match vendor {
        "codex" => session_roots(home, &home.join(".codex/sessions"), settings.codex.as_ref()),
        "claude" => session_roots(
            home,
            &home.join(".claude/projects"),
            settings.claude.as_ref(),
        ),
        "antigravity" => session_roots(
            home,
            &home.join(".gemini/antigravity-cli"),
            settings.antigravity.as_ref(),
        ),
        _ => Vec::new(),
    }
}

fn validate_external_session_claims(
    claims: &[ExternalSessionClaim],
) -> Result<(), MetadataScanError> {
    for claim in claims {
        if !matches!(claim.vendor.as_str(), "codex" | "claude" | "antigravity")
            || sanitize_identifier(Some(claim.vendor_session_id.clone())).as_deref()
                != Some(claim.vendor_session_id.as_str())
            || claim.claimed_at_unix_ms == 0
            || claim.last_kmux_seen_at_unix_ms < claim.claimed_at_unix_ms
            || claim.workspace_paths.len() > 10
        {
            return Err(MetadataScanError::InvalidRequest);
        }
        for path in [
            claim.cwd.as_ref(),
            claim.transcript_path.as_ref(),
            claim.artifact_directory_path.as_ref(),
            claim.history_source_path.as_ref(),
            claim.usage_source_path.as_ref(),
        ]
        .into_iter()
        .flatten()
        .chain(claim.workspace_paths.iter())
        {
            if sanitize_absolute_path(Some(path.clone())).as_deref() != Some(path.as_str()) {
                return Err(MetadataScanError::InvalidRequest);
            }
        }
    }
    Ok(())
}

fn owned_session_title(
    vendor: &str,
    vendor_session_id: &str,
    parsed_title: Option<String>,
    first_user_title: Option<String>,
    launch_title: Option<String>,
) -> String {
    [parsed_title, first_user_title, launch_title]
        .into_iter()
        .flatten()
        .filter_map(|title| sanitize_title(Some(title)))
        .find(|title| meaningful_session_title(title, vendor_session_id))
        .unwrap_or_else(|| format!("{} session", owned_vendor_display_name(vendor)))
}

fn meaningful_session_title(title: &str, vendor_session_id: &str) -> bool {
    let trimmed = title.trim();
    if trimmed.is_empty()
        || (!vendor_session_id.is_empty() && trimmed.contains(vendor_session_id))
        || trimmed.starts_with("<local-command-")
        || trimmed.starts_with("<system-reminder")
    {
        return false;
    }
    let identifier = trimmed
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() || byte == b'-' || byte == b'_');
    !(identifier && trimmed.len() >= 24)
}

fn owned_vendor_name(vendor: &str) -> &'static str {
    match vendor {
        "codex" => "codex",
        "claude" => "claude",
        "antigravity" => "antigravity",
        _ => unreachable!("vendor was validated"),
    }
}

fn owned_vendor_display_name(vendor: &str) -> &'static str {
    match vendor {
        "codex" => "Codex",
        "claude" => "Claude",
        "antigravity" => "Antigravity",
        _ => "Agent",
    }
}

pub fn scan_external_history(
    home: &Path,
    max_records: usize,
) -> Result<ExternalHistoryScan, MetadataScanError> {
    scan_external_history_with_settings(home, max_records, &ExternalAgentScanSettings::default())
}

pub fn scan_external_history_with_settings(
    home: &Path,
    max_records: usize,
    settings: &ExternalAgentScanSettings,
) -> Result<ExternalHistoryScan, MetadataScanError> {
    if !home.is_absolute() || max_records == 0 || max_records > MAX_HISTORY_RECORDS {
        return Err(MetadataScanError::InvalidRequest);
    }
    validate_agent_scan_settings(settings)?;
    let mut by_identity = BTreeMap::<String, ExternalHistoryRecord>::new();
    let mut truncated = false;
    let candidate_limit = max_records.saturating_mul(4);
    let codex_command = configured_command(settings.codex.as_ref(), "codex");
    let codex_roots = session_roots(home, &home.join(".codex/sessions"), settings.codex.as_ref());
    let inventory = collect_session_inventory(&codex_roots);
    truncated |= inventory.is_partial();
    let (candidates, parsing_truncated) = matching_candidates(
        inventory.candidates,
        &codex_roots,
        SessionVendor::Codex,
        |role| role == SessionCandidateRole::CodexSession,
        candidate_limit,
    );
    truncated |= parsing_truncated;
    scan_jsonl_vendor("codex", codex_command, candidates, &mut by_identity);
    let claude_command = configured_command(settings.claude.as_ref(), "claude");
    let claude_roots = session_roots(
        home,
        &home.join(".claude/projects"),
        settings.claude.as_ref(),
    );
    let inventory = collect_session_inventory(&claude_roots);
    truncated |= inventory.is_partial();
    let (candidates, parsing_truncated) = matching_candidates(
        inventory.candidates,
        &claude_roots,
        SessionVendor::Claude,
        |role| role == SessionCandidateRole::ClaudeSession,
        candidate_limit,
    );
    truncated |= parsing_truncated;
    scan_jsonl_vendor("claude", claude_command, candidates, &mut by_identity);
    let antigravity_command = configured_command(settings.antigravity.as_ref(), "agy");
    let antigravity_roots = session_roots(
        home,
        &home.join(".gemini/antigravity-cli"),
        settings.antigravity.as_ref(),
    );
    let inventory = collect_session_inventory(&antigravity_roots);
    truncated |= inventory.is_partial();
    let (candidates, parsing_truncated) = matching_candidates(
        inventory.candidates,
        &antigravity_roots,
        SessionVendor::Antigravity,
        |role| role == SessionCandidateRole::AntigravityHistory,
        candidate_limit,
    );
    truncated |= parsing_truncated;
    for candidate in candidates {
        truncated |= candidate.size > (MAX_HISTORY_EDGE_BYTES * 2) as u64;
        truncated |= scan_antigravity_candidate(
            &candidate,
            antigravity_command,
            max_records,
            &mut by_identity,
        );
    }

    let mut records = by_identity.into_values().collect::<Vec<_>>();
    records.sort_by(|left, right| {
        right
            .updated_at_unix_ms
            .cmp(&left.updated_at_unix_ms)
            .then_with(|| left.vendor.cmp(right.vendor))
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    if records.len() > max_records {
        records.truncate(max_records);
        truncated = true;
    }
    Ok(ExternalHistoryScan { records, truncated })
}

pub fn scan_external_usage(
    home: &Path,
    start_at_unix_ms: u64,
    max_records: usize,
) -> Result<ExternalUsageScan, MetadataScanError> {
    scan_external_usage_with_settings(
        home,
        start_at_unix_ms,
        max_records,
        &ExternalAgentScanSettings::default(),
    )
}

pub fn scan_external_usage_with_settings(
    home: &Path,
    start_at_unix_ms: u64,
    max_records: usize,
    settings: &ExternalAgentScanSettings,
) -> Result<ExternalUsageScan, MetadataScanError> {
    if !home.is_absolute() || max_records == 0 || max_records > MAX_USAGE_RECORDS {
        return Err(MetadataScanError::InvalidRequest);
    }
    validate_agent_scan_settings(settings)?;
    let mut records = BTreeMap::<String, ExternalUsageRecord>::new();
    let mut truncated = false;
    let candidate_limit = max_records.saturating_mul(8);

    let codex_roots = session_roots(home, &home.join(".codex/sessions"), settings.codex.as_ref());
    let inventory = collect_session_inventory(&codex_roots);
    truncated |= inventory.is_partial();
    let (candidates, parsing_truncated) = matching_candidates(
        inventory.candidates,
        &codex_roots,
        SessionVendor::Codex,
        |role| role == SessionCandidateRole::CodexSession,
        candidate_limit,
    );
    truncated |= parsing_truncated;
    for candidate in candidates {
        truncated |= candidate.size > (MAX_HISTORY_EDGE_BYTES * 2) as u64;
        if let Some(record) = parse_codex_usage(&candidate, start_at_unix_ms) {
            upsert_usage_record(&mut records, record);
        }
    }

    let mut seen_claude_requests = BTreeSet::new();
    let claude_roots = session_roots(
        home,
        &home.join(".claude/projects"),
        settings.claude.as_ref(),
    );
    let inventory = collect_session_inventory(&claude_roots);
    truncated |= inventory.is_partial();
    let (candidates, parsing_truncated) = matching_candidates(
        inventory.candidates,
        &claude_roots,
        SessionVendor::Claude,
        |role| {
            matches!(
                role,
                SessionCandidateRole::ClaudeSession | SessionCandidateRole::ClaudeSubagent
            )
        },
        candidate_limit,
    );
    truncated |= parsing_truncated;
    let (parent_candidates, subagent_candidates): (Vec<_>, Vec<_>) = candidates
        .into_iter()
        .partition(|candidate| !is_claude_subagent_path(&candidate.path));
    for candidate in parent_candidates.into_iter().chain(subagent_candidates) {
        truncated |= candidate.size > (MAX_HISTORY_EDGE_BYTES * 2) as u64;
        if let Some(record) =
            parse_claude_usage(&candidate, start_at_unix_ms, &mut seen_claude_requests)
        {
            upsert_usage_record(&mut records, record);
        }
    }

    let antigravity_roots = session_roots(
        home,
        &home.join(".gemini/antigravity-cli"),
        settings.antigravity.as_ref(),
    );
    let inventory = collect_session_inventory(&antigravity_roots);
    truncated |= inventory.is_partial();
    let antigravity_workspaces = inventory
        .candidates
        .iter()
        .find(|candidate| {
            classify_session_candidate_for_roots(
                &antigravity_roots,
                &candidate.path,
                SessionVendor::Antigravity,
            ) == Some(SessionCandidateRole::AntigravityHistory)
        })
        .map(antigravity_workspace_index)
        .unwrap_or_default();
    let (candidates, parsing_truncated) = matching_candidates(
        inventory.candidates,
        &antigravity_roots,
        SessionVendor::Antigravity,
        |role| role == SessionCandidateRole::AntigravityTranscript,
        candidate_limit,
    );
    truncated |= parsing_truncated;
    for candidate in candidates {
        truncated |= candidate.size > (MAX_HISTORY_EDGE_BYTES * 2) as u64;
        if let Some(record) =
            parse_antigravity_usage(&candidate, start_at_unix_ms, &antigravity_workspaces)
        {
            upsert_usage_record(&mut records, record);
        }
    }

    let mut records = records.into_values().collect::<Vec<_>>();
    records.sort_by(|left, right| {
        right
            .timestamp_unix_ms
            .cmp(&left.timestamp_unix_ms)
            .then_with(|| left.sample_id.cmp(&right.sample_id))
    });
    if records.len() > max_records {
        records.truncate(max_records);
        truncated = true;
    }
    Ok(ExternalUsageScan { records, truncated })
}

fn parse_codex_usage(
    candidate: &CandidateFile,
    start_at_unix_ms: u64,
) -> Option<ExternalUsageRecord> {
    parse_codex_usage_candidate(candidate, start_at_unix_ms).record
}

fn parse_codex_usage_candidate(
    candidate: &CandidateFile,
    start_at_unix_ms: u64,
) -> CodexUsageCandidate {
    let mut session_id = None;
    let mut cwd = None;
    let mut model = None;
    let mut subagent = false;
    let mut previous = TokenMetrics::default();
    let mut aggregate = TokenMetrics::default();
    let mut timestamp_unix_ms = 0_u64;

    for value in parse_jsonl_edges(candidate) {
        let Some(object) = value.as_object() else {
            continue;
        };
        let payload = object.get("payload").and_then(Value::as_object);
        match object.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if let Some(payload) = payload {
                    subagent |= is_codex_subagent(payload);
                    session_id = session_id.or_else(|| {
                        first_string(payload.get("id").or_else(|| payload.get("session_id")))
                    });
                    cwd = cwd.or_else(|| first_string(payload.get("cwd")));
                    model = model.or_else(|| {
                        first_string(
                            payload
                                .get("model")
                                .or_else(|| payload.get("model_name"))
                                .or_else(|| payload.get("modelName")),
                        )
                    });
                }
            }
            Some("turn_context") => {
                if let Some(payload) = payload {
                    model = first_string(
                        payload
                            .get("model")
                            .or_else(|| payload.get("model_name"))
                            .or_else(|| payload.get("modelName")),
                    )
                    .or(model);
                }
            }
            Some("event_msg") => {
                let Some(payload) = payload else {
                    continue;
                };
                if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                    continue;
                }
                let Some(total) = payload
                    .get("info")
                    .and_then(|value| value.get("total_token_usage"))
                    .and_then(Value::as_object)
                else {
                    continue;
                };
                let absolute = TokenMetrics {
                    input_tokens: object_u64(total, &["input_tokens"]),
                    output_tokens: object_u64(total, &["output_tokens"]),
                    thinking_tokens: object_u64(total, &["reasoning_output_tokens"]),
                    cache_read_tokens: object_u64(total, &["cached_input_tokens"]),
                    cache_write_tokens: 0,
                    cache_write_tokens_known: false,
                };
                let event_timestamp =
                    value_timestamp_unix_ms(&value).unwrap_or(candidate.modified_unix_ms);
                let delta = TokenMetrics {
                    input_tokens: absolute.input_tokens.saturating_sub(previous.input_tokens),
                    output_tokens: absolute
                        .output_tokens
                        .saturating_sub(previous.output_tokens),
                    thinking_tokens: absolute
                        .thinking_tokens
                        .saturating_sub(previous.thinking_tokens),
                    cache_read_tokens: absolute
                        .cache_read_tokens
                        .saturating_sub(previous.cache_read_tokens),
                    cache_write_tokens: 0,
                    cache_write_tokens_known: false,
                };
                previous = absolute;
                if event_timestamp < start_at_unix_ms {
                    continue;
                }
                aggregate.add_assign(TokenMetrics {
                    input_tokens: delta.input_tokens.saturating_sub(delta.cache_read_tokens),
                    output_tokens: delta.output_tokens.saturating_sub(delta.thinking_tokens),
                    ..delta
                });
                timestamp_unix_ms = timestamp_unix_ms.max(event_timestamp);
            }
            _ => {}
        }
    }
    let explicit_session_id = sanitize_identifier(session_id.clone());
    let record = (|| {
        if subagent || aggregate.total_tokens() == 0 {
            return None;
        }
        let fallback_id = candidate.path.file_stem()?.to_str()?.to_owned();
        let session_id = sanitize_identifier(session_id.or(Some(fallback_id)))?;
        let cwd = sanitize_absolute_path(cwd);
        Some(usage_record(
            "codex",
            format!("codex:{session_id}"),
            timestamp_unix_ms,
            Some(session_id),
            sanitize_text(model, MAX_MODEL_CHARS),
            cwd.clone(),
            cwd,
            aggregate,
        ))
    })();
    CodexUsageCandidate {
        session_id: explicit_session_id,
        subagent,
        record,
    }
}

fn parse_claude_usage(
    candidate: &CandidateFile,
    start_at_unix_ms: u64,
    seen_requests: &mut BTreeSet<String>,
) -> Option<ExternalUsageRecord> {
    parse_claude_usage_with_expected_session(candidate, start_at_unix_ms, seen_requests, None)
}

fn parse_claude_usage_for_session(
    candidate: &CandidateFile,
    start_at_unix_ms: u64,
    seen_requests: &mut BTreeSet<String>,
    expected_session_id: &str,
) -> Option<ExternalUsageRecord> {
    parse_claude_usage_with_expected_session(
        candidate,
        start_at_unix_ms,
        seen_requests,
        Some(expected_session_id),
    )
}

fn parse_claude_usage_with_expected_session(
    candidate: &CandidateFile,
    start_at_unix_ms: u64,
    seen_requests: &mut BTreeSet<String>,
    expected_session_id: Option<&str>,
) -> Option<ExternalUsageRecord> {
    let mut session_id = None;
    let mut cwd = None;
    let mut model = None;
    let mut aggregate = TokenMetrics::default();
    let mut timestamp_unix_ms = 0_u64;
    for value in parse_jsonl_edges(candidate) {
        let Some(object) = value.as_object() else {
            continue;
        };
        if is_claude_non_usage_record(object) {
            continue;
        }
        let record_session_id = first_string(
            object
                .get("sessionId")
                .or_else(|| object.get("session_id"))
                .or_else(|| object.get("conversationId")),
        );
        if expected_session_id
            .is_some_and(|expected| record_session_id.as_deref() != Some(expected))
        {
            continue;
        }
        let event_timestamp = value_timestamp_unix_ms(&value).unwrap_or(candidate.modified_unix_ms);
        if event_timestamp < start_at_unix_ms {
            continue;
        }
        let metrics_root = if object.get("type").and_then(Value::as_str) == Some("assistant") {
            object
                .get("message")
                .and_then(Value::as_object)
                .and_then(|message| message.get("usage"))?
        } else {
            &value
        };
        let Some(metrics) = best_usage_metrics(metrics_root, 0) else {
            continue;
        };
        if let Some(identity) = claude_canonical_usage_identity(object)
            && !seen_requests.insert(identity)
        {
            continue;
        }
        aggregate.add_assign(metrics);
        timestamp_unix_ms = timestamp_unix_ms.max(event_timestamp);
        session_id = session_id.or(record_session_id);
        cwd = cwd.or_else(|| {
            first_string(
                object
                    .get("cwd")
                    .or_else(|| object.get("projectRoot"))
                    .or_else(|| object.get("project_path")),
            )
        });
        model = first_nested_string(&value, &["model", "model_name", "modelName"], 0).or(model);
    }
    if aggregate.total_tokens() == 0 {
        return None;
    }
    let fallback_id = candidate.path.file_stem()?.to_str()?.to_owned();
    let session_id = sanitize_identifier(session_id.or(Some(fallback_id)))?;
    let cwd = sanitize_absolute_path(cwd);
    Some(usage_record(
        "claude",
        format!("claude:{session_id}"),
        timestamp_unix_ms,
        Some(session_id),
        sanitize_text(model, MAX_MODEL_CHARS),
        cwd.clone(),
        cwd,
        aggregate,
    ))
}

fn is_claude_subagent_path(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == OsStr::new("subagents"))
}

fn is_claude_non_usage_record(object: &serde_json::Map<String, Value>) -> bool {
    let record_type = object.get("type").and_then(Value::as_str);
    if record_type == Some("assistant") {
        return object
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| message.get("usage"))
            .is_none();
    }
    let has_claude_marker = ["uuid", "parentUuid", "userType", "isSidechain", "agentId"]
        .iter()
        .any(|key| object.contains_key(*key));
    has_claude_marker
        && matches!(
            record_type,
            Some(
                "user"
                    | "attachment"
                    | "system"
                    | "mode"
                    | "permission-mode"
                    | "file-history-snapshot"
                    | "ai-title"
                    | "last-prompt"
                    | "queue-operation"
                    | "pr-link"
                    | "agent-name"
            )
        )
}

fn claude_canonical_usage_identity(object: &serde_json::Map<String, Value>) -> Option<String> {
    let request_id = first_string(object.get("request_id").or_else(|| object.get("requestId")))?;
    let thread_id = first_string(
        object
            .get("thread_id")
            .or_else(|| object.get("threadId"))
            .or_else(|| object.get("conversation_id"))
            .or_else(|| object.get("conversationId"))
            .or_else(|| object.get("id")),
    )
    .or_else(|| {
        object
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| first_string(message.get("id")))
    })?;
    let request_id = sanitize_identifier(Some(request_id))?;
    let thread_id = sanitize_identifier(Some(thread_id))?;
    Some(format!("{thread_id}\0{request_id}"))
}

fn parse_antigravity_usage(
    candidate: &CandidateFile,
    start_at_unix_ms: u64,
    workspaces: &BTreeMap<String, String>,
) -> Option<ExternalUsageRecord> {
    parse_antigravity_usage_for_session(candidate, start_at_unix_ms, workspaces, None)
}

fn parse_antigravity_usage_for_session(
    candidate: &CandidateFile,
    start_at_unix_ms: u64,
    workspaces: &BTreeMap<String, String>,
    claimed_session_id: Option<&str>,
) -> Option<ExternalUsageRecord> {
    let session_id = claimed_session_id
        .map(ToOwned::to_owned)
        .or_else(|| antigravity_conversation_id(&candidate.path))?;
    let mut aggregate = TokenMetrics::default();
    let mut timestamp_unix_ms = 0_u64;
    let mut model = None;
    for value in parse_jsonl_edges(candidate) {
        let Some(object) = value.as_object() else {
            continue;
        };
        let event_timestamp = value_timestamp_unix_ms(&value).unwrap_or(candidate.modified_unix_ms);
        if event_timestamp < start_at_unix_ms {
            continue;
        }
        if let Some(mut metrics) = best_usage_metrics(&value, 0) {
            metrics.input_tokens = metrics
                .input_tokens
                .saturating_sub(metrics.cache_read_tokens)
                .saturating_sub(metrics.cache_write_tokens);
            aggregate.add_assign(metrics);
            timestamp_unix_ms = timestamp_unix_ms.max(event_timestamp);
            model = first_nested_string(&value, &["model", "model_name", "modelName"], 0).or(model);
            continue;
        }
        let content = stringify_antigravity_transcript_value(object.get("content"));
        let tool_calls = stringify_antigravity_transcript_value(object.get("tool_calls"));
        if content.is_empty() && tool_calls.is_empty() {
            continue;
        }
        let source = object
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_uppercase();
        let record_type = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_uppercase();
        let model_response =
            source == "MODEL" && (record_type.ends_with("_RESPONSE") || !tool_calls.is_empty());
        let text = if model_response {
            [content.as_str(), tool_calls.as_str()]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            content.clone()
        };
        let tokens =
            u64::try_from(text.trim().chars().count().saturating_add(3) / 4).unwrap_or(u64::MAX);
        if tokens == 0 {
            continue;
        }
        if model_response {
            aggregate.output_tokens = aggregate.output_tokens.saturating_add(tokens);
        } else {
            aggregate.input_tokens = aggregate.input_tokens.saturating_add(tokens);
        }
        timestamp_unix_ms = timestamp_unix_ms.max(event_timestamp);
        model = first_nested_string(&value, &["model", "model_name", "modelName"], 0)
            .or_else(|| infer_gemini_model(&content))
            .or(model);
    }
    if aggregate.total_tokens() == 0 {
        return None;
    }
    let cwd = workspaces
        .get(&session_id)
        .cloned()
        .and_then(|value| sanitize_absolute_path(Some(value)));
    Some(usage_record(
        "antigravity",
        format!("antigravity:{session_id}"),
        timestamp_unix_ms,
        Some(session_id),
        sanitize_text(model, MAX_MODEL_CHARS),
        cwd.clone(),
        cwd,
        aggregate,
    ))
}

fn stringify_antigravity_transcript_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Null) | None => String::new(),
        Some(value) => serde_json::to_string(value).unwrap_or_default(),
    }
}

#[allow(clippy::too_many_arguments)]
fn usage_record(
    vendor: &'static str,
    sample_id: String,
    timestamp_unix_ms: u64,
    session_id: Option<String>,
    model: Option<String>,
    cwd: Option<String>,
    project_path: Option<String>,
    metrics: TokenMetrics,
) -> ExternalUsageRecord {
    ExternalUsageRecord {
        vendor,
        sample_id,
        timestamp_unix_ms,
        session_id,
        model,
        cwd,
        project_path,
        input_tokens: metrics.input_tokens,
        output_tokens: metrics.output_tokens,
        thinking_tokens: metrics.thinking_tokens,
        cache_read_tokens: metrics.cache_read_tokens,
        cache_write_tokens: metrics.cache_write_tokens,
        cache_write_tokens_known: metrics.cache_write_tokens_known,
        total_tokens: metrics.total_tokens(),
    }
}

fn scan_jsonl_vendor(
    vendor: &'static str,
    command: &str,
    candidates: Vec<CandidateFile>,
    records: &mut BTreeMap<String, ExternalHistoryRecord>,
) {
    for candidate in candidates {
        let parsed = if vendor == "codex" {
            parse_codex_candidate(&candidate)
        } else {
            parse_claude_candidate(&candidate)
        };
        if parsed.subagent {
            continue;
        }
        let Some(session_id) = sanitize_identifier(parsed.session_id) else {
            continue;
        };
        upsert_record(
            records,
            ExternalHistoryRecord {
                vendor,
                session_id,
                updated_at_unix_ms: candidate.modified_unix_ms,
                can_resume: command_available(command),
                cwd: sanitize_absolute_path(parsed.cwd),
                title: sanitize_title(parsed.title),
                recent_conversation: sanitize_text(parsed.recent_conversation, MAX_PREVIEW_CHARS),
                model: sanitize_text(parsed.model, MAX_MODEL_CHARS),
            },
        );
    }
}

fn scan_antigravity_candidate(
    candidate: &CandidateFile,
    command: &str,
    max_records: usize,
    records: &mut BTreeMap<String, ExternalHistoryRecord>,
) -> bool {
    let mut antigravity_records = records
        .values()
        .filter(|record| record.vendor == "antigravity")
        .count();
    for value in parse_jsonl_edges(candidate) {
        let Some(object) = value.as_object() else {
            continue;
        };
        let Some(session_id) = sanitize_identifier(first_string(
            object
                .get("conversationId")
                .or_else(|| object.get("conversation_id")),
        )) else {
            continue;
        };
        let identity = format!("antigravity:{session_id}");
        let is_new_identity = !records.contains_key(&identity);
        if is_new_identity && antigravity_records >= max_records {
            return true;
        }
        upsert_record(
            records,
            ExternalHistoryRecord {
                vendor: "antigravity",
                session_id,
                updated_at_unix_ms: candidate.modified_unix_ms,
                can_resume: command_available(command),
                cwd: sanitize_absolute_path(first_string(
                    object.get("workspace").or_else(|| object.get("cwd")),
                )),
                title: sanitize_title(first_string(
                    object.get("title").or_else(|| object.get("summary")),
                )),
                recent_conversation: sanitize_text(
                    first_string(
                        object
                            .get("recentConversation")
                            .or_else(|| object.get("prompt")),
                    ),
                    MAX_PREVIEW_CHARS,
                ),
                model: sanitize_text(first_string(object.get("model")), MAX_MODEL_CHARS),
            },
        );
        antigravity_records += usize::from(is_new_identity);
    }
    false
}

fn parse_codex_candidate(candidate: &CandidateFile) -> ParsedRecord {
    let mut parsed = ParsedRecord::default();
    for value in parse_jsonl_edges(candidate) {
        let Some(object) = value.as_object() else {
            continue;
        };
        let payload = object.get("payload").and_then(Value::as_object);
        if object.get("type").and_then(Value::as_str) == Some("session_meta")
            && let Some(payload) = payload
        {
            parsed.subagent |= is_codex_subagent(payload);
            parsed.session_id = parsed
                .session_id
                .take()
                .or_else(|| first_string(payload.get("id").or_else(|| payload.get("session_id"))));
            parsed.cwd = parsed
                .cwd
                .take()
                .or_else(|| first_string(payload.get("cwd")));
        }
        if payload
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            == Some("thread_name_updated")
        {
            parsed.title = payload.and_then(|value| {
                first_string(
                    value
                        .get("thread_name")
                        .or_else(|| value.get("threadName"))
                        .or_else(|| value.get("name")),
                )
            });
        }
        if let Some(payload) = payload {
            if matches!(
                payload.get("type").and_then(Value::as_str),
                Some("user_message" | "agent_message")
            ) {
                parsed.recent_conversation =
                    extract_text(payload.get("message"), 0).and_then(clean_codex_prompt_text);
                if parsed.title.is_none()
                    && payload.get("type").and_then(Value::as_str) == Some("user_message")
                {
                    parsed.title = parsed.recent_conversation.clone();
                }
                if parsed.first_user_title.is_none()
                    && payload.get("type").and_then(Value::as_str) == Some("user_message")
                {
                    parsed.first_user_title = parsed.recent_conversation.clone();
                }
            }
            parsed.model = parsed.model.take().or_else(|| {
                first_string(
                    payload
                        .get("model")
                        .or_else(|| payload.get("model_name"))
                        .or_else(|| payload.get("modelName")),
                )
            });
        }
        if object.get("type").and_then(Value::as_str) == Some("response_item")
            && payload
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str)
                == Some("message")
            && payload
                .and_then(|payload| payload.get("role"))
                .and_then(Value::as_str)
                == Some("user")
        {
            let prompt = payload
                .and_then(|payload| extract_text(payload.get("content"), 0))
                .and_then(clean_codex_prompt_text);
            if prompt.is_some() {
                parsed.recent_conversation = prompt.clone();
                if parsed.title.is_none() {
                    parsed.title = prompt.clone();
                }
                if parsed.first_user_title.is_none() {
                    parsed.first_user_title = prompt;
                }
            }
        }
    }
    parsed
}

fn parse_claude_candidate(candidate: &CandidateFile) -> ParsedRecord {
    let mut parsed = ParsedRecord::default();
    for value in parse_jsonl_edges(candidate) {
        let Some(object) = value.as_object() else {
            continue;
        };
        parsed.session_id = parsed.session_id.take().or_else(|| {
            first_string(
                object
                    .get("sessionId")
                    .or_else(|| object.get("session_id"))
                    .or_else(|| object.get("id")),
            )
        });
        parsed.cwd = parsed
            .cwd
            .take()
            .or_else(|| first_string(object.get("cwd").or_else(|| object.get("projectRoot"))));
        let role = object
            .get("type")
            .or_else(|| object.get("role"))
            .and_then(Value::as_str);
        if !matches!(role, Some("user" | "human" | "assistant")) {
            parsed.title = sanitize_title(first_string(
                object
                    .get("customTitle")
                    .or_else(|| object.get("custom_title"))
                    .or_else(|| object.get("summary"))
                    .or_else(|| object.get("title")),
            ))
            .or(parsed.title);
        }
        if matches!(role, Some("user" | "human" | "assistant")) {
            let text = if matches!(role, Some("user" | "human"))
                && object.get("isMeta").and_then(Value::as_bool) == Some(true)
            {
                None
            } else {
                extract_text(
                    object
                        .get("message")
                        .and_then(|value| value.get("content"))
                        .or_else(|| object.get("content"))
                        .or_else(|| object.get("message")),
                    0,
                )
                .and_then(clean_claude_prompt_text)
            };
            if text.is_some() {
                parsed.recent_conversation = text.clone();
                if parsed.title.is_none() && matches!(role, Some("user" | "human")) {
                    parsed.title = text.clone();
                }
                if parsed.first_user_title.is_none() && matches!(role, Some("user" | "human")) {
                    parsed.first_user_title = text;
                }
            }
        }
        if role == Some("assistant") {
            parsed.model = parsed.model.take().or_else(|| {
                object
                    .get("message")
                    .and_then(|value| value.get("model"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .or_else(|| first_string(object.get("model")))
            });
        }
    }
    if parsed.session_id.is_none() {
        parsed.session_id = candidate
            .path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(ToOwned::to_owned);
    }
    parsed
}

fn clean_codex_prompt_text(value: String) -> Option<String> {
    let mut cleaned = value;
    for tag in [
        "permissions instructions",
        "environment_context",
        "turn_aborted",
        "skill",
        "local-command-caveat",
    ] {
        cleaned = remove_tagged_blocks(cleaned, tag, false);
    }
    cleaned = remove_tagged_blocks(cleaned, "recommended_plugins", true);
    let trimmed = cleaned.trim();
    if is_codex_injected_instructions_text(trimmed) {
        return None;
    }
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn clean_claude_prompt_text(value: String) -> Option<String> {
    let mut cleaned = value;
    for tag in [
        "local-command-caveat",
        "local-command-stdout",
        "local-command-stderr",
        "command-message",
        "command-name",
        "command-args",
        "ide_opened_file",
        "system-reminder",
        "system_reminder",
    ] {
        cleaned = remove_tagged_blocks(cleaned, tag, false);
    }
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn is_codex_injected_instructions_text(value: &str) -> bool {
    let normalized = value.trim().replace("\r\n", "\n");
    let lowercase = normalized.to_ascii_lowercase();
    lowercase.starts_with("# ")
        && lowercase
            .lines()
            .next()
            .is_some_and(|line| line.contains(" instructions for "))
        && lowercase.contains("\n\n<instructions>")
        && lowercase.ends_with("</instructions>")
}

fn remove_tagged_blocks(mut value: String, tag: &str, allow_attributes: bool) -> String {
    let exact_open = format!("<{tag}>");
    let open_prefix = format!("<{tag}");
    let close = format!("</{tag}>");
    loop {
        let lowercase = value.to_ascii_lowercase();
        let opening = if allow_attributes {
            lowercase
                .match_indices(&open_prefix)
                .find_map(|(start, _)| {
                    let suffix = &lowercase[start + open_prefix.len()..];
                    let boundary = suffix.as_bytes().first().copied()?;
                    if boundary != b'>' && !boundary.is_ascii_whitespace() {
                        return None;
                    }
                    let relative_end = suffix.find('>')?;
                    Some((start, start + open_prefix.len() + relative_end + 1))
                })
        } else {
            lowercase
                .find(&exact_open)
                .map(|start| (start, start + exact_open.len()))
        };
        let Some((start, content_start)) = opening else {
            break;
        };
        let Some(relative_end) = lowercase[content_start..].find(&close) else {
            break;
        };
        let end = content_start + relative_end + close.len();
        value.replace_range(start..end, "\n");
    }
    value
}

fn is_codex_subagent(object: &serde_json::Map<String, Value>) -> bool {
    object.get("thread_source").and_then(Value::as_str) == Some("subagent")
        || object
            .get("source")
            .and_then(|value| value.get("subagent"))
            .is_some()
        || object
            .get("metadata")
            .and_then(|value| value.get("thread_source"))
            .and_then(Value::as_str)
            == Some("subagent")
}

fn extract_text(value: Option<&Value>, depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    match value? {
        Value::String(value) => Some(value.to_owned()),
        Value::Array(values) => {
            let joined = values
                .iter()
                .filter_map(|value| extract_text(Some(value), depth + 1))
                .collect::<Vec<_>>()
                .join(" ");
            (!joined.is_empty()).then_some(joined)
        }
        Value::Object(object) => {
            if matches!(
                object.get("type").and_then(Value::as_str),
                Some("tool_result" | "tool_use")
            ) {
                return None;
            }
            extract_text(
                object
                    .get("text")
                    .or_else(|| object.get("content"))
                    .or_else(|| object.get("message")),
                depth + 1,
            )
        }
        _ => None,
    }
}

fn collect_session_inventory(roots: &[PathBuf]) -> CandidateInventory {
    collect_session_inventory_with_limits(roots, SESSION_INVENTORY_LIMITS)
}

fn collect_session_inventory_with_limits(
    roots: &[PathBuf],
    limits: SessionInventoryLimits,
) -> CandidateInventory {
    let mut candidates_by_path = BTreeMap::new();
    let mut diagnostics = Vec::new();
    let mut seen_paths = BTreeSet::new();
    let mut seen_identities = BTreeSet::new();
    let mut truncated = false;

    for configured_root in roots {
        let canonical = match fs::canonicalize(configured_root) {
            Ok(canonical) => canonical,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                continue;
            }
            Err(_) => {
                diagnostics.push(InventoryDiagnostic {
                    _root: configured_root.clone(),
                    _path: configured_root.clone(),
                    _kind: InventoryDiagnosticKind::RootUnavailable,
                });
                truncated = true;
                continue;
            }
        };
        let metadata = match fs::metadata(&canonical) {
            Ok(metadata) if metadata.is_dir() => metadata,
            Ok(_) => continue,
            Err(_) => {
                diagnostics.push(InventoryDiagnostic {
                    _root: configured_root.clone(),
                    _path: canonical,
                    _kind: InventoryDiagnosticKind::RootUnavailable,
                });
                truncated = true;
                continue;
            }
        };
        if !seen_paths.insert(canonical.clone())
            || !seen_identities.insert((metadata.dev(), metadata.ino()))
        {
            continue;
        }
        let inventory = collect_session_inventory_root(&canonical, limits);
        truncated |= inventory.is_partial();
        diagnostics.extend(inventory.diagnostics);
        for candidate in inventory.candidates {
            candidates_by_path
                .entry(candidate.path.clone())
                .or_insert(candidate);
        }
    }
    let mut candidates = candidates_by_path.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .modified_unix_ms
            .cmp(&left.modified_unix_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    CandidateInventory {
        candidates,
        truncated,
        diagnostics,
    }
}

fn collect_session_inventory_root(
    root: &Path,
    limits: SessionInventoryLimits,
) -> CandidateInventory {
    let root_metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(_) => {
            return CandidateInventory {
                candidates: Vec::new(),
                truncated: true,
                diagnostics: vec![InventoryDiagnostic {
                    _root: root.to_owned(),
                    _path: root.to_owned(),
                    _kind: InventoryDiagnosticKind::RootUnavailable,
                }],
            };
        }
    };
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return CandidateInventory {
            candidates: Vec::new(),
            truncated: false,
            diagnostics: Vec::new(),
        };
    }
    let mut directories = VecDeque::from([(root.to_owned(), 0_usize)]);
    let mut discovered_directories = 1_usize;
    let mut visited_entries = 0_usize;
    let mut candidates = Vec::new();
    let mut diagnostics = Vec::new();
    let mut truncated = false;

    'inventory: while let Some((directory, depth)) = directories.pop_front() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                diagnostics.push(InventoryDiagnostic {
                    _root: root.to_owned(),
                    _path: directory,
                    _kind: InventoryDiagnosticKind::DirectoryUnreadable,
                });
                truncated = true;
                continue;
            }
        };
        for entry_result in entries {
            let entry = match entry_result {
                Ok(entry) => entry,
                Err(_) => {
                    diagnostics.push(InventoryDiagnostic {
                        _root: root.to_owned(),
                        _path: directory.clone(),
                        _kind: InventoryDiagnosticKind::EntryUnreadable,
                    });
                    truncated = true;
                    continue;
                }
            };
            visited_entries = visited_entries.saturating_add(1);
            if visited_entries > limits.max_entries {
                diagnostics.push(InventoryDiagnostic {
                    _root: root.to_owned(),
                    _path: directory.clone(),
                    _kind: InventoryDiagnosticKind::MaxEntries,
                });
                truncated = true;
                break 'inventory;
            }
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    diagnostics.push(InventoryDiagnostic {
                        _root: root.to_owned(),
                        _path: path,
                        _kind: InventoryDiagnosticKind::EntryUnreadable,
                    });
                    truncated = true;
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if depth >= limits.max_depth {
                    diagnostics.push(InventoryDiagnostic {
                        _root: root.to_owned(),
                        _path: path,
                        _kind: InventoryDiagnosticKind::MaxDepth,
                    });
                    truncated = true;
                    continue;
                }
                if discovered_directories >= limits.max_directories {
                    diagnostics.push(InventoryDiagnostic {
                        _root: root.to_owned(),
                        _path: path,
                        _kind: InventoryDiagnosticKind::MaxDirectories,
                    });
                    truncated = true;
                    continue;
                }
                discovered_directories = discovered_directories.saturating_add(1);
                directories.push_back((path, depth.saturating_add(1)));
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let Some(candidate) = candidate_from_metadata(path.clone(), &metadata) else {
                diagnostics.push(InventoryDiagnostic {
                    _root: root.to_owned(),
                    _path: path,
                    _kind: InventoryDiagnosticKind::EntryUnreadable,
                });
                truncated = true;
                continue;
            };
            candidates.push(candidate);
        }
    }
    candidates.sort_by(|left, right| {
        right
            .modified_unix_ms
            .cmp(&left.modified_unix_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    CandidateInventory {
        candidates,
        truncated,
        diagnostics,
    }
}

fn matching_candidates(
    candidates: Vec<CandidateFile>,
    roots: &[PathBuf],
    vendor: SessionVendor,
    include: impl Fn(SessionCandidateRole) -> bool,
    parsing_budget: usize,
) -> (Vec<CandidateFile>, bool) {
    let mut matching = candidates
        .into_iter()
        .filter(|candidate| {
            classify_session_candidate_for_roots(roots, &candidate.path, vendor)
                .is_some_and(&include)
        })
        .collect::<Vec<_>>();
    let truncated = matching.len() > parsing_budget;
    if truncated {
        matching.truncate(parsing_budget);
    }
    (matching, truncated)
}

fn classify_session_candidate_for_roots(
    roots: &[PathBuf],
    path: &Path,
    vendor: SessionVendor,
) -> Option<SessionCandidateRole> {
    roots
        .iter()
        .find_map(|root| classify_session_candidate(root, path, vendor))
}

fn classify_session_candidate(
    root: &Path,
    path: &Path,
    vendor: SessionVendor,
) -> Option<SessionCandidateRole> {
    let relative = path.strip_prefix(root).ok()?;
    let components = relative.iter().collect::<Vec<_>>();
    let file_name = path.file_name().and_then(OsStr::to_str)?;

    match vendor {
        SessionVendor::Codex => file_name
            .ends_with(".jsonl")
            .then_some(SessionCandidateRole::CodexSession),
        SessionVendor::Claude => {
            if path.extension().and_then(OsStr::to_str) != Some("jsonl") {
                return None;
            }
            if components
                .iter()
                .take(components.len().saturating_sub(1))
                .any(|component| *component == OsStr::new("subagents"))
            {
                Some(SessionCandidateRole::ClaudeSubagent)
            } else {
                Some(SessionCandidateRole::ClaudeSession)
            }
        }
        SessionVendor::Antigravity => {
            if components.as_slice() == [OsStr::new("history.jsonl")] {
                return Some(SessionCandidateRole::AntigravityHistory);
            }
            if components.len() >= 4
                && components[components.len() - 3] == OsStr::new(".system_generated")
                && components[components.len() - 2] == OsStr::new("logs")
                && components[components.len() - 1] == OsStr::new("transcript.jsonl")
            {
                return Some(SessionCandidateRole::AntigravityTranscript);
            }
            (components.len() == 2
                && components[0] == OsStr::new("conversations")
                && path.extension().and_then(OsStr::to_str) == Some("db"))
            .then_some(SessionCandidateRole::AntigravityConversation)
        }
    }
}

fn candidate_from_metadata(path: PathBuf, metadata: &fs::Metadata) -> Option<CandidateFile> {
    let modified_unix_ms = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()?;
    Some(CandidateFile {
        path,
        modified_unix_ms,
        size: metadata.len(),
    })
}

fn parse_jsonl_edges(candidate: &CandidateFile) -> Vec<Value> {
    let Ok(mut file) = File::open(&candidate.path) else {
        return Vec::new();
    };
    let prefix_length = candidate.size.min(MAX_HISTORY_EDGE_BYTES as u64) as usize;
    let mut prefix = vec![0_u8; prefix_length];
    if file.read_exact(&mut prefix).is_err() {
        return Vec::new();
    }
    let bytes = if candidate.size <= (MAX_HISTORY_EDGE_BYTES * 2) as u64 {
        prefix
    } else {
        if file
            .seek(SeekFrom::Start(
                candidate.size.saturating_sub(MAX_HISTORY_EDGE_BYTES as u64),
            ))
            .is_err()
        {
            return parse_jsonl_bytes(&prefix);
        }
        let mut suffix = vec![0_u8; MAX_HISTORY_EDGE_BYTES];
        if file.read_exact(&mut suffix).is_err() {
            return parse_jsonl_bytes(&prefix);
        }
        prefix.extend_from_slice(b"\n");
        prefix.extend_from_slice(&suffix);
        prefix
    };
    parse_jsonl_bytes(&bytes)
}

fn parse_jsonl_bytes(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter_map(|line| serde_json::from_str(line.trim()).ok())
        .collect()
}

fn best_usage_metrics(value: &Value, depth: usize) -> Option<TokenMetrics> {
    if depth > 5 {
        return None;
    }
    let object = value.as_object()?;
    let mut best = token_metrics_from_object(object);
    for child in object.values() {
        match child {
            Value::Object(_) => {
                best = choose_larger_metrics(best, best_usage_metrics(child, depth + 1));
            }
            Value::Array(values) => {
                for item in values.iter().take(12) {
                    if item.is_object() {
                        best = choose_larger_metrics(best, best_usage_metrics(item, depth + 1));
                    }
                }
            }
            _ => {}
        }
    }
    best
}

fn choose_larger_metrics(
    left: Option<TokenMetrics>,
    right: Option<TokenMetrics>,
) -> Option<TokenMetrics> {
    match (left, right) {
        (Some(left), Some(right)) if right.total_tokens() > left.total_tokens() => Some(right),
        (Some(left), _) => Some(left),
        (None, right) => right,
    }
}

fn token_metrics_from_object(object: &serde_json::Map<String, Value>) -> Option<TokenMetrics> {
    let raw_input = object_u64(
        object,
        &[
            "input_tokens",
            "inputTokens",
            "prompt_tokens",
            "promptTokens",
        ],
    );
    let raw_output = object_u64(
        object,
        &[
            "output_tokens",
            "outputTokens",
            "completion_tokens",
            "completionTokens",
        ],
    );
    let cache_read = object_u64(
        object,
        &[
            "cache_read_input_tokens",
            "cacheReadInputTokens",
            "cache_read_tokens",
            "cacheReadTokens",
            "cached_input_tokens",
            "cachedTokens",
        ],
    );
    let cache_write = object_u64(
        object,
        &[
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
            "cache_creation_tokens",
            "cacheCreationTokens",
            "cache_write_tokens",
            "cacheWriteTokens",
        ],
    );
    let thinking = object_u64(
        object,
        &[
            "reasoning_output_tokens",
            "reasoning_tokens",
            "reasoningTokens",
            "thinking_tokens",
            "thinkingTokens",
        ],
    );
    let explicit_total = object_u64(object, &["total_tokens", "totalTokens"]);
    let mut metrics = TokenMetrics {
        // Claude reports uncached input separately from both cache counters.
        input_tokens: raw_input,
        output_tokens: raw_output.saturating_sub(thinking),
        thinking_tokens: thinking,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        cache_write_tokens_known: true,
    };
    if metrics.total_tokens() == 0 && explicit_total > 0 {
        metrics.input_tokens = explicit_total;
    }
    (metrics.total_tokens() > 0).then_some(metrics)
}

fn object_u64(object: &serde_json::Map<String, Value>, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(value_u64))
        .unwrap_or(0)
}

fn value_u64(value: &Value) -> Option<u64> {
    if let Some(value) = value.as_u64() {
        return Some(value);
    }
    let value = value.as_f64()?;
    (value.is_finite() && value >= 0.0 && value <= u64::MAX as f64).then_some(value.round() as u64)
}

fn value_timestamp_unix_ms(value: &Value) -> Option<u64> {
    let object = value.as_object()?;
    for key in [
        "timestamp",
        "timestampMs",
        "timestamp_ms",
        "created_at",
        "createdAt",
        "updated_at",
        "updatedAt",
    ] {
        if let Some(timestamp) = object.get(key).and_then(timestamp_unix_ms) {
            return Some(timestamp);
        }
    }
    object
        .get("payload")
        .and_then(Value::as_object)
        .and_then(|payload| {
            ["timestamp", "created_at", "createdAt"]
                .iter()
                .find_map(|key| payload.get(*key).and_then(timestamp_unix_ms))
        })
}

fn timestamp_unix_ms(value: &Value) -> Option<u64> {
    if let Some(value) = value_u64(value) {
        return Some(if value < 10_000_000_000 {
            value.saturating_mul(1_000)
        } else {
            value
        });
    }
    value.as_str().and_then(parse_fixed_rfc3339_millis)
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

fn first_nested_string(value: &Value, keys: &[&str], depth: usize) -> Option<String> {
    if depth > 5 {
        return None;
    }
    let object = value.as_object()?;
    if let Some(found) = keys.iter().find_map(|key| first_string(object.get(*key))) {
        return Some(found);
    }
    object.values().find_map(|child| match child {
        Value::Object(_) => first_nested_string(child, keys, depth + 1),
        Value::Array(values) => values
            .iter()
            .take(12)
            .find_map(|item| first_nested_string(item, keys, depth + 1)),
        _ => None,
    })
}

fn antigravity_workspace_index(candidate: &CandidateFile) -> BTreeMap<String, String> {
    let mut workspaces = BTreeMap::new();
    for value in parse_jsonl_edges(candidate) {
        let Some(object) = value.as_object() else {
            continue;
        };
        let Some(conversation_id) = first_string(
            object
                .get("conversationId")
                .or_else(|| object.get("conversation_id")),
        ) else {
            continue;
        };
        let Some(workspace) = sanitize_absolute_path(first_string(
            object.get("workspace").or_else(|| object.get("cwd")),
        )) else {
            continue;
        };
        if workspaces.len() >= MAX_HISTORY_RECORDS {
            break;
        }
        workspaces.insert(conversation_id, workspace);
    }
    workspaces
}

fn antigravity_conversation_id(path: &Path) -> Option<String> {
    let components = path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    let brain = components
        .iter()
        .position(|component| *component == "brain")?;
    sanitize_identifier(components.get(brain + 1).map(|value| (*value).to_owned()))
}

fn antigravity_usage_source_matches_claim(
    candidate: &CandidateFile,
    claim: &ExternalSessionClaim,
) -> bool {
    if antigravity_conversation_id(&candidate.path).as_deref()
        == Some(claim.vendor_session_id.as_str())
    {
        return true;
    }
    if [
        claim.usage_source_path.as_ref(),
        claim.transcript_path.as_ref(),
    ]
    .into_iter()
    .flatten()
    .any(|path| candidate.path == Path::new(path))
    {
        return true;
    }
    claim
        .artifact_directory_path
        .as_ref()
        .and_then(|path| Path::new(path).parent())
        .is_some_and(|parent| candidate.path == parent.join("transcript.jsonl"))
}

fn infer_gemini_model(content: &str) -> Option<String> {
    content
        .split(|character: char| {
            character.is_whitespace() || matches!(character, '`' | '"' | '\'' | '(' | ')' | ',')
        })
        .find(|word| word.to_ascii_lowercase().starts_with("gemini-"))
        .map(|word| {
            word.trim_matches(|character: char| {
                !character.is_ascii_alphanumeric() && !matches!(character, '-' | '.' | '_')
            })
            .to_owned()
        })
}

fn upsert_usage_record(
    records: &mut BTreeMap<String, ExternalUsageRecord>,
    candidate: ExternalUsageRecord,
) {
    let key = candidate.sample_id.clone();
    if candidate.vendor != "claude" {
        if records
            .get(&key)
            .is_none_or(|existing| candidate.timestamp_unix_ms > existing.timestamp_unix_ms)
        {
            records.insert(key, candidate);
        }
        return;
    }
    if let Some(existing) = records.get_mut(&key) {
        existing.input_tokens = existing.input_tokens.saturating_add(candidate.input_tokens);
        existing.output_tokens = existing
            .output_tokens
            .saturating_add(candidate.output_tokens);
        existing.thinking_tokens = existing
            .thinking_tokens
            .saturating_add(candidate.thinking_tokens);
        existing.cache_read_tokens = existing
            .cache_read_tokens
            .saturating_add(candidate.cache_read_tokens);
        existing.cache_write_tokens = existing
            .cache_write_tokens
            .saturating_add(candidate.cache_write_tokens);
        existing.cache_write_tokens_known |= candidate.cache_write_tokens_known;
        existing.total_tokens = existing
            .input_tokens
            .saturating_add(existing.output_tokens)
            .saturating_add(existing.thinking_tokens)
            .saturating_add(existing.cache_read_tokens)
            .saturating_add(existing.cache_write_tokens);
        if candidate.timestamp_unix_ms >= existing.timestamp_unix_ms {
            existing.timestamp_unix_ms = candidate.timestamp_unix_ms;
            existing.model = candidate.model.or_else(|| existing.model.take());
            existing.cwd = candidate.cwd.or_else(|| existing.cwd.take());
            existing.project_path = candidate
                .project_path
                .or_else(|| existing.project_path.take());
        }
        return;
    }
    records.insert(key, candidate);
}

fn upsert_record(
    records: &mut BTreeMap<String, ExternalHistoryRecord>,
    candidate: ExternalHistoryRecord,
) {
    let key = format!("{}:{}", candidate.vendor, candidate.session_id);
    if records
        .get(&key)
        .is_none_or(|existing| candidate.updated_at_unix_ms > existing.updated_at_unix_ms)
    {
        records.insert(key, candidate);
    }
}

fn first_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn sanitize_identifier(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_owned();
    (!value.is_empty()
        && value.len() <= MAX_SESSION_ID_BYTES
        && !value
            .chars()
            .any(|character| character == '\0' || character.is_control()))
    .then_some(value)
}

fn sanitize_absolute_path(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_owned();
    (Path::new(&value).is_absolute()
        && value.len() <= MAX_PATH_BYTES
        && !value.contains(['\0', '\r', '\n']))
    .then_some(value)
}

fn sanitize_title(value: Option<String>) -> Option<String> {
    let first_line = value?
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?
        .to_owned();
    sanitize_text(Some(first_line), MAX_TITLE_CHARS)
}

fn sanitize_text(value: Option<String>, maximum_chars: usize) -> Option<String> {
    let compact = value?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_owned();
    if compact.is_empty() {
        return None;
    }
    let mut result = compact.chars().take(maximum_chars).collect::<String>();
    if compact.chars().count() > maximum_chars {
        result.pop();
        result.push('…');
    }
    Some(result)
}

fn command_available(command: &str) -> bool {
    if command.contains('/') {
        return executable_file(Path::new(command));
    }
    let Some(path_value) = env::var_os("PATH") else {
        return false;
    };
    command_available_in_path(command, &path_value)
}

fn command_available_in_path(command: &str, path_value: &OsStr) -> bool {
    env::split_paths(path_value).any(|directory| executable_file(&directory.join(command)))
}

fn executable_file(path: &Path) -> bool {
    fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

fn configured_command<'a>(settings: Option<&'a ExternalAgentSettings>, native: &'a str) -> &'a str {
    settings
        .and_then(|settings| settings.command.as_deref())
        .unwrap_or(native)
}

fn validate_agent_scan_settings(
    settings: &ExternalAgentScanSettings,
) -> Result<(), MetadataScanError> {
    for setting in [
        settings.claude.as_ref(),
        settings.codex.as_ref(),
        settings.antigravity.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if setting
            .command
            .as_ref()
            .is_some_and(|command| !valid_agent_setting_string(command, false))
            || setting.args.len() > 256
            || setting
                .args
                .iter()
                .any(|argument| !valid_agent_setting_string(argument, true))
            || setting.additional_session_roots.len() > 256
            || setting.additional_session_roots.iter().any(|root| {
                !valid_agent_setting_string(root, false)
                    || (!root.starts_with('/') && !root.starts_with("~/"))
            })
        {
            return Err(MetadataScanError::InvalidRequest);
        }
    }
    Ok(())
}

fn valid_agent_setting_string(value: &str, allow_empty: bool) -> bool {
    value.len() <= MAX_PATH_BYTES
        && (allow_empty || !value.trim().is_empty())
        && !value.contains(['\0', '\r', '\n'])
}

fn session_roots(
    home: &Path,
    default_root: &Path,
    settings: Option<&ExternalAgentSettings>,
) -> Vec<PathBuf> {
    let configured = settings
        .into_iter()
        .flat_map(|settings| settings.additional_session_roots.iter())
        .filter_map(|root| expand_session_root(home, root));
    let mut seen_paths = BTreeSet::new();
    let mut seen_identities = BTreeSet::new();
    [default_root.to_owned()]
        .into_iter()
        .chain(configured)
        .filter_map(|root| {
            let canonical = fs::canonicalize(root).ok()?;
            let metadata = fs::metadata(&canonical).ok()?;
            if !metadata.is_dir() {
                return None;
            }
            let identity = (metadata.dev(), metadata.ino());
            if !seen_paths.insert(canonical.clone()) || !seen_identities.insert(identity) {
                return None;
            }
            Some(canonical)
        })
        .collect()
}

fn expand_session_root(home: &Path, value: &str) -> Option<PathBuf> {
    if let Some(relative) = value.strip_prefix("~/") {
        return Some(home.join(relative));
    }
    let path = PathBuf::from(value);
    path.is_absolute().then_some(path)
}

#[cfg(test)]
mod tests {
    use std::fs::{FileTimes, Permissions, create_dir_all, set_permissions, write};
    use std::os::unix::fs::symlink;
    use std::time::{Duration, SystemTime};

    use serde::Deserialize;
    use tempfile::tempdir;

    fn owned_claim(
        vendor: &str,
        vendor_session_id: &str,
        claimed_at_unix_ms: u64,
        transcript_path: Option<&Path>,
    ) -> ExternalSessionClaim {
        ExternalSessionClaim {
            vendor: vendor.to_owned(),
            vendor_session_id: vendor_session_id.to_owned(),
            claimed_at_unix_ms,
            last_kmux_seen_at_unix_ms: claimed_at_unix_ms,
            cwd: Some("/srv/owned".to_owned()),
            workspace_paths: vec!["/srv/owned".to_owned()],
            transcript_path: transcript_path.map(|path| path.to_string_lossy().into_owned()),
            artifact_directory_path: None,
            history_source_path: None,
            usage_source_path: None,
            launch_title: None,
        }
    }

    use super::*;

    #[derive(Deserialize)]
    struct InventoryContractFixture {
        version: u64,
        scenarios: Vec<InventoryContractScenario>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct InventoryContractScenario {
        name: String,
        roots: Vec<String>,
        limits: Option<InventoryContractLimits>,
        entries: Vec<InventoryContractEntry>,
        expected_candidates: Vec<String>,
        truncated: bool,
        classifications: Vec<InventoryContractClassification>,
    }

    #[derive(Clone, Copy, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct InventoryContractLimits {
        max_depth: usize,
        max_directories: usize,
        max_entries: usize,
    }

    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "lowercase")]
    enum InventoryContractEntry {
        Directory {
            path: String,
        },
        File {
            path: String,
            #[serde(rename = "mtimeMs")]
            mtime_ms: u64,
        },
        Symlink {
            path: String,
            target: String,
        },
    }

    #[derive(Deserialize)]
    struct InventoryContractClassification {
        vendor: String,
        root: String,
        path: String,
        role: String,
    }

    #[derive(Deserialize)]
    struct AgentSessionContractFixture {
        version: u64,
        scenarios: Vec<AgentSessionContractScenario>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AgentSessionContractScenario {
        name: String,
        vendor: String,
        session_id: String,
        source_path: String,
        lines: Vec<Value>,
        usage_source_path: Option<String>,
        #[serde(default)]
        usage_lines: Vec<Value>,
        #[serde(default)]
        conversation_prompts: Vec<String>,
        expected: AgentSessionContractExpected,
    }

    #[derive(Deserialize)]
    struct AgentSessionContractExpected {
        title: String,
        cwd: String,
        usage: AgentSessionContractUsage,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AgentSessionContractUsage {
        input_tokens: u64,
        output_tokens: u64,
        thinking_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
        cache_write_tokens_known: bool,
        total_tokens: u64,
    }

    #[test]
    fn matches_the_cross_language_session_inventory_contract() {
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../fixtures/session-inventory-contract.json");
        let fixture: InventoryContractFixture =
            serde_json::from_slice(&fs::read(fixture_path).unwrap()).unwrap();
        assert_eq!(fixture.version, 1);

        for scenario in fixture.scenarios {
            let temporary = tempdir().unwrap();
            let sandbox_path = fs::canonicalize(temporary.path()).unwrap();
            let sandbox = sandbox_path.as_path();
            for root in &scenario.roots {
                let root_is_symlink = scenario.entries.iter().any(|entry| {
                    matches!(
                        entry,
                        InventoryContractEntry::Symlink { path, .. } if path == root
                    )
                });
                if !root_is_symlink {
                    create_dir_all(sandbox.join(root)).unwrap();
                }
            }
            for entry in &scenario.entries {
                match entry {
                    InventoryContractEntry::Directory { path } => {
                        create_dir_all(sandbox.join(path)).unwrap();
                    }
                    InventoryContractEntry::File { path, mtime_ms } => {
                        let path = sandbox.join(path);
                        create_dir_all(path.parent().unwrap()).unwrap();
                        write(&path, path.to_string_lossy().as_bytes()).unwrap();
                        let modified = SystemTime::UNIX_EPOCH + Duration::from_millis(*mtime_ms);
                        File::options()
                            .write(true)
                            .open(path)
                            .unwrap()
                            .set_times(FileTimes::new().set_modified(modified))
                            .unwrap();
                    }
                    InventoryContractEntry::Symlink { .. } => {}
                }
            }
            for entry in &scenario.entries {
                let InventoryContractEntry::Symlink { path, target } = entry else {
                    continue;
                };
                let path = sandbox.join(path);
                create_dir_all(path.parent().unwrap()).unwrap();
                symlink(sandbox.join(target), path).unwrap();
            }

            let roots = scenario
                .roots
                .iter()
                .map(|root| sandbox.join(root))
                .collect::<Vec<_>>();
            let limits = scenario
                .limits
                .map(|limits| SessionInventoryLimits {
                    max_depth: limits.max_depth,
                    max_directories: limits.max_directories,
                    max_entries: limits.max_entries,
                })
                .unwrap_or(SESSION_INVENTORY_LIMITS);
            let inventory = collect_session_inventory_with_limits(&roots, limits);
            let actual = inventory
                .candidates
                .iter()
                .map(|candidate| {
                    candidate
                        .path
                        .strip_prefix(sandbox)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect::<Vec<_>>();
            assert_eq!(actual, scenario.expected_candidates, "{}", scenario.name);
            assert_eq!(
                inventory.is_partial(),
                scenario.truncated,
                "{}",
                scenario.name
            );

            for classification in scenario.classifications {
                let vendor = match classification.vendor.as_str() {
                    "codex" => SessionVendor::Codex,
                    "claude" => SessionVendor::Claude,
                    "antigravity" => SessionVendor::Antigravity,
                    other => panic!("unknown contract vendor {other}"),
                };
                let actual = classify_session_candidate(
                    &sandbox.join(classification.root),
                    &sandbox.join(classification.path),
                    vendor,
                )
                .map(session_candidate_role_name);
                assert_eq!(actual, Some(classification.role.as_str()));
            }
        }
    }

    #[test]
    fn matches_the_cross_language_agent_session_normalization_contract() {
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../fixtures/agent-session-normalization-contract.json");
        let fixture: AgentSessionContractFixture =
            serde_json::from_slice(&fs::read(fixture_path).unwrap()).unwrap();
        assert_eq!(fixture.version, 1);

        for scenario in fixture.scenarios {
            let sandbox = tempdir().unwrap();
            let source = sandbox.path().join(&scenario.source_path);
            let usage_source = sandbox.path().join(
                scenario
                    .usage_source_path
                    .as_deref()
                    .unwrap_or(&scenario.source_path),
            );
            create_dir_all(source.parent().unwrap()).unwrap();
            create_dir_all(usage_source.parent().unwrap()).unwrap();
            let mut source_lines = scenario
                .lines
                .iter()
                .map(|line| serde_json::to_string(line).unwrap())
                .collect::<Vec<_>>();
            if usage_source == source {
                source_lines.extend(
                    scenario
                        .usage_lines
                        .iter()
                        .map(|line| serde_json::to_string(line).unwrap()),
                );
            }
            write(&source, format!("{}\n", source_lines.join("\n"))).unwrap();
            if usage_source != source {
                let usage_contents = scenario
                    .usage_lines
                    .iter()
                    .map(|line| serde_json::to_string(line).unwrap())
                    .collect::<Vec<_>>()
                    .join("\n");
                write(&usage_source, format!("{usage_contents}\n")).unwrap();
            }
            if !scenario.conversation_prompts.is_empty() {
                let path = sandbox
                    .path()
                    .join(".gemini/antigravity-cli/conversations")
                    .join(format!("{}.db", scenario.session_id));
                create_dir_all(path.parent().unwrap()).unwrap();
                let database = Connection::open(path).unwrap();
                database
                    .execute(
                        "CREATE TABLE steps (
                            idx INTEGER NOT NULL,
                            step_type INTEGER NOT NULL,
                            step_payload BLOB
                        )",
                        [],
                    )
                    .unwrap();
                for (index, prompt) in scenario.conversation_prompts.iter().enumerate() {
                    database
                        .execute(
                            "INSERT INTO steps (idx, step_type, step_payload)
                             VALUES (?1, 14, ?2)",
                            rusqlite::params![
                                i64::try_from(index).unwrap(),
                                encode_contract_antigravity_prompt(prompt)
                            ],
                        )
                        .unwrap();
                }
            }
            let claim = owned_claim(
                &scenario.vendor,
                &scenario.session_id,
                1,
                Some(&usage_source),
            );
            let (scan, _) = scan_owned_external_history_with_settings(
                sandbox.path(),
                1,
                &ExternalAgentScanSettings::default(),
                std::slice::from_ref(&claim),
            )
            .unwrap();
            let record = scan
                .records
                .first()
                .unwrap_or_else(|| panic!("{} did not produce a normalized record", scenario.name));
            assert_eq!(
                record.title.as_deref(),
                Some(scenario.expected.title.as_str()),
                "{}",
                scenario.name
            );
            assert_eq!(
                record.cwd.as_deref(),
                Some(scenario.expected.cwd.as_str()),
                "{}",
                scenario.name
            );

            let (usage, _) = scan_owned_external_usage_with_settings(
                sandbox.path(),
                1,
                1,
                &ExternalAgentScanSettings::default(),
                std::slice::from_ref(&claim),
            )
            .unwrap();
            let usage = usage
                .records
                .first()
                .unwrap_or_else(|| panic!("{} did not produce normalized usage", scenario.name));
            assert_eq!(
                (
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.thinking_tokens,
                    usage.cache_read_tokens,
                    usage.cache_write_tokens,
                    usage.cache_write_tokens_known,
                    usage.total_tokens,
                ),
                (
                    scenario.expected.usage.input_tokens,
                    scenario.expected.usage.output_tokens,
                    scenario.expected.usage.thinking_tokens,
                    scenario.expected.usage.cache_read_tokens,
                    scenario.expected.usage.cache_write_tokens,
                    scenario.expected.usage.cache_write_tokens_known,
                    scenario.expected.usage.total_tokens,
                ),
                "{}",
                scenario.name
            );
        }
    }

    fn encode_contract_antigravity_prompt(prompt: &str) -> Vec<u8> {
        let mut payload = vec![0x12];
        let mut remaining = u64::try_from(prompt.len()).unwrap();
        loop {
            let mut byte = u8::try_from(remaining & 0x7f).unwrap();
            remaining >>= 7;
            if remaining > 0 {
                byte |= 0x80;
            }
            payload.push(byte);
            if remaining == 0 {
                break;
            }
        }
        payload.extend_from_slice(prompt.as_bytes());
        payload
    }

    fn session_candidate_role_name(role: SessionCandidateRole) -> &'static str {
        match role {
            SessionCandidateRole::CodexSession => "codex-session",
            SessionCandidateRole::ClaudeSession => "claude-session",
            SessionCandidateRole::ClaudeSubagent => "claude-subagent",
            SessionCandidateRole::AntigravityHistory => "antigravity-history",
            SessionCandidateRole::AntigravityTranscript => "antigravity-transcript",
            SessionCandidateRole::AntigravityConversation => "antigravity-conversation",
        }
    }

    #[test]
    fn scans_bounded_codex_claude_and_antigravity_history() {
        let temporary = tempdir().unwrap();
        let home = temporary.path();
        let codex = home.join(".codex/sessions/2026/07/18");
        let claude = home.join(".claude/projects/repo");
        let antigravity = home.join(".gemini/antigravity-cli");
        create_dir_all(&codex).unwrap();
        create_dir_all(&claude).unwrap();
        create_dir_all(&antigravity).unwrap();
        write(
            codex.join("rollout-one.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-1\",\"cwd\":\"/srv/repo\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"ship it\"}}\n"
            ),
        )
        .unwrap();
        write(
            claude.join("claude-1.jsonl"),
            "{\"sessionId\":\"claude-1\",\"cwd\":\"/srv/claude\",\"type\":\"user\",\"message\":{\"content\":\"fix tests\"}}\n",
        )
        .unwrap();
        write(
            antigravity.join("history.jsonl"),
            "{\"conversationId\":\"agy-1\",\"workspace\":\"/srv/agy\",\"title\":\"Review\"}\n",
        )
        .unwrap();
        let records = scan_external_history(home, 10).unwrap();
        assert!(!records.truncated);
        assert_eq!(records.records.len(), 3);
        assert!(records.records.iter().any(|record| {
            record.vendor == "codex"
                && record.session_id == "codex-1"
                && record.cwd.as_deref() == Some("/srv/repo")
                && record.title.as_deref() == Some("ship it")
        }));
        assert!(
            records
                .records
                .iter()
                .any(|record| record.vendor == "claude" && record.session_id == "claude-1")
        );
        assert!(
            records
                .records
                .iter()
                .any(|record| { record.vendor == "antigravity" && record.session_id == "agy-1" })
        );
    }

    #[test]
    fn marks_antigravity_history_partial_at_record_and_edge_bounds() {
        let temporary = tempdir().unwrap();
        let history = temporary
            .path()
            .join(".gemini/antigravity-cli/history.jsonl");
        create_dir_all(history.parent().unwrap()).unwrap();
        write(
            &history,
            concat!(
                "{\"conversationId\":\"agy-1\",\"workspace\":\"/srv/one\"}\n",
                "{\"conversationId\":\"agy-2\",\"workspace\":\"/srv/two\"}\n",
                "{\"conversationId\":\"agy-3\",\"workspace\":\"/srv/three\"}\n"
            ),
        )
        .unwrap();

        let record_bounded = scan_external_history(temporary.path(), 2).unwrap();
        assert_eq!(record_bounded.records.len(), 2);
        assert!(record_bounded.truncated);

        let oversized = format!(
            "{}\n{}\n{}\n",
            "{\"conversationId\":\"agy-prefix\",\"workspace\":\"/srv/prefix\"}",
            "x".repeat(MAX_HISTORY_EDGE_BYTES * 2),
            "{\"conversationId\":\"agy-suffix\",\"workspace\":\"/srv/suffix\"}"
        );
        write(&history, oversized).unwrap();

        let edge_bounded = scan_external_history(temporary.path(), 10).unwrap();
        assert!(edge_bounded.truncated);
        assert!(
            edge_bounded.records.iter().any(|record| {
                record.vendor == "antigravity" && record.session_id == "agy-prefix"
            })
        );
        assert!(
            edge_bounded.records.iter().any(|record| {
                record.vendor == "antigravity" && record.session_id == "agy-suffix"
            })
        );
    }

    #[test]
    fn excludes_codex_subagents_and_symlinked_inventory() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join(".codex/sessions");
        create_dir_all(&root).unwrap();
        write(
            root.join("rollout-subagent.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"child\",\"thread_source\":\"subagent\"}}\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(
            root.join("rollout-subagent.jsonl"),
            root.join("rollout-linked.jsonl"),
        )
        .unwrap();

        assert!(
            scan_external_history(temporary.path(), 10)
                .unwrap()
                .records
                .is_empty()
        );
    }

    #[test]
    fn accepts_executable_commands_reached_through_path_symlinks() {
        let temporary = tempdir().unwrap();
        let executable = temporary.path().join("codex-real");
        write(&executable, "#!/bin/sh\n").unwrap();
        set_permissions(&executable, Permissions::from_mode(0o700)).unwrap();
        symlink(&executable, temporary.path().join("codex")).unwrap();

        assert!(command_available_in_path(
            "codex",
            temporary.path().as_os_str()
        ));
    }

    #[test]
    fn scans_home_relative_additional_roots_and_configured_executables() {
        let temporary = tempdir().unwrap();
        let home = temporary.path();
        let additional = home.join("wrapper-sessions");
        let session_dir = additional.join("2026/07/18");
        create_dir_all(&session_dir).unwrap();
        write(
            session_dir.join("rollout-wrapper.jsonl"),
            concat!(
                "{\"timestamp\":\"2026-07-18T09:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"wrapper-session\",\"cwd\":\"/srv/wrapper\"}}\n",
                "{\"timestamp\":\"2026-07-18T09:01:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}}\n"
            ),
        )
        .unwrap();
        let default_session_dir = home.join(".codex/sessions/2026/07/18");
        create_dir_all(&default_session_dir).unwrap();
        write(
            default_session_dir.join("rollout-wrapper-copy.jsonl"),
            concat!(
                "{\"timestamp\":\"2026-07-18T08:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"wrapper-session\",\"cwd\":\"/srv/wrapper\"}}\n",
                "{\"timestamp\":\"2026-07-18T08:01:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":3,\"output_tokens\":1,\"total_tokens\":4}}}}\n"
            ),
        )
        .unwrap();
        symlink(&additional, home.join("wrapper-sessions-link")).unwrap();
        let executable = home.join("ccsxp");
        write(&executable, "#!/bin/sh\n").unwrap();
        set_permissions(&executable, Permissions::from_mode(0o700)).unwrap();
        let settings = ExternalAgentScanSettings {
            codex: Some(ExternalAgentSettings {
                command: Some(executable.to_string_lossy().into_owned()),
                additional_session_roots: vec![
                    "~/wrapper-sessions".to_owned(),
                    home.join("wrapper-sessions-link")
                        .to_string_lossy()
                        .into_owned(),
                    home.join("missing").to_string_lossy().into_owned(),
                ],
                ..ExternalAgentSettings::default()
            }),
            ..ExternalAgentScanSettings::default()
        };

        let history = scan_external_history_with_settings(home, 10, &settings).unwrap();
        assert_eq!(history.records.len(), 1);
        assert_eq!(history.records[0].session_id, "wrapper-session");
        assert!(history.records[0].can_resume);

        let usage = scan_external_usage_with_settings(home, 0, 64, &settings).unwrap();
        assert_eq!(usage.records.len(), 1);
        assert_eq!(
            usage.records[0].session_id.as_deref(),
            Some("wrapper-session")
        );
        assert_eq!(usage.records[0].total_tokens, 15);
    }

    #[test]
    fn returns_partial_history_inventories_that_overfill_the_directory_queue() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("inventory");
        create_dir_all(&root).unwrap();
        for index in 0..MAX_HISTORY_DIRECTORIES {
            create_dir_all(root.join(format!("directory-{index}"))).unwrap();
        }

        let inventory = collect_session_inventory(&[root]);
        assert!(inventory.truncated);
        assert!(!inventory.diagnostics.is_empty());
    }

    #[test]
    fn returns_partial_usage_and_continues_after_a_vendor_directory_bound() {
        let temporary = tempdir().unwrap();
        let codex = temporary.path().join(".codex/sessions");
        create_dir_all(&codex).unwrap();
        for index in 0..MAX_HISTORY_DIRECTORIES {
            create_dir_all(codex.join(format!("{index:04}"))).unwrap();
        }
        let claude = temporary.path().join(".claude/projects/repo");
        create_dir_all(&claude).unwrap();
        write(
            claude.join("session.jsonl"),
            "{\"type\":\"assistant\",\"sessionId\":\"claude-partial\",\"timestamp\":\"2026-07-18T00:00:03.000Z\",\"message\":{\"id\":\"message-partial\",\"usage\":{\"input_tokens\":21,\"output_tokens\":5}}}\n",
        )
        .unwrap();

        let scan = scan_external_usage(temporary.path(), 0, 64).unwrap();

        assert!(scan.truncated);
        assert!(scan.records.iter().any(|record| {
            record.vendor == "claude"
                && record.session_id.as_deref() == Some("claude-partial")
                && record.total_tokens == 26
        }));
    }

    #[test]
    fn scans_target_local_usage_with_bounded_vendor_aggregates() {
        let temporary = tempdir().unwrap();
        let home = temporary.path();
        let codex = home.join(".codex/sessions/2026/07/18");
        let claude = home.join(".claude/projects/repo");
        let antigravity =
            home.join(".gemini/antigravity-cli/brain/agy-usage/.system_generated/logs");
        create_dir_all(&codex).unwrap();
        create_dir_all(&claude).unwrap();
        create_dir_all(&antigravity).unwrap();
        create_dir_all(home.join(".gemini/antigravity-cli")).unwrap();
        write(
            codex.join("rollout-usage.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-usage\",\"cwd\":\"/srv/codex\"}}\n",
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-18T00:00:01.000Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":20,\"output_tokens\":10,\"reasoning_output_tokens\":2}}}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-18T00:00:02.000Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":160,\"cached_input_tokens\":30,\"output_tokens\":20,\"reasoning_output_tokens\":4}}}}\n"
            ),
        )
        .unwrap();
        write(
            claude.join("claude-usage.jsonl"),
            "{\"sessionId\":\"claude-usage\",\"cwd\":\"/srv/claude\",\"timestamp\":\"2026-07-18T00:00:03.000Z\",\"message\":{\"model\":\"claude-4\",\"usage\":{\"input_tokens\":21,\"cache_read_input_tokens\":8,\"cache_creation_input_tokens\":3,\"output_tokens\":5}}}\n",
        )
        .unwrap();
        write(
            home.join(".gemini/antigravity-cli/history.jsonl"),
            "{\"conversationId\":\"agy-usage\",\"workspace\":\"/srv/agy\"}\n",
        )
        .unwrap();
        write(
            antigravity.join("transcript.jsonl"),
            "{\"created_at\":\"2026-07-18T00:00:04.000Z\",\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"content\":\"use gemini-3.5-flash here\"}\n",
        )
        .unwrap();

        let start = parse_fixed_rfc3339_millis("2026-07-18T00:00:00.000Z").unwrap();
        let scan = scan_external_usage(home, start, 64).unwrap();

        assert!(!scan.truncated);
        assert_eq!(scan.records.len(), 3);
        assert!(scan.records.iter().any(|record| {
            record.vendor == "codex"
                && record.session_id.as_deref() == Some("codex-usage")
                && record.cwd.as_deref() == Some("/srv/codex")
                && record.model.as_deref() == Some("gpt-5.6")
                && record.input_tokens == 130
                && record.cache_read_tokens == 30
                && record.output_tokens == 16
                && record.thinking_tokens == 4
                && record.total_tokens == 180
        }));
        assert!(scan.records.iter().any(|record| {
            record.vendor == "claude"
                && record.input_tokens == 21
                && record.cache_read_tokens == 8
                && record.cache_write_tokens == 3
                && record.output_tokens == 5
        }));
        assert!(scan.records.iter().any(|record| {
            record.vendor == "antigravity"
                && record.cwd.as_deref() == Some("/srv/agy")
                && record.model.as_deref() == Some("gemini-3.5-flash")
                && record.input_tokens > 0
        }));
    }

    #[test]
    fn deduplicates_claude_parent_and_subagent_requests_and_ignores_noise() {
        let temporary = tempdir().unwrap();
        let parent = temporary.path().join(".claude/projects/repo");
        let subagents = parent.join("subagents");
        create_dir_all(&subagents).unwrap();
        write(
            parent.join("session.jsonl"),
            concat!(
                "{\"type\":\"assistant\",\"sessionId\":\"claude-session\",\"requestId\":\"request-1\",\"timestamp\":\"2026-07-18T00:00:01.000Z\",\"message\":{\"id\":\"message-1\",\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}}\n",
                "{\"type\":\"user\",\"uuid\":\"noise\",\"sessionId\":\"claude-session\",\"timestamp\":\"2026-07-18T00:00:02.000Z\",\"payload\":{\"usage\":{\"input_tokens\":999}}}\n"
            ),
        )
        .unwrap();
        write(
            subagents.join("child.jsonl"),
            concat!(
                "{\"type\":\"assistant\",\"sessionId\":\"claude-session\",\"requestId\":\"request-1\",\"timestamp\":\"2026-07-18T00:00:01.000Z\",\"message\":{\"id\":\"message-1\",\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}}\n",
                "{\"type\":\"assistant\",\"sessionId\":\"claude-session\",\"requestId\":\"request-2\",\"timestamp\":\"2026-07-18T00:00:03.000Z\",\"message\":{\"id\":\"message-2\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n"
            ),
        )
        .unwrap();

        let start = parse_fixed_rfc3339_millis("2026-07-18T00:00:00.000Z").unwrap();
        let scan = scan_external_usage(temporary.path(), start, 64).unwrap();
        let record = scan
            .records
            .iter()
            .find(|record| record.vendor == "claude")
            .unwrap();

        assert_eq!(record.session_id.as_deref(), Some("claude-session"));
        assert_eq!(record.input_tokens, 13);
        assert_eq!(record.output_tokens, 3);
        assert_eq!(record.total_tokens, 16);
    }

    #[test]
    fn owned_history_uses_only_claims_and_never_exposes_identifier_fallbacks() {
        let temporary = tempdir().unwrap();
        let home = temporary.path();
        let codex = home.join(".codex/sessions/owned.jsonl");
        let claude = home.join(".claude/projects/repo/claude-owned.jsonl");
        let antigravity = home.join(".gemini/antigravity-cli");
        create_dir_all(codex.parent().unwrap()).unwrap();
        create_dir_all(claude.parent().unwrap()).unwrap();
        create_dir_all(&antigravity).unwrap();
        write(
            &codex,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-owned\",\"cwd\":\"/srv/codex\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Implement bounded history\"}}\n"
            ),
        )
        .unwrap();
        write(
            &claude,
            "{\"sessionId\":\"claude-owned\",\"cwd\":\"/srv/claude\",\"type\":\"user\",\"message\":{\"content\":\"Review the registry\"}}\n",
        )
        .unwrap();
        write(
            antigravity.join("history.jsonl"),
            concat!(
                "{\"conversationId\":\"agy-unrelated\",\"display\":\"do not show\",\"timestamp\":1}\n",
                "{\"conversationId\":\"agy-owned\",\"workspace\":\"/srv/agy\",\"display\":\"Inspect the conversation\",\"timestamp\":2000000000000}\n"
            ),
        )
        .unwrap();
        create_dir_all(antigravity.join("conversations")).unwrap();
        let conversation =
            Connection::open(antigravity.join("conversations/agy-owned.db")).unwrap();
        conversation
            .execute(
                "CREATE TABLE steps (idx INTEGER, step_type INTEGER, step_payload BLOB)",
                [],
            )
            .unwrap();
        for (index, prompt) in ["DB first prompt", "DB latest prompt"]
            .into_iter()
            .enumerate()
        {
            let mut payload = vec![0x12, u8::try_from(prompt.len()).unwrap()];
            payload.extend_from_slice(prompt.as_bytes());
            conversation
                .execute(
                    "INSERT INTO steps (idx, step_type, step_payload) VALUES (?1, 14, ?2)",
                    rusqlite::params![index as i64, payload],
                )
                .unwrap();
        }
        drop(conversation);
        for index in 0..200 {
            write(
                home.join(format!(".codex/sessions/unrelated-{index}.jsonl")),
                format!(
                    "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"unrelated-{index}\"}}}}\n"
                ),
            )
            .unwrap();
        }

        let claims = vec![
            owned_claim("codex", "codex-owned", 1_000, Some(&codex)),
            owned_claim("claude", "claude-owned", 1_000, Some(&claude)),
            owned_claim("antigravity", "agy-owned", 1_000, None),
            owned_claim("codex", "01234567-89ab-cdef-0123-456789abcdef", 1_000, None),
        ];
        let settings = ExternalAgentScanSettings {
            codex: Some(ExternalAgentSettings {
                command: Some(
                    home.join("missing-from-daemon-path")
                        .to_string_lossy()
                        .into_owned(),
                ),
                ..ExternalAgentSettings::default()
            }),
            ..ExternalAgentScanSettings::default()
        };
        let (scan, _) =
            scan_owned_external_history_with_settings(home, 10, &settings, &claims).unwrap();

        assert_eq!(scan.records.len(), 4);
        assert!(scan.records.iter().all(|record| {
            record.session_id != "agy-unrelated"
                && !record
                    .title
                    .as_deref()
                    .unwrap_or_default()
                    .contains(&record.session_id)
        }));
        assert!(scan.records.iter().any(|record| {
            record.session_id == "codex-owned"
                && record.title.as_deref() == Some("Implement bounded history")
                && record.can_resume
        }));
        assert!(
            scan.records.iter().any(|record| {
                record.session_id == "agy-owned"
                    && record.title.as_deref() == Some("DB first prompt")
                    && record.recent_conversation.as_deref() == Some("DB latest prompt")
                    && record.updated_at_unix_ms == 2_000_000_000_000
            }),
            "{:?}",
            scan.records
        );
        assert!(scan.records.iter().any(|record| {
            record.session_id == "01234567-89ab-cdef-0123-456789abcdef"
                && record.title.as_deref() == Some("Codex session")
        }));
    }

    #[test]
    fn oversized_antigravity_latest_prompt_does_not_select_an_older_step() {
        let temporary = tempdir().unwrap();
        let database_path = temporary.path().join("conversation.db");
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute(
                "CREATE TABLE steps (
                    idx INTEGER PRIMARY KEY,
                    step_type INTEGER NOT NULL,
                    step_payload BLOB
                )",
                [],
            )
            .unwrap();
        connection
            .execute("CREATE INDEX idx_steps_step_type ON steps(step_type)", [])
            .unwrap();
        let prompt = "First prompt";
        let mut first_payload = vec![0x12, u8::try_from(prompt.len()).unwrap()];
        first_payload.extend_from_slice(prompt.as_bytes());
        connection
            .execute(
                "INSERT INTO steps (idx, step_type, step_payload) VALUES (0, 14, ?1)",
                rusqlite::params![first_payload],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO steps (idx, step_type, step_payload) VALUES (1, 14, ?1)",
                rusqlite::params![vec![0_u8; MAX_ANTIGRAVITY_PROMPT_PAYLOAD_BYTES + 1]],
            )
            .unwrap();
        drop(connection);

        let details = antigravity_conversation_details(&database_path);

        assert_eq!(details.title.as_deref(), Some(prompt));
        assert_eq!(details.recent_conversation, None);
    }

    #[test]
    fn owned_usage_applies_claim_time_and_rejects_unclaimed_or_sessionless_data() {
        let temporary = tempdir().unwrap();
        let home = temporary.path();
        let codex = home.join(".codex/sessions/owned.jsonl");
        let unrelated = home.join(".codex/sessions/unrelated.jsonl");
        let sessionless = home.join(".codex/sessions/sessionless.jsonl");
        create_dir_all(codex.parent().unwrap()).unwrap();
        write(
            &codex,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-owned\",\"cwd\":\"/srv/shared\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-18T00:00:01.000Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"output_tokens\":10}}}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-18T00:00:03.000Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":130,\"output_tokens\":15}}}}\n"
            ),
        )
        .unwrap();
        write(
            &unrelated,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-unrelated\",\"cwd\":\"/srv/shared\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-18T00:00:04.000Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":999,\"output_tokens\":999}}}}\n"
            ),
        )
        .unwrap();
        write(
            &sessionless,
            "{\"timestamp\":\"2026-07-18T00:00:05.000Z\",\"input_tokens\":500,\"output_tokens\":500}\n",
        )
        .unwrap();
        let claim_at = parse_fixed_rfc3339_millis("2026-07-18T00:00:02.000Z").unwrap();
        let claims = vec![
            owned_claim("codex", "codex-owned", claim_at, Some(&codex)),
            owned_claim(
                "codex",
                "codex-sessionless-claim",
                claim_at,
                Some(&sessionless),
            ),
        ];

        let (scan, _) = scan_owned_external_usage_with_settings(
            home,
            0,
            64,
            &ExternalAgentScanSettings::default(),
            &claims,
        )
        .unwrap();
        assert_eq!(scan.records.len(), 1);
        let record = &scan.records[0];
        assert_eq!(record.session_id.as_deref(), Some("codex-owned"));
        assert_eq!(record.input_tokens, 30);
        assert_eq!(record.output_tokens, 5);
        assert_eq!(record.total_tokens, 35);
    }

    #[test]
    fn owned_scans_use_fallback_only_after_direct_source_identity_mismatch() {
        let temporary = tempdir().unwrap();
        let home = temporary.path();
        let direct = home.join("direct/stale.jsonl");
        let fallback = home.join(".codex/sessions/fallback-codex-owned.jsonl");
        create_dir_all(direct.parent().unwrap()).unwrap();
        create_dir_all(fallback.parent().unwrap()).unwrap();
        write(
            &direct,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-unrelated\",\"cwd\":\"/srv/unrelated\"}}\n",
        )
        .unwrap();
        write(
            &fallback,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-owned\",\"cwd\":\"/srv/owned\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Use the bounded fallback\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-18T00:00:01.000Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":10,\"output_tokens\":2}}}}\n"
            ),
        )
        .unwrap();
        let claim = owned_claim("codex", "codex-owned", 1, Some(&direct));

        let (history, history_cache) = scan_owned_external_history_with_settings(
            home,
            10,
            &ExternalAgentScanSettings::default(),
            std::slice::from_ref(&claim),
        )
        .unwrap();
        let (usage, usage_cache) = scan_owned_external_usage_with_settings(
            home,
            0,
            64,
            &ExternalAgentScanSettings::default(),
            std::slice::from_ref(&claim),
        )
        .unwrap();

        assert_eq!(
            history.records[0].title.as_deref(),
            Some("Use the bounded fallback")
        );
        assert_eq!(usage.records[0].total_tokens, 12);
        let fallback = fallback.canonicalize().unwrap();
        assert_eq!(history_cache[0].path, fallback.to_string_lossy());
        assert_eq!(usage_cache[0].path, fallback.to_string_lossy());
    }

    #[test]
    fn owned_usage_caches_valid_direct_sources_without_usage_in_the_window() {
        let temporary = tempdir().unwrap();
        let home = temporary.path();
        let codex = home.join(".codex/sessions/codex-no-usage.jsonl");
        let antigravity = home.join(
            ".gemini/antigravity-cli/brain/agy-no-usage/.system_generated/logs/transcript.jsonl",
        );
        create_dir_all(codex.parent().unwrap()).unwrap();
        create_dir_all(antigravity.parent().unwrap()).unwrap();
        write(
            &codex,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-no-usage\",\"cwd\":\"/srv/codex\"}}\n",
        )
        .unwrap();
        write(&antigravity, "{}\n").unwrap();
        let claims = vec![
            owned_claim("codex", "codex-no-usage", 1, Some(&codex)),
            owned_claim("antigravity", "agy-no-usage", 1, Some(&antigravity)),
        ];

        let (usage, cache_updates) = scan_owned_external_usage_with_settings(
            home,
            1,
            64,
            &ExternalAgentScanSettings::default(),
            &claims,
        )
        .unwrap();

        assert!(usage.records.is_empty());
        assert_eq!(cache_updates.len(), 2);
        assert_eq!(cache_updates[0].path, codex.to_string_lossy());
        assert_eq!(cache_updates[1].path, antigravity.to_string_lossy());
    }

    #[test]
    fn owned_usage_aggregates_claimed_claude_parent_and_subagents() {
        let temporary = tempdir().unwrap();
        let home = temporary.path();
        let parent = home.join(".claude/projects/repo/claude-owned.jsonl");
        let subagents = parent.parent().unwrap().join("subagents");
        create_dir_all(&subagents).unwrap();
        write(
            &parent,
            "{\"type\":\"assistant\",\"sessionId\":\"claude-owned\",\"requestId\":\"request-1\",\"timestamp\":\"2026-07-18T00:00:01.000Z\",\"message\":{\"id\":\"message-1\",\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}}\n",
        )
        .unwrap();
        write(
            subagents.join("agent-a.jsonl"),
            concat!(
                "{\"type\":\"assistant\",\"sessionId\":\"claude-owned\",\"requestId\":\"request-1\",\"timestamp\":\"2026-07-18T00:00:01.000Z\",\"message\":{\"id\":\"message-1\",\"usage\":{\"input_tokens\":10,\"output_tokens\":4}}}\n",
                "{\"type\":\"assistant\",\"sessionId\":\"claude-owned\",\"requestId\":\"request-2\",\"timestamp\":\"2026-07-18T00:00:02.000Z\",\"message\":{\"id\":\"message-2\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n"
            ),
        )
        .unwrap();
        write(
            subagents.join("00-unrelated.jsonl"),
            "{\"type\":\"assistant\",\"sessionId\":\"claude-unrelated\",\"requestId\":\"request-2\",\"timestamp\":\"2026-07-18T00:00:03.000Z\",\"message\":{\"id\":\"message-2\",\"usage\":{\"input_tokens\":999,\"output_tokens\":999}}}\n",
        )
        .unwrap();

        let claims = vec![owned_claim("claude", "claude-owned", 1, Some(&parent))];
        let (scan, cache_updates) = scan_owned_external_usage_with_settings(
            home,
            0,
            64,
            &ExternalAgentScanSettings::default(),
            &claims,
        )
        .unwrap();

        assert!(!scan.truncated);
        assert_eq!(scan.records.len(), 1);
        assert_eq!(scan.records[0].session_id.as_deref(), Some("claude-owned"));
        assert_eq!(scan.records[0].input_tokens, 13);
        assert_eq!(scan.records[0].output_tokens, 3);
        assert_eq!(scan.records[0].total_tokens, 16);
        assert_eq!(cache_updates.len(), 1);
        assert_eq!(cache_updates[0].path, parent.to_string_lossy());
    }

    #[test]
    fn owned_usage_reads_claude_subagents_when_parent_has_no_usage() {
        let temporary = tempdir().unwrap();
        let home = temporary.path();
        let parent = home.join(".claude/projects/repo/claude-parent-only.jsonl");
        let subagents = parent.parent().unwrap().join("subagents");
        create_dir_all(&subagents).unwrap();
        write(
            &parent,
            "{\"type\":\"user\",\"sessionId\":\"claude-parent-only\",\"cwd\":\"/srv/claude\",\"message\":{\"content\":\"Delegate the task\"}}\n",
        )
        .unwrap();
        write(
            subagents.join("agent-only.jsonl"),
            "{\"type\":\"assistant\",\"sessionId\":\"claude-parent-only\",\"requestId\":\"request-agent-only\",\"timestamp\":\"2026-07-18T00:00:02.000Z\",\"message\":{\"id\":\"message-agent-only\",\"usage\":{\"input_tokens\":7,\"output_tokens\":3}}}\n",
        )
        .unwrap();

        let claims = vec![owned_claim(
            "claude",
            "claude-parent-only",
            1,
            Some(&parent),
        )];
        let (scan, _) = scan_owned_external_usage_with_settings(
            home,
            0,
            64,
            &ExternalAgentScanSettings::default(),
            &claims,
        )
        .unwrap();

        assert_eq!(scan.records.len(), 1);
        assert_eq!(scan.records[0].total_tokens, 10);
    }

    #[test]
    fn owned_scans_mark_edge_only_transcripts_as_truncated() {
        let temporary = tempdir().unwrap();
        let home = temporary.path();
        let transcript = home.join(".claude/projects/repo/claude-large.jsonl");
        create_dir_all(transcript.parent().unwrap()).unwrap();
        let mut contents = String::from(concat!(
            "{\"type\":\"user\",\"sessionId\":\"claude-large\",\"cwd\":\"/srv/large\",\"message\":{\"content\":\"Inspect the large transcript\"}}\n",
            "{\"type\":\"assistant\",\"sessionId\":\"claude-large\",\"requestId\":\"request-first\",\"timestamp\":\"2026-07-18T00:00:01.000Z\",\"message\":{\"id\":\"message-first\",\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}}\n"
        ));
        contents.push_str(&"{}\n".repeat(110_000));
        contents.push_str(
            "{\"type\":\"assistant\",\"sessionId\":\"claude-large\",\"requestId\":\"request-middle\",\"timestamp\":\"2026-07-18T00:00:02.000Z\",\"message\":{\"id\":\"message-middle\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n",
        );
        contents.push_str(&"{}\n".repeat(110_000));
        contents.push_str(
            "{\"type\":\"assistant\",\"sessionId\":\"claude-large\",\"requestId\":\"request-last\",\"timestamp\":\"2026-07-18T00:00:03.000Z\",\"message\":{\"id\":\"message-last\",\"usage\":{\"input_tokens\":4,\"output_tokens\":1}}}\n",
        );
        write(&transcript, contents).unwrap();
        let claims = vec![owned_claim("claude", "claude-large", 1, Some(&transcript))];

        let (history, _) = scan_owned_external_history_with_settings(
            home,
            10,
            &ExternalAgentScanSettings::default(),
            &claims,
        )
        .unwrap();
        let (usage, _) = scan_owned_external_usage_with_settings(
            home,
            0,
            64,
            &ExternalAgentScanSettings::default(),
            &claims,
        )
        .unwrap();

        assert!(history.truncated);
        assert!(usage.truncated);
        assert_eq!(usage.records.len(), 1);
        assert_eq!(usage.records[0].total_tokens, 17);
    }

    #[test]
    fn rejects_unbounded_or_relative_scans() {
        assert_eq!(
            scan_external_history(Path::new("relative"), 1),
            Err(MetadataScanError::InvalidRequest)
        );
        assert_eq!(
            scan_external_history(Path::new("/tmp"), MAX_HISTORY_RECORDS + 1),
            Err(MetadataScanError::InvalidRequest)
        );
        assert_eq!(
            scan_external_usage(Path::new("/tmp"), 0, MAX_USAGE_RECORDS + 1),
            Err(MetadataScanError::InvalidRequest)
        );
    }
}
