#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::env;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;
use thiserror::Error;

pub const MAX_METADATA_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_HISTORY_RECORDS: usize = 100;
pub const MAX_USAGE_RECORDS: usize = 64;
const MAX_HISTORY_CANDIDATES: usize = 4_096;
const MAX_HISTORY_DIRECTORIES: usize = 4_096;
const MAX_HISTORY_ENTRIES: usize = 65_536;
const MAX_HISTORY_EDGE_BYTES: usize = 256 * 1024;
const MAX_TITLE_CHARS: usize = 96;
const MAX_PREVIEW_CHARS: usize = 220;
const MAX_MODEL_CHARS: usize = 128;
const MAX_SESSION_ID_BYTES: usize = 4 * 1024;
const MAX_PATH_BYTES: usize = 32 * 1024;

#[derive(Debug, Error, PartialEq, Eq)]
#[error("metadata chunk exceeds {MAX_METADATA_CHUNK_BYTES} bytes")]
pub struct MetadataChunkTooLarge;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MetadataScanError {
    #[error("history scan root or bound is invalid")]
    InvalidRequest,
    #[error("history inventory exceeds its hard bound")]
    InventoryLimit,
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

#[derive(Default)]
struct ParsedRecord {
    session_id: Option<String>,
    cwd: Option<String>,
    title: Option<String>,
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

pub fn scan_external_history(
    home: &Path,
    max_records: usize,
) -> Result<Vec<ExternalHistoryRecord>, MetadataScanError> {
    if !home.is_absolute() || max_records == 0 || max_records > MAX_HISTORY_RECORDS {
        return Err(MetadataScanError::InvalidRequest);
    }
    let mut by_identity = BTreeMap::<String, ExternalHistoryRecord>::new();
    scan_jsonl_vendor(
        "codex",
        "codex",
        &home.join(".codex/sessions"),
        |path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        },
        max_records,
        &mut by_identity,
    )?;
    scan_jsonl_vendor(
        "claude",
        "claude",
        &home.join(".claude/projects"),
        |path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"),
        max_records,
        &mut by_identity,
    )?;
    scan_antigravity(
        &home.join(".gemini/antigravity-cli/history.jsonl"),
        max_records,
        &mut by_identity,
    );

    let mut records = by_identity.into_values().collect::<Vec<_>>();
    records.sort_by(|left, right| {
        right
            .updated_at_unix_ms
            .cmp(&left.updated_at_unix_ms)
            .then_with(|| left.vendor.cmp(right.vendor))
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    records.truncate(max_records);
    Ok(records)
}

pub fn scan_external_usage(
    home: &Path,
    start_at_unix_ms: u64,
    max_records: usize,
) -> Result<ExternalUsageScan, MetadataScanError> {
    if !home.is_absolute() || max_records == 0 || max_records > MAX_USAGE_RECORDS {
        return Err(MetadataScanError::InvalidRequest);
    }
    let mut records = BTreeMap::<String, ExternalUsageRecord>::new();
    let mut truncated = false;
    let candidate_limit = max_records.saturating_mul(8);

    let codex_candidates = collect_candidates(&home.join(".codex/sessions"), |path| {
        path.file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
    })?;
    truncated |= codex_candidates.len() > candidate_limit;
    for candidate in codex_candidates.into_iter().take(candidate_limit) {
        truncated |= candidate.size > (MAX_HISTORY_EDGE_BYTES * 2) as u64;
        if let Some(record) = parse_codex_usage(&candidate, start_at_unix_ms) {
            upsert_usage_record(&mut records, record);
        }
    }

    let mut claude_candidates = collect_candidates(&home.join(".claude/projects"), |path| {
        path.extension().and_then(|value| value.to_str()) == Some("jsonl")
    })?;
    truncated |= claude_candidates.len() > candidate_limit;
    claude_candidates.truncate(candidate_limit);
    claude_candidates.sort_by(|left, right| {
        is_claude_subagent_path(&left.path)
            .cmp(&is_claude_subagent_path(&right.path))
            .then_with(|| right.modified_unix_ms.cmp(&left.modified_unix_ms))
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut seen_claude_requests = BTreeSet::new();
    for candidate in claude_candidates {
        truncated |= candidate.size > (MAX_HISTORY_EDGE_BYTES * 2) as u64;
        if let Some(record) =
            parse_claude_usage(&candidate, start_at_unix_ms, &mut seen_claude_requests)
        {
            upsert_usage_record(&mut records, record);
        }
    }

    let antigravity_workspaces =
        antigravity_workspace_index(&home.join(".gemini/antigravity-cli/history.jsonl"));
    let antigravity_candidates =
        collect_candidates(&home.join(".gemini/antigravity-cli/brain"), |path| {
            path.file_name().and_then(|value| value.to_str()) == Some("transcript.jsonl")
        })?;
    truncated |= antigravity_candidates.len() > candidate_limit;
    for candidate in antigravity_candidates.into_iter().take(candidate_limit) {
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
                    cache_write_tokens_known: true,
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
                    cache_write_tokens_known: true,
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
}

fn parse_claude_usage(
    candidate: &CandidateFile,
    start_at_unix_ms: u64,
    seen_requests: &mut BTreeSet<String>,
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
        session_id = session_id.or_else(|| {
            first_string(
                object
                    .get("sessionId")
                    .or_else(|| object.get("session_id"))
                    .or_else(|| object.get("conversationId")),
            )
        });
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
    let session_id = antigravity_conversation_id(&candidate.path)?;
    let mut aggregate = TokenMetrics {
        cache_write_tokens_known: true,
        ..TokenMetrics::default()
    };
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
        let Some(content) = extract_text(object.get("content"), 0) else {
            continue;
        };
        let tokens = u64::try_from(content.chars().count().saturating_add(3) / 4)
            .unwrap_or(u64::MAX)
            .max(1);
        let source = object.get("source").and_then(Value::as_str).unwrap_or("");
        let record_type = object.get("type").and_then(Value::as_str).unwrap_or("");
        if source.contains("USER") || record_type.contains("USER") {
            aggregate.input_tokens = aggregate.input_tokens.saturating_add(tokens);
        } else {
            aggregate.output_tokens = aggregate.output_tokens.saturating_add(tokens);
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
    root: &Path,
    include: impl Fn(&Path) -> bool,
    max_records: usize,
    records: &mut BTreeMap<String, ExternalHistoryRecord>,
) -> Result<(), MetadataScanError> {
    let candidates = collect_candidates(root, include)?;
    for candidate in candidates.into_iter().take(max_records.saturating_mul(4)) {
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
                title: sanitize_text(parsed.title, MAX_TITLE_CHARS),
                recent_conversation: sanitize_text(parsed.recent_conversation, MAX_PREVIEW_CHARS),
                model: sanitize_text(parsed.model, MAX_MODEL_CHARS),
            },
        );
    }
    Ok(())
}

fn scan_antigravity(
    path: &Path,
    max_records: usize,
    records: &mut BTreeMap<String, ExternalHistoryRecord>,
) {
    let Some(candidate) = candidate_file(path) else {
        return;
    };
    for value in parse_jsonl_edges(&candidate) {
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
        upsert_record(
            records,
            ExternalHistoryRecord {
                vendor: "antigravity",
                session_id,
                updated_at_unix_ms: candidate.modified_unix_ms,
                can_resume: command_available("agy"),
                cwd: sanitize_absolute_path(first_string(
                    object.get("workspace").or_else(|| object.get("cwd")),
                )),
                title: sanitize_text(
                    first_string(object.get("title").or_else(|| object.get("summary"))),
                    MAX_TITLE_CHARS,
                ),
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
        if records
            .values()
            .filter(|record| record.vendor == "antigravity")
            .count()
            >= max_records
        {
            break;
        }
    }
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
                parsed.recent_conversation = extract_text(payload.get("message"), 0);
                if parsed.title.is_none()
                    && payload.get("type").and_then(Value::as_str) == Some("user_message")
                {
                    parsed.title = parsed.recent_conversation.clone();
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
        if matches!(role, Some("user" | "human" | "assistant")) {
            let text = extract_text(
                object
                    .get("message")
                    .and_then(|value| value.get("content"))
                    .or_else(|| object.get("content"))
                    .or_else(|| object.get("message")),
                0,
            );
            if text.is_some() {
                parsed.recent_conversation = text.clone();
                if parsed.title.is_none() && matches!(role, Some("user" | "human")) {
                    parsed.title = text;
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

fn collect_candidates(
    root: &Path,
    include: impl Fn(&Path) -> bool,
) -> Result<Vec<CandidateFile>, MetadataScanError> {
    let Ok(root_metadata) = fs::symlink_metadata(root) else {
        return Ok(Vec::new());
    };
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Ok(Vec::new());
    }
    let mut directories = VecDeque::from([root.to_owned()]);
    let mut visited_directories = 0_usize;
    let mut visited_entries = 0_usize;
    let mut candidates = Vec::new();
    while let Some(directory) = directories.pop_front() {
        visited_directories = visited_directories.saturating_add(1);
        if visited_directories > MAX_HISTORY_DIRECTORIES {
            return Err(MetadataScanError::InventoryLimit);
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited_entries = visited_entries.saturating_add(1);
            if visited_entries > MAX_HISTORY_ENTRIES {
                return Err(MetadataScanError::InventoryLimit);
            }
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if visited_directories.saturating_add(directories.len()) >= MAX_HISTORY_DIRECTORIES
                {
                    return Err(MetadataScanError::InventoryLimit);
                }
                directories.push_back(path);
                continue;
            }
            if metadata.is_file() && include(&path) {
                if let Some(candidate) = candidate_from_metadata(path, &metadata) {
                    candidates.push(candidate);
                }
                if candidates.len() > MAX_HISTORY_CANDIDATES {
                    return Err(MetadataScanError::InventoryLimit);
                }
            }
        }
    }
    candidates.sort_by(|left, right| {
        right
            .modified_unix_ms
            .cmp(&left.modified_unix_ms)
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(candidates)
}

fn candidate_file(path: &Path) -> Option<CandidateFile> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    candidate_from_metadata(path.to_owned(), &metadata)
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
        cache_write_tokens_known: object.keys().any(|key| {
            matches!(
                key.as_str(),
                "cache_creation_input_tokens"
                    | "cacheCreationInputTokens"
                    | "cache_creation_tokens"
                    | "cacheCreationTokens"
                    | "cache_write_tokens"
                    | "cacheWriteTokens"
            )
        }),
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

fn antigravity_workspace_index(path: &Path) -> BTreeMap<String, String> {
    let mut workspaces = BTreeMap::new();
    let Some(candidate) = candidate_file(path) else {
        return workspaces;
    };
    for value in parse_jsonl_edges(&candidate) {
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
        .is_none_or(|existing| candidate.updated_at_unix_ms >= existing.updated_at_unix_ms)
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
    let Some(path_value) = env::var_os("PATH") else {
        return false;
    };
    command_available_in_path(command, &path_value)
}

fn command_available_in_path(command: &str, path_value: &OsStr) -> bool {
    env::split_paths(path_value).any(|directory| {
        let path = directory.join(command);
        fs::metadata(path)
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    })
}

#[cfg(test)]
mod tests {
    use std::fs::{Permissions, create_dir_all, set_permissions, write};
    use std::os::unix::fs::symlink;

    use tempfile::tempdir;

    use super::*;

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
        assert_eq!(records.len(), 3);
        assert!(records.iter().any(|record| {
            record.vendor == "codex"
                && record.session_id == "codex-1"
                && record.cwd.as_deref() == Some("/srv/repo")
                && record.title.as_deref() == Some("ship it")
        }));
        assert!(
            records
                .iter()
                .any(|record| record.vendor == "claude" && record.session_id == "claude-1")
        );
        assert!(
            records
                .iter()
                .any(|record| { record.vendor == "antigravity" && record.session_id == "agy-1" })
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
    fn rejects_history_inventories_that_overfill_the_directory_queue() {
        let temporary = tempdir().unwrap();
        let root = temporary.path().join("inventory");
        create_dir_all(&root).unwrap();
        for index in 0..MAX_HISTORY_DIRECTORIES {
            create_dir_all(root.join(format!("directory-{index}"))).unwrap();
        }

        assert!(matches!(
            collect_candidates(&root, |_| true),
            Err(MetadataScanError::InventoryLimit)
        ));
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
