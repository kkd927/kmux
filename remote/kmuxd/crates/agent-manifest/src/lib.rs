#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;
use thiserror::Error;

const MANIFEST_BYTES: &str =
    include_str!("../../../../../packages/agents/generated/portable-agent-manifest.json");
const MAX_AGENTS: usize = 128;
const MAX_SOURCES_PER_AGENT: usize = 64;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentManifest {
    pub version: u16,
    pub primitive_version: u16,
    pub agents: Vec<AgentDefinition>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: String,
    pub aliases: Vec<String>,
    pub definition_revision: String,
    pub hook: Option<HookDefinition>,
    pub metadata: Option<MetadataDefinition>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HookDefinition {
    pub path_root: Option<PathRootDefinition>,
    pub relative_path: String,
    pub document: HookDocumentDefinition,
    pub entry: HookEntryDefinition,
    pub marker: String,
    pub managed: Vec<ManagedHook>,
    pub deprecated: Vec<String>,
    pub output_mode: String,
    pub success_response: BTreeMap<String, Value>,
    pub fallback_response: BTreeMap<String, Value>,
    #[serde(default)]
    pub fallback_by_event: BTreeMap<String, BTreeMap<String, Value>>,
    pub session_claim: Option<HookSessionClaimDefinition>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HookDocumentDefinition {
    pub events_path: Vec<String>,
    pub version: Option<HookDocumentVersionDefinition>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookDocumentVersionDefinition {
    pub field: String,
    pub value: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HookEntryDefinition {
    pub command_field: String,
    pub wrapper: Option<HookEntryWrapperDefinition>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookEntryWrapperDefinition {
    pub field: String,
    pub when: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PathRootDefinition {
    pub default_home_relative_path: String,
    pub environment_variable: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HookSessionClaimDefinition {
    pub start_events: Vec<String>,
    pub session_id_fields: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedHook {
    pub event: String,
    pub matcher: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MetadataDefinition {
    pub path_root: Option<PathRootDefinition>,
    pub default_root: String,
    pub sources: Vec<MetadataSourceDefinition>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MetadataSourceDefinition {
    pub role: String,
    pub format: String,
    pub pattern: String,
    pub purposes: Vec<String>,
    #[serde(default = "default_claim_scope")]
    pub claim_scope: String,
    #[serde(default)]
    pub query_plan_ids: Vec<String>,
}

fn default_claim_scope() -> String {
    "session".to_owned()
}

#[derive(Debug, Error, Clone)]
pub enum ManifestError {
    #[error("portable agent manifest JSON is invalid: {0}")]
    Json(String),
    #[error("portable agent manifest invariant failed: {0}")]
    Invalid(&'static str),
}

static MANIFEST: OnceLock<Result<AgentManifest, ManifestError>> = OnceLock::new();

pub fn manifest() -> Result<&'static AgentManifest, ManifestError> {
    MANIFEST
        .get_or_init(|| parse_manifest(MANIFEST_BYTES))
        .as_ref()
        .map_err(Clone::clone)
}

pub fn parse_manifest(input: &str) -> Result<AgentManifest, ManifestError> {
    parse_and_validate(input)
}

pub fn agent(id: &str) -> Result<Option<&'static AgentDefinition>, ManifestError> {
    Ok(manifest()?.agents.iter().find(|agent| agent.id == id))
}

pub fn resolve_agent(id_or_alias: &str) -> Result<Option<&'static AgentDefinition>, ManifestError> {
    Ok(manifest()?.agents.iter().find(|agent| {
        agent.id == id_or_alias || agent.aliases.iter().any(|alias| alias == id_or_alias)
    }))
}

pub fn compatible_agent(
    id: &str,
    definition_revision: &str,
) -> Result<Option<&'static AgentDefinition>, ManifestError> {
    Ok(agent(id)?.filter(|agent| agent.definition_revision == definition_revision))
}

pub fn definition_revisions() -> Result<BTreeMap<String, String>, ManifestError> {
    Ok(manifest()?
        .agents
        .iter()
        .map(|agent| (agent.id.clone(), agent.definition_revision.clone()))
        .collect())
}

fn parse_and_validate(input: &str) -> Result<AgentManifest, ManifestError> {
    let manifest: AgentManifest =
        serde_json::from_str(input).map_err(|error| ManifestError::Json(error.to_string()))?;
    if manifest.version != 2 || manifest.primitive_version != 2 {
        return Err(ManifestError::Invalid("unsupported manifest version"));
    }
    if manifest.agents.is_empty() || manifest.agents.len() > MAX_AGENTS {
        return Err(ManifestError::Invalid("agent count is invalid"));
    }
    let mut ids = BTreeSet::new();
    for agent in &manifest.agents {
        if !valid_agent_id(&agent.id) || !ids.insert(agent.id.clone()) {
            return Err(ManifestError::Invalid("agent id is invalid or duplicated"));
        }
        for alias in &agent.aliases {
            if !valid_agent_id(alias) || !ids.insert(alias.clone()) {
                return Err(ManifestError::Invalid(
                    "agent alias is invalid or duplicated",
                ));
            }
        }
        if agent.definition_revision.is_empty() || agent.definition_revision.len() > 128 {
            return Err(ManifestError::Invalid("definition revision is invalid"));
        }
        if let Some(hook) = &agent.hook {
            validate_hook(hook)?;
        }
        if let Some(metadata) = &agent.metadata {
            validate_metadata(metadata)?;
        }
    }
    Ok(manifest)
}

fn validate_hook(hook: &HookDefinition) -> Result<(), ManifestError> {
    if !valid_path_root(hook.path_root.as_ref())
        || !matches!(hook.output_mode.as_str(), "silent" | "json")
        || !valid_relative_pattern(&hook.relative_path)
        || hook.document.events_path.is_empty()
        || hook.document.events_path.len() > 8
        || hook
            .document
            .events_path
            .iter()
            .any(|component| !valid_hook_token(component))
        || hook
            .document
            .version
            .as_ref()
            .is_some_and(|version| !valid_hook_token(&version.field) || version.value == 0)
        || !matches!(hook.entry.command_field.as_str(), "command" | "bash")
        || hook.entry.wrapper.as_ref().is_some_and(|wrapper| {
            !valid_hook_token(&wrapper.field)
                || !matches!(wrapper.when.as_str(), "always" | "matcher")
        })
        || hook.marker.is_empty()
        || hook.managed.len() > 64
    {
        return Err(ManifestError::Invalid("hook definition is invalid"));
    }
    if let Some(claim) = &hook.session_claim
        && (claim.start_events.is_empty()
            || claim.start_events.len() > 16
            || claim.session_id_fields.is_empty()
            || claim.session_id_fields.len() > 16
            || claim
                .start_events
                .iter()
                .any(|event| !valid_hook_token(event))
            || claim
                .session_id_fields
                .iter()
                .any(|field| !valid_hook_token(field))
            || claim.start_events.iter().any(|event| {
                !hook
                    .managed
                    .iter()
                    .any(|managed| managed.event.eq_ignore_ascii_case(event))
            }))
    {
        return Err(ManifestError::Invalid("hook session claim is invalid"));
    }
    Ok(())
}

fn valid_hook_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn validate_metadata(metadata: &MetadataDefinition) -> Result<(), ManifestError> {
    if !valid_path_root(metadata.path_root.as_ref())
        || !valid_relative_pattern(&metadata.default_root)
        || metadata.sources.len() > MAX_SOURCES_PER_AGENT
    {
        return Err(ManifestError::Invalid("metadata definition is invalid"));
    }
    let mut roles = BTreeSet::new();
    for source in &metadata.sources {
        if !valid_role(&source.role)
            || !roles.insert(source.role.clone())
            || !matches!(source.format.as_str(), "jsonl" | "sqlite")
            || !matches!(source.claim_scope.as_str(), "session" | "agent")
            || !valid_relative_pattern(&source.pattern)
        {
            return Err(ManifestError::Invalid("metadata source is invalid"));
        }
    }
    Ok(())
}

fn valid_path_root(root: Option<&PathRootDefinition>) -> bool {
    root.is_none_or(|root| {
        valid_relative_pattern(&root.default_home_relative_path)
            && !root.environment_variable.is_empty()
            && root.environment_variable.len() <= 64
            && root
                .environment_variable
                .bytes()
                .enumerate()
                .all(|(index, byte)| {
                    byte.is_ascii_uppercase()
                        || byte == b'_'
                        || (index > 0 && byte.is_ascii_digit())
                })
    })
}

fn valid_agent_id(value: &str) -> bool {
    !value.is_empty()
        && value != "unknown"
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
}

fn valid_role(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._/-".contains(&byte)
        })
}

fn valid_relative_pattern(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.starts_with('\\')
        && value.as_bytes().get(1).is_none_or(|byte| *byte != b':')
        && value
            .split(['/', '\\'])
            .all(|component| !component.is_empty() && component != "." && component != "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._*/-".contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_manifest_is_valid_and_open_ended() {
        let manifest = manifest().expect("embedded manifest");
        assert!(manifest.agents.iter().any(|agent| agent.id == "claude"));
        assert!(agent("synthetic-future").expect("lookup").is_none());
    }

    #[test]
    fn ordinary_fixture_uses_existing_primitives_without_a_fixed_agent_set() {
        let fixture =
            include_str!("../../../../../packages/agents/fixtures/ordinary-agent-manifest.json");
        let parsed = parse_and_validate(fixture).expect("fixture manifest");
        assert_eq!(parsed.agents[0].id, "fixture-nebula");
        assert_eq!(parsed.agents[1].id, "fixture-orbit");
    }

    #[test]
    fn rejects_traversal_patterns_during_initialization() {
        let fixture = MANIFEST_BYTES.replace("**/*.jsonl", "../*.jsonl");
        assert!(matches!(
            parse_and_validate(&fixture),
            Err(ManifestError::Invalid(_))
        ));
    }
}
