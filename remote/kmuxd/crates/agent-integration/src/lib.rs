#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use kmux_agent_manifest::manifest as agent_manifest;
use nix::fcntl::OFlag;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const CONTRACT_BYTES: &str =
    include_str!("../../../../../packages/agent-integration/contract.json");
const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const LOCK_WAIT: Duration = Duration::from_secs(5);
const LOCK_STALE: Duration = Duration::from_secs(30);

#[derive(Debug, Error)]
pub enum IntegrationError {
    #[error("agent integration I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("agent integration JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("agent integration contract is invalid: {0}")]
    Invalid(String),
    #[error("agent integration settings cannot be safely merged: {0}")]
    UnsupportedSettings(String),
    #[error("agent integration settings lock timed out")]
    LockTimedOut,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    contract_version: u16,
    command_template: String,
    command_wrappers: Vec<CommandWrapperContract>,
    vendors: BTreeMap<String, VendorContract>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandWrapperContract {
    agent_id: String,
    executable: String,
    home_environment_variable: String,
    default_home_relative_path: String,
    integration_relative_path: String,
    integration_contract_marker: String,
    integration_managed_marker: String,
    legacy_hooks_feature: String,
    current_hooks_feature: String,
    current_hooks_feature_minor: u16,
    notification_method: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VendorContract {
    path_root: Option<PathRootContract>,
    relative_path: String,
    document: HookDocumentContract,
    entry: HookEntryContract,
    marker: String,
    managed: Vec<HookSpec>,
    #[allow(dead_code)]
    deprecated: Vec<String>,
    output_mode: String,
    fallback: Option<String>,
    fallback_by_event: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookDocumentContract {
    events_path: Vec<String>,
    version: Option<HookDocumentVersionContract>,
}

#[derive(Clone, Debug, Deserialize)]
struct HookDocumentVersionContract {
    field: String,
    value: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookEntryContract {
    command_field: String,
    wrapper: Option<HookEntryWrapperContract>,
}

#[derive(Clone, Debug, Deserialize)]
struct HookEntryWrapperContract {
    field: String,
    when: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathRootContract {
    default_home_relative_path: String,
    environment_variable: String,
}

#[derive(Clone, Debug, Deserialize)]
struct HookSpec {
    event: String,
    matcher: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VendorStatus {
    Changed,
    Current,
    Degraded,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VendorReport {
    pub vendor: String,
    pub path: PathBuf,
    pub status: VendorStatus,
    pub contract_version: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnsureReport {
    pub contract_version: u16,
    pub agent_bin_dir: PathBuf,
    pub vendors: Vec<VendorReport>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub contract_version: u16,
    pub helper_ready: bool,
    pub transport: &'static str,
    pub transport_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport_reason: Option<&'static str>,
    pub vendors: Vec<VendorReport>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotReport {
    pub contract_version: u16,
    pub agent_bin_dir: PathBuf,
    pub vendors: Vec<VendorSnapshot>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VendorSnapshot {
    pub vendor: String,
    pub path: PathBuf,
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlannedApplyRequest {
    pub operation_id: String,
    pub contract_version: u16,
    pub vendor: String,
    pub path: PathBuf,
    pub expected: PlannedApplyExpected,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "lowercase", deny_unknown_fields)]
pub enum PlannedApplyExpected {
    Absent,
    Present { sha256: String },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedApplyReport {
    pub operation_id: String,
    pub contract_version: u16,
    pub vendor: String,
    pub path: PathBuf,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

pub fn ensure_all(home: &Path, agent_bin_dir: &Path) -> Result<EnsureReport, IntegrationError> {
    ensure_all_with_codex_home(home, agent_bin_dir, None)
}

pub fn ensure_all_with_codex_home(
    home: &Path,
    agent_bin_dir: &Path,
    codex_home: Option<&Path>,
) -> Result<EnsureReport, IntegrationError> {
    let environment = codex_home_environment(codex_home);
    ensure_all_with_environment(home, agent_bin_dir, Some(&environment))
}

pub fn ensure_all_with_environment(
    home: &Path,
    agent_bin_dir: &Path,
    environment: Option<&BTreeMap<String, String>>,
) -> Result<EnsureReport, IntegrationError> {
    require_absolute(home, "home")?;
    require_absolute(agent_bin_dir, "agent bin directory")?;
    let contract = contract()?;
    let vendors = contract
        .vendors
        .iter()
        .map(|(vendor, definition)| {
            ensure_vendor_file(
                vendor_settings_path(home, environment, definition),
                vendor,
                &contract,
            )
        })
        .collect();
    Ok(EnsureReport {
        contract_version: contract.contract_version,
        agent_bin_dir: agent_bin_dir.to_path_buf(),
        vendors,
    })
}

pub fn ensure_vendor_path(vendor: &str, path: &Path) -> Result<VendorReport, IntegrationError> {
    require_absolute(path, "agent integration settings path")?;
    let contract = contract()?;
    if !contract.vendors.contains_key(vendor) {
        return Err(IntegrationError::Invalid(format!(
            "unknown vendor {vendor}"
        )));
    }
    Ok(ensure_vendor_file(path.to_path_buf(), vendor, &contract))
}

pub fn snapshot_all_with_codex_home(
    home: &Path,
    agent_bin_dir: &Path,
    codex_home: Option<&Path>,
) -> Result<SnapshotReport, IntegrationError> {
    let environment = codex_home_environment(codex_home);
    snapshot_all_with_environment(home, agent_bin_dir, Some(&environment))
}

pub fn snapshot_all_with_environment(
    home: &Path,
    agent_bin_dir: &Path,
    environment: Option<&BTreeMap<String, String>>,
) -> Result<SnapshotReport, IntegrationError> {
    require_absolute(home, "home")?;
    require_absolute(agent_bin_dir, "agent bin directory")?;
    let contract = contract()?;
    let vendors = contract
        .vendors
        .iter()
        .map(|(vendor, definition)| {
            let root = settings_root(home, environment, definition);
            let path = root.join(&definition.relative_path);
            match snapshot_vendor_path(vendor, &path, &root) {
                Ok(snapshot) => snapshot,
                Err(error) => VendorSnapshot {
                    vendor: vendor.clone(),
                    path,
                    state: "degraded",
                    sha256: None,
                    content: None,
                    warning: Some(bounded_warning(&error.to_string())),
                },
            }
        })
        .collect();
    Ok(SnapshotReport {
        contract_version: contract.contract_version,
        agent_bin_dir: agent_bin_dir.to_path_buf(),
        vendors,
    })
}

pub fn apply_planned_with_codex_home(
    home: &Path,
    codex_home: Option<&Path>,
    request: &PlannedApplyRequest,
) -> Result<PlannedApplyReport, IntegrationError> {
    let environment = codex_home_environment(codex_home);
    apply_planned_with_environment(home, Some(&environment), request)
}

pub fn apply_planned_with_environment(
    home: &Path,
    environment: Option<&BTreeMap<String, String>>,
    request: &PlannedApplyRequest,
) -> Result<PlannedApplyReport, IntegrationError> {
    require_absolute(home, "home")?;
    if request.operation_id.is_empty()
        || request.operation_id.len() > 256
        || request.operation_id.chars().any(char::is_control)
        || request.vendor.is_empty()
        || request.content.len() as u64 > MAX_CONFIG_BYTES
    {
        return Err(IntegrationError::Invalid(
            "planned apply request is invalid".to_owned(),
        ));
    }
    let contract = contract()?;
    if request.contract_version != contract.contract_version {
        return Err(IntegrationError::Invalid(
            "planned apply contract version is unsupported".to_owned(),
        ));
    }
    let definition = contract
        .vendors
        .get(&request.vendor)
        .ok_or_else(|| IntegrationError::Invalid("planned apply vendor is invalid".to_owned()))?;
    let root = settings_root(home, environment, definition);
    let expected_path = root.join(&definition.relative_path);
    if request.path != expected_path || !request.path.is_absolute() {
        return Err(IntegrationError::Invalid(
            "planned apply path is outside its vendor contract".to_owned(),
        ));
    }
    if let PlannedApplyExpected::Present { sha256 } = &request.expected
        && (sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(IntegrationError::Invalid(
            "planned apply expected digest is invalid".to_owned(),
        ));
    }
    let desired: Value = serde_json::from_str(&request.content)?;
    if !desired.is_object() {
        return Err(IntegrationError::UnsupportedSettings(
            "planned settings must contain a JSON object".to_owned(),
        ));
    }
    ensure_safe_settings_parent(&root, &request.path)?;
    with_lock(&request.path, || {
        ensure_safe_settings_parent(&root, &request.path)?;
        let current = read_settings_bytes(&request.path, &root)?;
        let desired_bytes = request.content.as_bytes();
        if current.as_deref() == Some(desired_bytes) {
            return Ok(PlannedApplyReport {
                operation_id: request.operation_id.clone(),
                contract_version: contract.contract_version,
                vendor: request.vendor.clone(),
                path: request.path.clone(),
                status: "current",
                sha256: Some(hash_bytes(desired_bytes)),
            });
        }
        let matches = match (&request.expected, current.as_ref()) {
            (PlannedApplyExpected::Absent, None) => true,
            (PlannedApplyExpected::Present { sha256 }, Some(bytes)) => {
                hash_bytes(bytes) == sha256.to_ascii_lowercase()
            }
            _ => false,
        };
        if !matches {
            return Ok(PlannedApplyReport {
                operation_id: request.operation_id.clone(),
                contract_version: contract.contract_version,
                vendor: request.vendor.clone(),
                path: request.path.clone(),
                status: "conflict",
                sha256: current.as_deref().map(hash_bytes),
            });
        }
        if let Ok(metadata) = fs::symlink_metadata(&request.path)
            && metadata.mode() & 0o200 == 0
        {
            return Err(IntegrationError::Invalid(format!(
                "{} is not user-writable",
                request.path.display()
            )));
        }
        write_content_atomic(&request.path, desired_bytes)?;
        Ok(PlannedApplyReport {
            operation_id: request.operation_id.clone(),
            contract_version: contract.contract_version,
            vendor: request.vendor.clone(),
            path: request.path.clone(),
            status: "changed",
            sha256: Some(hash_bytes(desired_bytes)),
        })
    })
}

fn snapshot_vendor_path(
    vendor: &str,
    path: &Path,
    root: &Path,
) -> Result<VendorSnapshot, IntegrationError> {
    let current = read_settings_bytes(path, root)?;
    Ok(match current {
        Some(bytes) => {
            let sha256 = hash_bytes(&bytes);
            let content = String::from_utf8(bytes).map_err(|_| {
                IntegrationError::Invalid("settings file is not valid UTF-8".to_owned())
            })?;
            if content
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
            {
                return Err(IntegrationError::Invalid(
                    "settings file contains unsupported control characters".to_owned(),
                ));
            }
            VendorSnapshot {
                vendor: vendor.to_owned(),
                path: path.to_path_buf(),
                state: "present",
                sha256: Some(sha256),
                content: Some(content),
                warning: None,
            }
        }
        None => VendorSnapshot {
            vendor: vendor.to_owned(),
            path: path.to_path_buf(),
            state: "absent",
            sha256: None,
            content: None,
            warning: None,
        },
    })
}

fn settings_root(
    home: &Path,
    environment: Option<&BTreeMap<String, String>>,
    definition: &VendorContract,
) -> PathBuf {
    let Some(path_root) = &definition.path_root else {
        return home.to_path_buf();
    };
    environment
        .and_then(|environment| environment.get(&path_root.environment_variable))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(&path_root.default_home_relative_path))
}

fn read_settings_bytes(path: &Path, root: &Path) -> Result<Option<Vec<u8>>, IntegrationError> {
    if !validate_settings_parent(root, path, false)? {
        return Ok(None);
    }
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(OFlag::O_NOFOLLOW.bits())
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file()
        || metadata.uid() != nix::unistd::geteuid().as_raw()
        || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err(IntegrationError::Invalid(format!(
            "{} is not a safe bounded owned file",
            path.display()
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(IntegrationError::Invalid(
            "settings file is oversized".to_owned(),
        ));
    }
    Ok(Some(bytes))
}

fn ensure_safe_settings_parent(root: &Path, path: &Path) -> Result<(), IntegrationError> {
    validate_settings_parent(root, path, true).map(|_| ())
}

fn validate_settings_parent(
    root: &Path,
    path: &Path,
    create: bool,
) -> Result<bool, IntegrationError> {
    require_absolute(root, "settings root")?;
    require_absolute(path, "settings path")?;
    let parent = path
        .parent()
        .ok_or_else(|| IntegrationError::Invalid("settings path has no parent".to_owned()))?;
    let relative = parent.strip_prefix(root).map_err(|_| {
        IntegrationError::Invalid("settings path is outside its settings root".to_owned())
    })?;
    if relative
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(IntegrationError::Invalid(
            "settings path contains an invalid component".to_owned(),
        ));
    }

    if !ensure_or_validate_settings_root(root, create)? {
        return Ok(false);
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) => validate_owned_directory(&current, &metadata)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound && !create => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
                fs::set_permissions(&current, fs::Permissions::from_mode(0o700))?;
                validate_owned_directory(&current, &fs::symlink_metadata(&current)?)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(true)
}

fn ensure_or_validate_settings_root(root: &Path, create: bool) -> Result<bool, IntegrationError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) => {
            validate_owned_directory(root, &metadata)?;
            return Ok(true);
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound && !create => return Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let mut missing = Vec::new();
    let mut ancestor = root;
    loop {
        missing.push(
            ancestor
                .file_name()
                .ok_or_else(|| IntegrationError::Invalid("settings root is invalid".to_owned()))?
                .to_owned(),
        );
        ancestor = ancestor.parent().ok_or_else(|| {
            IntegrationError::Invalid("settings root has no existing ancestor".to_owned())
        })?;
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                    return Err(IntegrationError::Invalid(format!(
                        "{} is not a safe directory",
                        ancestor.display()
                    )));
                }
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let mut current = ancestor.to_path_buf();
    for component in missing.iter().rev() {
        current.push(component);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        fs::set_permissions(&current, fs::Permissions::from_mode(0o700))?;
        validate_owned_directory(&current, &fs::symlink_metadata(&current)?)?;
    }
    Ok(true)
}

fn validate_owned_directory(path: &Path, metadata: &fs::Metadata) -> Result<(), IntegrationError> {
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != nix::unistd::geteuid().as_raw()
    {
        return Err(IntegrationError::Invalid(format!(
            "{} is not a safe owned directory",
            path.display()
        )));
    }
    Ok(())
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn bounded_warning(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars().filter(|character| !character.is_control()) {
        if output.len().saturating_add(character.len_utf8()) > 4 * 1024 {
            break;
        }
        output.push(character);
    }
    if output.is_empty() {
        "agent integration operation failed".to_owned()
    } else {
        output
    }
}

fn write_content_atomic(path: &Path, bytes: &[u8]) -> Result<(), IntegrationError> {
    let parent = path
        .parent()
        .ok_or_else(|| IntegrationError::Invalid("settings path has no parent".to_owned()))?;
    let temporary = parent.join(format!(".agent-integration-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(OFlag::O_NOFOLLOW.bits())
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

pub fn doctor(home: &Path, agent_bin_dir: &Path) -> Result<DoctorReport, IntegrationError> {
    doctor_with_codex_home(home, agent_bin_dir, None)
}

pub fn doctor_with_codex_home(
    home: &Path,
    agent_bin_dir: &Path,
    codex_home: Option<&Path>,
) -> Result<DoctorReport, IntegrationError> {
    let environment = codex_home_environment(codex_home);
    doctor_with_environment(home, agent_bin_dir, Some(&environment))
}

pub fn doctor_with_environment(
    home: &Path,
    agent_bin_dir: &Path,
    environment: Option<&BTreeMap<String, String>>,
) -> Result<DoctorReport, IntegrationError> {
    require_absolute(home, "home")?;
    require_absolute(agent_bin_dir, "agent bin directory")?;
    let contract = contract()?;
    let helper_ready = executable_regular_file(&agent_bin_dir.join("kmux-agent-hook"));
    let (transport_ready, transport_reason) = remote_transport_readiness();
    let mut vendors = Vec::new();
    for (vendor, definition) in &contract.vendors {
        let path = vendor_settings_path(home, environment, definition);
        let status = match read_config(&path) {
            Ok(Some(value)) => match merge_value(vendor, value.clone(), &contract) {
                Ok(merged) if value == merged => VendorReport {
                    vendor: vendor.clone(),
                    path,
                    status: VendorStatus::Current,
                    contract_version: contract.contract_version,
                    warning: None,
                },
                Ok(_) => degraded(
                    vendor,
                    path,
                    contract.contract_version,
                    "managed hooks are stale",
                ),
                Err(error) => degraded(vendor, path, contract.contract_version, &error.to_string()),
            },
            Ok(None) => degraded(
                vendor,
                path,
                contract.contract_version,
                "settings file is missing",
            ),
            Err(error) => degraded(vendor, path, contract.contract_version, &error.to_string()),
        };
        vendors.push(status);
    }
    Ok(DoctorReport {
        contract_version: contract.contract_version,
        helper_ready,
        transport: "remote",
        transport_ready,
        transport_reason,
        vendors,
    })
}

fn vendor_settings_path(
    home: &Path,
    environment: Option<&BTreeMap<String, String>>,
    definition: &VendorContract,
) -> PathBuf {
    settings_root(home, environment, definition).join(&definition.relative_path)
}

fn codex_home_environment(codex_home: Option<&Path>) -> BTreeMap<String, String> {
    codex_home
        .filter(|path| path.is_absolute())
        .map(|path| {
            BTreeMap::from([("CODEX_HOME".to_owned(), path.to_string_lossy().into_owned())])
        })
        .unwrap_or_default()
}

fn remote_transport_readiness() -> (bool, Option<&'static str>) {
    let explicit = std::env::var("KMUX_AGENT_HOOK_TRANSPORT").unwrap_or_default();
    let socket_present =
        std::env::var("KMUX_SOCKET_PATH").is_ok_and(|value| !value.trim().is_empty());
    let endpoint = std::env::var("KMUX_AGENT_HOOK_ENDPOINT")
        .unwrap_or_default()
        .trim()
        .to_owned();
    let token = std::env::var("KMUX_AUTH_TOKEN")
        .unwrap_or_default()
        .trim()
        .to_owned();
    let remote_complete = Path::new(&endpoint).is_absolute() && !token.is_empty();
    match explicit.trim() {
        "remote" if remote_complete => (true, None),
        "remote" => (false, Some("remote-tuple-incomplete")),
        "" if remote_complete && !socket_present => (true, None),
        "" if endpoint.is_empty() && token.is_empty() && !socket_present => {
            (false, Some("transport-missing"))
        }
        "" if remote_complete => (false, Some("transport-ambiguous")),
        "" => (false, Some("transport-tuple-incomplete")),
        _ => (false, Some("transport-invalid")),
    }
}

pub fn merge_config(vendor: &str, input: Value) -> Result<Value, IntegrationError> {
    let contract = contract()?;
    merge_value(vendor, input, &contract)
}

pub fn contract_version() -> Result<u16, IntegrationError> {
    Ok(contract()?.contract_version)
}

pub fn ensure_runtime_shims(
    install_root: &Path,
    executable: &Path,
    executable_generation: &str,
) -> Result<PathBuf, IntegrationError> {
    require_absolute(install_root, "install root")?;
    require_absolute(executable, "runtime executable")?;
    if executable_generation.len() != 64
        || !executable_generation
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(IntegrationError::Invalid(
            "runtime executable generation is invalid".to_owned(),
        ));
    }
    let directory = install_root
        .join("shims")
        .join(&executable_generation[..16]);
    ensure_private_directory(&directory)?;
    let quoted = quote_posix_word(&executable.to_string_lossy());
    let cli = format!("#!/bin/sh\nexec {quoted} cli \"$@\"\n");
    let hook = remote_hook_script(&quoted)?;
    let contract = contract()?;
    write_executable_atomic(&directory.join("kmux"), cli.as_bytes())?;
    write_executable_atomic(&directory.join("kmux-agent-hook"), hook.as_bytes())?;
    for policy in &contract.command_wrappers {
        let wrapper = version_gated_agent_wrapper_script(policy);
        write_executable_atomic(&directory.join(&policy.executable), wrapper.as_bytes())?;
    }
    write_shell_integration_files(&directory)?;
    Ok(directory)
}

pub fn prepare_shell_environment(
    shell: Option<&str>,
    env: &mut BTreeMap<String, String>,
    agent_bin_dir: &Path,
) -> Result<(), IntegrationError> {
    require_absolute(agent_bin_dir, "agent bin directory")?;
    for key in [
        "KMUX_ORIGINAL_HOME",
        "KMUX_ORIGINAL_HOME_PRESENT",
        "KMUX_ORIGINAL_ZDOTDIR",
        "KMUX_ORIGINAL_ZDOTDIR_PRESENT",
        "KMUX_ORIGINAL_XDG_CONFIG_HOME",
        "KMUX_ORIGINAL_XDG_CONFIG_HOME_PRESENT",
    ] {
        env.remove(key);
    }
    let Some(shell_name) = shell
        .and_then(|value| Path::new(value).file_name())
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
    else {
        return Ok(());
    };
    if !matches!(shell_name.as_str(), "bash" | "zsh" | "fish") {
        return Ok(());
    }
    let Some(home) = env
        .get("HOME")
        .cloned()
        .or_else(|| std::env::var("HOME").ok())
        .filter(|value| Path::new(value).is_absolute())
    else {
        return Ok(());
    };
    match shell_name.as_str() {
        "bash" => {
            preserve_environment_value(env, "HOME", "KMUX_ORIGINAL_HOME", &home);
            env.insert(
                "HOME".to_owned(),
                agent_bin_dir
                    .join("shell/bash")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        "zsh" => {
            let original = env
                .get("ZDOTDIR")
                .cloned()
                .filter(|value| Path::new(value).is_absolute())
                .unwrap_or_else(|| home.clone());
            preserve_environment_value(env, "ZDOTDIR", "KMUX_ORIGINAL_ZDOTDIR", &original);
            env.insert(
                "ZDOTDIR".to_owned(),
                agent_bin_dir
                    .join("shell/zsh")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        "fish" => {
            let original = env
                .get("XDG_CONFIG_HOME")
                .cloned()
                .filter(|value| Path::new(value).is_absolute())
                .unwrap_or_else(|| {
                    Path::new(&home)
                        .join(".config")
                        .to_string_lossy()
                        .into_owned()
                });
            preserve_environment_value(
                env,
                "XDG_CONFIG_HOME",
                "KMUX_ORIGINAL_XDG_CONFIG_HOME",
                &original,
            );
            env.insert(
                "XDG_CONFIG_HOME".to_owned(),
                agent_bin_dir
                    .join("shell/fish")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        _ => {}
    }
    Ok(())
}

fn preserve_environment_value(
    env: &mut BTreeMap<String, String>,
    key: &str,
    managed_key: &str,
    fallback: &str,
) {
    let present = env.contains_key(key);
    let value = env.get(key).cloned().unwrap_or_else(|| fallback.to_owned());
    env.insert(managed_key.to_owned(), value);
    env.insert(
        format!("{managed_key}_PRESENT"),
        u8::from(present).to_string(),
    );
}

fn ensure_vendor_file(path: PathBuf, vendor: &str, contract: &Contract) -> VendorReport {
    let result = with_lock(&path, || {
        let existing = read_config(&path)?.unwrap_or_else(|| Value::Object(Map::new()));
        let next = merge_value(vendor, existing.clone(), contract)?;
        if existing == next {
            return Ok(VendorStatus::Current);
        }
        write_json_atomic(&path, &next)?;
        Ok(VendorStatus::Changed)
    });
    match result {
        Ok(status) => VendorReport {
            vendor: vendor.to_owned(),
            path,
            status,
            contract_version: contract.contract_version,
            warning: None,
        },
        Err(error) => degraded(vendor, path, contract.contract_version, &error.to_string()),
    }
}

fn merge_value(vendor: &str, input: Value, contract: &Contract) -> Result<Value, IntegrationError> {
    let definition = contract
        .vendors
        .get(vendor)
        .ok_or_else(|| IntegrationError::Invalid(format!("unknown vendor {vendor}")))?;
    let Value::Object(root) = input else {
        return Err(IntegrationError::UnsupportedSettings(format!(
            "{vendor} settings must contain a JSON object"
        )));
    };
    let pruned = prune_managed(
        Value::Object(root),
        &definition.marker,
        definition
            .entry
            .wrapper
            .as_ref()
            .map(|wrapper| wrapper.field.as_str()),
    )
    .unwrap_or_else(|| Value::Object(Map::new()));
    let Value::Object(mut root) = pruned else {
        return Err(IntegrationError::Invalid(
            "pruned settings are invalid".to_owned(),
        ));
    };
    require_document_version(vendor, definition, &mut root)?;
    let managed_entries = definition
        .managed
        .iter()
        .map(|hook| {
            (
                hook.event.clone(),
                managed_entry(vendor, hook, definition, contract),
            )
        })
        .collect::<Vec<_>>();
    let events = object_at_path_mut(vendor, &mut root, &definition.document.events_path)?;
    let events_label = definition.document.events_path.join(".");
    events.retain(|_, entries| !matches!(entries, Value::Array(items) if items.is_empty()));
    for hook in &definition.managed {
        if events
            .get(&hook.event)
            .is_some_and(|entry| !entry.is_array())
        {
            return Err(IntegrationError::UnsupportedSettings(format!(
                "{vendor} {events_label}.{} must be an array",
                hook.event
            )));
        }
    }
    for (event, managed) in managed_entries {
        let entry = events.entry(event).or_insert_with(|| Value::Array(vec![]));
        entry
            .as_array_mut()
            .expect("array assigned above")
            .push(managed);
    }
    Ok(Value::Object(root))
}

fn require_document_version(
    vendor: &str,
    definition: &VendorContract,
    root: &mut Map<String, Value>,
) -> Result<(), IntegrationError> {
    let Some(version) = &definition.document.version else {
        return Ok(());
    };
    if root
        .get(&version.field)
        .is_some_and(|existing| existing != &Value::from(version.value))
    {
        return Err(IntegrationError::UnsupportedSettings(format!(
            "{vendor} {} must be {}",
            version.field, version.value
        )));
    }
    root.insert(version.field.clone(), Value::from(version.value));
    Ok(())
}

fn object_at_path_mut<'a>(
    vendor: &str,
    root: &'a mut Map<String, Value>,
    path: &[String],
) -> Result<&'a mut Map<String, Value>, IntegrationError> {
    let mut current = root;
    let mut traversed = Vec::new();
    for component in path {
        traversed.push(component.as_str());
        let entry = current
            .entry(component.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        let Value::Object(next) = entry else {
            return Err(IntegrationError::UnsupportedSettings(format!(
                "{vendor} {} must be an object",
                traversed.join(".")
            )));
        };
        current = next;
    }
    Ok(current)
}

fn managed_entry(
    vendor: &str,
    hook: &HookSpec,
    definition: &VendorContract,
    contract: &Contract,
) -> Value {
    let command = managed_command(vendor, &hook.event, definition, contract);
    let should_wrap = definition
        .entry
        .wrapper
        .as_ref()
        .is_some_and(|wrapper| wrapper.when == "always" || hook.matcher.is_some());
    if should_wrap {
        let wrapper = definition.entry.wrapper.as_ref().expect("checked above");
        let mut entry = Map::new();
        if let Some(matcher) = &hook.matcher {
            entry.insert("matcher".to_owned(), Value::String(matcher.clone()));
        }
        entry.insert(wrapper.field.clone(), Value::Array(vec![command]));
        return Value::Object(entry);
    }
    let Value::Object(mut entry) = command else {
        unreachable!("managed command is an object")
    };
    if let Some(matcher) = &hook.matcher {
        entry.insert("matcher".to_owned(), Value::String(matcher.clone()));
    }
    Value::Object(entry)
}

fn managed_command(
    vendor: &str,
    event: &str,
    definition: &VendorContract,
    contract: &Contract,
) -> Value {
    let fallback = definition
        .fallback_by_event
        .as_ref()
        .and_then(|items| items.get(event))
        .or(definition.fallback.as_ref())
        .map(String::as_str)
        .unwrap_or("true");
    let command = contract
        .command_template
        .replacen("{marker}", &definition.marker, 1)
        .replacen("{outputMode}", &definition.output_mode, 1)
        .replacen("{agent}", vendor, 1)
        .replacen("{event}", event, 1)
        .replace("{fallback}", fallback);
    let mut entry = Map::new();
    entry.insert("type".to_owned(), Value::String("command".to_owned()));
    entry.insert(
        definition.entry.command_field.clone(),
        Value::String(command),
    );
    Value::Object(entry)
}

fn prune_managed(value: Value, marker: &str, wrapper_field: Option<&str>) -> Option<Value> {
    match value {
        Value::Array(items) => Some(Value::Array(
            items
                .into_iter()
                .filter_map(|item| prune_managed(item, marker, wrapper_field))
                .collect(),
        )),
        Value::Object(object) => {
            if ["command", "bash", "powershell"].iter().any(|field| {
                object
                    .get(*field)
                    .and_then(Value::as_str)
                    .is_some_and(|command| command.contains(marker))
            }) {
                return None;
            }
            let had_wrapper = wrapper_field
                .and_then(|field| object.get(field))
                .is_some_and(Value::is_array);
            let mut next = Map::new();
            for (key, nested) in object {
                if let Some(pruned) = prune_managed(nested, marker, wrapper_field) {
                    next.insert(key, pruned);
                }
            }
            if had_wrapper
                && wrapper_field
                    .and_then(|field| next.get(field))
                    .is_some_and(|hooks| hooks.as_array().is_some_and(Vec::is_empty))
            {
                None
            } else {
                Some(Value::Object(next))
            }
        }
        other => Some(other),
    }
}

fn contract() -> Result<Contract, IntegrationError> {
    let contract: Contract = serde_json::from_str(CONTRACT_BYTES)?;
    let manifest =
        agent_manifest().map_err(|error| IntegrationError::Invalid(error.to_string()))?;
    if contract.contract_version != 3
        || contract.vendors.is_empty()
        || contract.vendors.len() > 128
        || contract.command_wrappers.len() > 128
    {
        return Err(IntegrationError::Invalid(
            "unsupported contract version or agent count".to_owned(),
        ));
    }
    let portable_hooks = manifest
        .agents
        .iter()
        .filter_map(|agent| agent.hook.as_ref().map(|hook| (agent.id.as_str(), hook)))
        .collect::<BTreeMap<_, _>>();
    if portable_hooks.len() != contract.vendors.len() {
        return Err(IntegrationError::Invalid(
            "hook contract and portable manifest differ".to_owned(),
        ));
    }
    for (agent_id, definition) in &contract.vendors {
        let Some(portable) = portable_hooks.get(agent_id.as_str()) else {
            return Err(IntegrationError::Invalid(
                "hook contract agent is absent from the portable manifest".to_owned(),
            ));
        };
        if !matching_path_roots(definition.path_root.as_ref(), portable.path_root.as_ref())
            || definition.relative_path != portable.relative_path
            || !matching_hook_document(&definition.document, &portable.document)
            || !matching_hook_entry(&definition.entry, &portable.entry)
            || definition.marker != portable.marker
            || definition.output_mode != portable.output_mode
            || definition.managed.len() != portable.managed.len()
            || definition
                .managed
                .iter()
                .zip(&portable.managed)
                .any(|(left, right)| left.event != right.event || left.matcher != right.matcher)
        {
            return Err(IntegrationError::Invalid(
                "hook contract differs from the portable manifest".to_owned(),
            ));
        }
    }
    let mut wrapper_executables = BTreeSet::new();
    for wrapper in &contract.command_wrappers {
        let portable = manifest
            .agents
            .iter()
            .find(|agent| agent.id == wrapper.agent_id)
            .ok_or_else(|| {
                IntegrationError::Invalid(
                    "command wrapper agent is absent from the portable manifest".to_owned(),
                )
            })?;
        let portable_hook = portable.hook.as_ref().ok_or_else(|| {
            IntegrationError::Invalid("command wrapper agent has no hook".to_owned())
        })?;
        let expected_hook_path = format!(
            "{}/{}",
            wrapper.default_home_relative_path, wrapper.integration_relative_path
        );
        let portable_hook_path = portable_hook
            .path_root
            .as_ref()
            .map(|root| {
                format!(
                    "{}/{}",
                    root.default_home_relative_path, portable_hook.relative_path
                )
            })
            .unwrap_or_else(|| portable_hook.relative_path.clone());
        if !valid_wrapper_token(&wrapper.executable)
            || !valid_wrapper_token(&wrapper.legacy_hooks_feature)
            || !valid_wrapper_token(&wrapper.current_hooks_feature)
            || !valid_wrapper_token(&wrapper.notification_method)
            || !wrapper
                .home_environment_variable
                .bytes()
                .enumerate()
                .all(|(index, byte)| {
                    byte.is_ascii_uppercase()
                        || byte == b'_'
                        || (index > 0 && byte.is_ascii_digit())
                })
            || wrapper.home_environment_variable.is_empty()
            || wrapper.home_environment_variable.len() > 64
            || wrapper.current_hooks_feature_minor > 10_000
            || !wrapper_executables.insert(wrapper.executable.clone())
            || portable_hook_path != expected_hook_path
            || portable_hook.marker != wrapper.integration_managed_marker
        {
            return Err(IntegrationError::Invalid(
                "command wrapper contract is invalid".to_owned(),
            ));
        }
    }
    Ok(contract)
}

fn matching_hook_document(
    contract: &HookDocumentContract,
    portable: &kmux_agent_manifest::HookDocumentDefinition,
) -> bool {
    contract.events_path == portable.events_path
        && match (&contract.version, &portable.version) {
            (None, None) => true,
            (Some(contract), Some(portable)) => {
                contract.field == portable.field && contract.value == portable.value
            }
            _ => false,
        }
}

fn matching_hook_entry(
    contract: &HookEntryContract,
    portable: &kmux_agent_manifest::HookEntryDefinition,
) -> bool {
    contract.command_field == portable.command_field
        && match (&contract.wrapper, &portable.wrapper) {
            (None, None) => true,
            (Some(contract), Some(portable)) => {
                contract.field == portable.field && contract.when == portable.when
            }
            _ => false,
        }
}

fn matching_path_roots(
    contract: Option<&PathRootContract>,
    portable: Option<&kmux_agent_manifest::PathRootDefinition>,
) -> bool {
    match (contract, portable) {
        (None, None) => true,
        (Some(contract), Some(portable)) => {
            contract.default_home_relative_path == portable.default_home_relative_path
                && contract.environment_variable == portable.environment_variable
        }
        _ => false,
    }
}

fn valid_wrapper_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn read_config(path: &Path) -> Result<Option<Value>, IntegrationError> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(OFlag::O_NOFOLLOW.bits())
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file()
        || metadata.uid() != nix::unistd::geteuid().as_raw()
        || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err(IntegrationError::Invalid(format!(
            "{} is not a safe bounded regular file",
            path.display()
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(IntegrationError::Invalid(
            "settings file is oversized".to_owned(),
        ));
    }
    Ok(Some(serde_json::from_slice(&bytes)?))
}

fn with_lock<T>(
    path: &Path,
    operation: impl FnOnce() -> Result<T, IntegrationError>,
) -> Result<T, IntegrationError> {
    let parent = path
        .parent()
        .ok_or_else(|| IntegrationError::Invalid("settings path has no parent".to_owned()))?;
    fs::create_dir_all(parent)?;
    let lock = PathBuf::from(format!("{}.kmux-agent-integration.lock", path.display()));
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match fs::create_dir(&lock) {
            Ok(()) => break,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if fs::metadata(&lock)
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                    .is_some_and(|age| age > LOCK_STALE)
                {
                    let _ = fs::remove_dir(&lock);
                    continue;
                }
                if Instant::now() >= deadline {
                    return Err(IntegrationError::LockTimedOut);
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error.into()),
        }
    }
    let result = operation();
    let _ = fs::remove_dir(&lock);
    result
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), IntegrationError> {
    let parent = path
        .parent()
        .ok_or_else(|| IntegrationError::Invalid("settings path has no parent".to_owned()))?;
    if let Ok(metadata) = fs::symlink_metadata(path)
        && metadata.mode() & 0o200 == 0
    {
        return Err(IntegrationError::Invalid(format!(
            "{} is not user-writable",
            path.display()
        )));
    }
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".agent-integration-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(OFlag::O_NOFOLLOW.bits())
            .open(&temporary)?;
        let mut bytes = serde_json::to_vec_pretty(value)?;
        bytes.push(b'\n');
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn ensure_private_directory(path: &Path) -> Result<(), IntegrationError> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != nix::unistd::geteuid().as_raw()
    {
        return Err(IntegrationError::Invalid(format!(
            "{} is not a safe owned directory",
            path.display()
        )));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn write_executable_atomic(path: &Path, bytes: &[u8]) -> Result<(), IntegrationError> {
    write_managed_file_atomic(path, bytes, 0o700)
}

fn write_shell_integration_files(directory: &Path) -> Result<(), IntegrationError> {
    let shell_root = directory.join("shell");
    let zsh_root = shell_root.join("zsh");
    let bash_root = shell_root.join("bash");
    let fish_root = shell_root.join("fish/fish");
    for path in [
        &shell_root,
        &zsh_root,
        &bash_root,
        &shell_root.join("fish"),
        &fish_root,
    ] {
        ensure_private_directory(path)?;
    }
    for file_name in [".zshenv", ".zprofile"] {
        write_managed_file_atomic(
            &zsh_root.join(file_name),
            zsh_wrapper(file_name, false).as_bytes(),
            0o600,
        )?;
    }
    write_managed_file_atomic(
        &zsh_root.join(".zshrc"),
        zsh_wrapper(".zshrc", true).as_bytes(),
        0o600,
    )?;
    write_managed_file_atomic(
        &bash_root.join(".bash_profile"),
        bash_profile_wrapper().as_bytes(),
        0o600,
    )?;
    write_managed_file_atomic(
        &bash_root.join(".bashrc"),
        bash_rc_wrapper().as_bytes(),
        0o600,
    )?;
    write_managed_file_atomic(
        &fish_root.join("config.fish"),
        fish_config_wrapper().as_bytes(),
        0o600,
    )?;
    Ok(())
}

fn zsh_wrapper(file_name: &str, restore_original: bool) -> String {
    let finish = if restore_original {
        r#"  _kmux_restored_zdotdir="${ZDOTDIR:-$KMUX_ORIGINAL_ZDOTDIR}"
  _kmux_agent_bin="${KMUX_AGENT_BIN_DIR:-}"
  if [[ -n "$_kmux_agent_bin" && -d "$_kmux_agent_bin" ]]; then
    _kmux_next_path=("$_kmux_agent_bin")
    for _kmux_path_entry in "${path[@]}"; do
      [[ "$_kmux_path_entry" == "$_kmux_agent_bin" ]] || _kmux_next_path+=("$_kmux_path_entry")
    done
    path=("${_kmux_next_path[@]}")
    export PATH
    rehash
  fi
  export ZDOTDIR="$_kmux_restored_zdotdir"
  unset _kmux_restored_zdotdir _kmux_agent_bin _kmux_next_path _kmux_path_entry"#
    } else {
        r#"  if [[ -n "${ZDOTDIR:-}" && "$ZDOTDIR" != "$_kmux_wrapper_zdotdir" ]]; then
    export KMUX_ORIGINAL_ZDOTDIR="$ZDOTDIR"
  fi
  export ZDOTDIR="$_kmux_wrapper_zdotdir""#
    };
    format!(
        r#"if [[ -n "${{KMUX_ORIGINAL_ZDOTDIR:-}}" ]]; then
  _kmux_wrapper_zdotdir="$ZDOTDIR"
  export ZDOTDIR="$KMUX_ORIGINAL_ZDOTDIR"
  if [[ -f "$ZDOTDIR/{file_name}" ]]; then
    source "$ZDOTDIR/{file_name}"
  fi
{finish}
  unset _kmux_wrapper_zdotdir
fi
"#
    )
}

fn bash_profile_wrapper() -> String {
    format!(
        r#"if [[ -n "${{KMUX_ORIGINAL_HOME:-}}" ]]; then
  export HOME="$KMUX_ORIGINAL_HOME"
  if [[ -f "$HOME/.bash_profile" ]]; then
    source "$HOME/.bash_profile"
  elif [[ -f "$HOME/.bash_login" ]]; then
    source "$HOME/.bash_login"
  elif [[ -f "$HOME/.profile" ]]; then
    source "$HOME/.profile"
  fi
{}
fi
"#,
        bash_path_prepend()
    )
}

fn bash_rc_wrapper() -> String {
    format!(
        r#"if [[ -n "${{KMUX_ORIGINAL_HOME:-}}" ]]; then
  export HOME="$KMUX_ORIGINAL_HOME"
  if [[ -f "$HOME/.bashrc" ]]; then
    source "$HOME/.bashrc"
  fi
{}
fi
"#,
        bash_path_prepend()
    )
}

fn bash_path_prepend() -> &'static str {
    r#"  _kmux_agent_bin="${KMUX_AGENT_BIN_DIR:-}"
  if [[ -n "$_kmux_agent_bin" && -d "$_kmux_agent_bin" ]]; then
    _kmux_path_value="${PATH-}"
    _kmux_next_path=("$_kmux_agent_bin")
    while :; do
      _kmux_path_last=0
      if [[ "$_kmux_path_value" == *:* ]]; then
        _kmux_path_entry="${_kmux_path_value%%:*}"
        _kmux_path_value="${_kmux_path_value#*:}"
      else
        _kmux_path_entry="$_kmux_path_value"
        _kmux_path_last=1
      fi
      [[ "$_kmux_path_entry" == "$_kmux_agent_bin" ]] || _kmux_next_path+=("$_kmux_path_entry")
      [[ "$_kmux_path_last" == 1 ]] && break
    done
    PATH="$(IFS=:; printf "%s" "${_kmux_next_path[*]}")"
    export PATH
    hash -r
  fi
  unset _kmux_agent_bin _kmux_path_value _kmux_next_path _kmux_path_last _kmux_path_entry"#
}

fn fish_config_wrapper() -> &'static str {
    r#"if set -q KMUX_ORIGINAL_XDG_CONFIG_HOME
  set -gx XDG_CONFIG_HOME "$KMUX_ORIGINAL_XDG_CONFIG_HOME"
  for _kmux_config in "$XDG_CONFIG_HOME"/fish/conf.d/*.fish
    if test -f "$_kmux_config"
      source "$_kmux_config"
    end
  end
  set -e _kmux_config
  if test -f "$XDG_CONFIG_HOME/fish/config.fish"
    source "$XDG_CONFIG_HOME/fish/config.fish"
  end
  set -l _kmux_agent_bin "$KMUX_AGENT_BIN_DIR"
  if test -n "$_kmux_agent_bin"; and test -d "$_kmux_agent_bin"
    set -l _kmux_next_path "$_kmux_agent_bin"
    for _kmux_path_entry in $PATH
      test "$_kmux_path_entry" = "$_kmux_agent_bin"; or set -a _kmux_next_path "$_kmux_path_entry"
    end
    set -gx PATH $_kmux_next_path
  end
end
"#
}

fn write_managed_file_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<(), IntegrationError> {
    match OpenOptions::new()
        .read(true)
        .custom_flags(OFlag::O_NOFOLLOW.bits())
        .open(path)
    {
        Ok(mut file) => {
            let metadata = file.metadata()?;
            if !metadata.file_type().is_file()
                || metadata.uid() != nix::unistd::geteuid().as_raw()
                || metadata.len() > MAX_CONFIG_BYTES
            {
                return Err(IntegrationError::Invalid(format!(
                    "{} is not a safe bounded owned file",
                    path.display()
                )));
            }
            let mut existing = Vec::with_capacity(metadata.len() as usize);
            file.read_to_end(&mut existing)?;
            if existing == bytes {
                fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
                return Ok(());
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let parent = path
        .parent()
        .ok_or_else(|| IntegrationError::Invalid("shim path has no parent".to_owned()))?;
    let temporary = parent.join(format!(".shim-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .custom_flags(OFlag::O_NOFOLLOW.bits())
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn remote_hook_script(executable: &str) -> Result<String, IntegrationError> {
    let fallback_cases = remote_hook_fallback_cases()?;
    Ok(format!(
        r#"#!/bin/sh
mode=${{KMUX_AGENT_HOOK_OUTPUT_MODE:-silent}}
fallback() {{
  [ "$mode" = json ] || return 0
  agent=$(printf '%s' "${{1:-}}" | tr '[:upper:]' '[:lower:]')
  event=$(printf '%s' "${{2:-}}" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')
  case "$agent:$event" in
{fallback_cases}  esac
  printf '{{}}\n'
}}
if [ "${{1:-}}" = --ensure-integration ]; then
  [ "$#" = 3 ] || exit 2
  self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  exec {executable} agent-integration ensure --json --agent-bin-dir "$self_dir" --vendor "$2" --path "$3"
fi
if [ "${{1:-}}" = --diagnose ]; then
  exec {executable} hook diagnose --json
fi
transport=${{KMUX_AGENT_HOOK_TRANSPORT:-}}
local_present=0; remote_present=0; local_complete=0; remote_complete=0
[ -n "${{KMUX_SOCKET_PATH:-}}" ] && local_present=1
[ -n "${{KMUX_AGENT_HOOK_ENDPOINT:-}}${{KMUX_AUTH_TOKEN:-}}" ] && remote_present=1
case "${{KMUX_SOCKET_PATH:-}}" in /*) local_complete=1 ;; esac
case "${{KMUX_AGENT_HOOK_ENDPOINT:-}}" in /*) [ -n "${{KMUX_AUTH_TOKEN:-}}" ] && remote_complete=1 ;; esac
if [ -z "$transport" ]; then
  if [ "$remote_complete" = 1 ] && [ "$local_present" = 0 ]; then transport=remote
  elif [ "$local_complete" = 1 ] && [ "$remote_present" = 0 ]; then transport=local
  else fallback "$@"; exit 0
  fi
fi
if [ "$transport" != remote ] || [ "$remote_complete" != 1 ]; then fallback "$@"; exit 0; fi
agent=${{1:-unknown}}; event=${{2:-event}}
if [ "$mode" = json ]; then
  {executable} hook emit --kind agent-hook --name "$agent.$event" 2>/dev/null || fallback "$@"
else
  {executable} hook emit --kind agent-hook --name "$agent.$event" >/dev/null 2>&1 || true
fi
exit 0
"#
    ))
}

fn remote_hook_fallback_cases() -> Result<String, IntegrationError> {
    let manifest =
        agent_manifest().map_err(|error| IntegrationError::Invalid(error.to_string()))?;
    let mut cases = String::new();
    for agent in &manifest.agents {
        let Some(hook) = &agent.hook else {
            continue;
        };
        let identities =
            std::iter::once(agent.id.as_str()).chain(agent.aliases.iter().map(String::as_str));
        for identity in identities {
            for (event, response) in &hook.fallback_by_event {
                let event = event
                    .bytes()
                    .filter(u8::is_ascii_alphanumeric)
                    .map(|byte| byte.to_ascii_lowercase() as char)
                    .collect::<String>();
                let response = serde_json::to_string(response)?;
                cases.push_str(&format!(
                    "    {identity}:{event}) printf '%s\\n' {}; return 0 ;;\n",
                    quote_posix_word(&response)
                ));
            }
            let response = serde_json::to_string(&hook.fallback_response)?;
            cases.push_str(&format!(
                "    {identity}:*) printf '%s\\n' {}; return 0 ;;\n",
                quote_posix_word(&response)
            ));
        }
    }
    Ok(cases)
}

fn version_gated_agent_wrapper_script(policy: &CommandWrapperContract) -> String {
    let home_expression = format!(
        "${{{}:-${{HOME}}/{}}}",
        policy.home_environment_variable, policy.default_home_relative_path
    );
    r#"#!/bin/sh
set -u
self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
filtered=; old_ifs=$IFS; IFS=:
for segment in ${PATH:-}; do
  [ "$segment" = "$self_dir" ] && continue
  if [ -z "$filtered" ]; then filtered=$segment; else filtered=$filtered:$segment; fi
done
IFS=$old_ifs; PATH=$filtered; export PATH
real_agent=$(command -v __KMUX_EXECUTABLE__ 2>/dev/null || true)
[ -n "$real_agent" ] || exit 127
has_notification_override() {
  expect=0
  for arg in "$@"; do
    if [ "$expect" = 1 ]; then case "$arg" in tui.notification_method=*) return 0 ;; esac; expect=0; continue; fi
    case "$arg" in --config|-c) expect=1 ;; --config=tui.notification_method=*|-ctui.notification_method=*) return 0 ;; esac
  done
  return 1
}
hooks_file=__KMUX_HOME_EXPRESSION__/__KMUX_INTEGRATION_PATH__
"$self_dir/kmux-agent-hook" --ensure-integration __KMUX_AGENT_ID__ "$hooks_file" >/dev/null 2>&1 || true
if [ -f "$hooks_file" ] && grep -q '__KMUX_MANAGED_MARKER__' "$hooks_file" 2>/dev/null && grep -q '__KMUX_CONTRACT_MARKER__' "$hooks_file" 2>/dev/null; then
  version=$($real_agent --version 2>/dev/null || true)
  major=$(printf '%s' "$version" | sed -n 's/.*[[:space:]]\([0-9][0-9]*\)\.\([0-9][0-9]*\)\..*/\1/p')
  minor=$(printf '%s' "$version" | sed -n 's/.*[[:space:]]\([0-9][0-9]*\)\.\([0-9][0-9]*\)\..*/\2/p')
  feature=__KMUX_LEGACY_HOOKS_FEATURE__
  if { [ -n "$major" ] && [ "$major" -gt 0 ] 2>/dev/null; } || { [ -n "$minor" ] && [ "$minor" -ge __KMUX_CURRENT_HOOKS_MINOR__ ] 2>/dev/null; }; then
    feature=__KMUX_CURRENT_HOOKS_FEATURE__
  fi
  set -- --enable "$feature" "$@"
fi
has_notification_override "$@" || set -- --config tui.notification_method=__KMUX_NOTIFICATION_METHOD__ "$@"
exec "$real_agent" "$@"
"#
    .replace("__KMUX_EXECUTABLE__", &policy.executable)
    .replace("__KMUX_HOME_EXPRESSION__", &home_expression)
    .replace("__KMUX_INTEGRATION_PATH__", &policy.integration_relative_path)
    .replace("__KMUX_AGENT_ID__", &policy.agent_id)
    .replace("__KMUX_MANAGED_MARKER__", &policy.integration_managed_marker)
    .replace(
        "__KMUX_CONTRACT_MARKER__",
        &policy.integration_contract_marker,
    )
    .replace(
        "__KMUX_LEGACY_HOOKS_FEATURE__",
        &policy.legacy_hooks_feature,
    )
    .replace(
        "__KMUX_CURRENT_HOOKS_FEATURE__",
        &policy.current_hooks_feature,
    )
    .replace(
        "__KMUX_CURRENT_HOOKS_MINOR__",
        &policy.current_hooks_feature_minor.to_string(),
    )
    .replace(
        "__KMUX_NOTIFICATION_METHOD__",
        &policy.notification_method,
    )
}

fn quote_posix_word(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn require_absolute(path: &Path, field: &str) -> Result<(), IntegrationError> {
    if !path.is_absolute() {
        return Err(IntegrationError::Invalid(format!(
            "{field} must be absolute"
        )));
    }
    Ok(())
}

fn executable_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.file_type().is_file()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == nix::unistd::geteuid().as_raw()
            && metadata.mode() & 0o111 != 0
    })
}

fn degraded(vendor: &str, path: PathBuf, contract_version: u16, reason: &str) -> VendorReport {
    VendorReport {
        vendor: vendor.to_owned(),
        path,
        status: VendorStatus::Degraded,
        contract_version,
        warning: Some(reason.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::sync::Arc;

    use super::*;

    #[derive(Deserialize)]
    struct MergeFixture {
        name: String,
        vendor: String,
        input: Value,
        output: Option<Value>,
        #[serde(rename = "errorContains")]
        error_contains: Option<String>,
    }

    #[test]
    fn matches_shared_merge_fixtures() {
        let fixtures: Vec<MergeFixture> = serde_json::from_str(include_str!(
            "../../../../../packages/agent-integration/fixtures/merge-v3.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let result = merge_config(&fixture.vendor, fixture.input);
            match (fixture.output, fixture.error_contains) {
                (Some(output), None) => assert_eq!(result.unwrap(), output, "{}", fixture.name),
                (None, Some(error)) => assert!(
                    result.unwrap_err().to_string().contains(error.as_str()),
                    "{}",
                    fixture.name
                ),
                _ => panic!("{} has an invalid expected result", fixture.name),
            }
        }
    }

    #[test]
    fn merge_preserves_user_hooks_and_migrates_old_markers() {
        let input = serde_json::json!({
            "unknown": true,
            "hooks": {
                "Stop": [{ "hooks": [
                    { "type": "command", "command": "echo user" },
                    { "type": "command", "command": "KMUX_MANAGED_CODEX_HOOK=1; old codex Stop" }
                ]}],
                "UserPromptSubmit": [{ "hooks": [
                    { "type": "command", "command": "KMUX_MANAGED_CODEX_HOOK=1; old codex UserPromptSubmit" }
                ]}]
            }
        });
        let output = merge_config("codex", input).unwrap();
        assert_eq!(output["unknown"], true);
        assert!(output.to_string().contains("echo user"));
        assert!(!output.to_string().contains("old codex"));
        assert!(
            output
                .to_string()
                .contains("KMUX_AGENT_INTEGRATION_CONTRACT_VERSION=3")
        );
    }

    #[test]
    fn invalid_json_degrades_without_overwriting() {
        let sandbox = tempfile::tempdir().unwrap();
        let home = sandbox.path();
        let path = home.join(".codex/hooks.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{").unwrap();
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let report = ensure_all(home, &bin).unwrap();
        let codex = report
            .vendors
            .iter()
            .find(|item| item.vendor == "codex")
            .unwrap();
        assert_eq!(codex.status, VendorStatus::Degraded);
        assert_eq!(fs::read(&path).unwrap(), b"{");
    }

    #[test]
    fn unsupported_config_shape_degrades_without_overwriting_or_blocking_other_vendors() {
        let sandbox = tempfile::tempdir().unwrap();
        let home = sandbox.path();
        let path = home.join(".codex/hooks.json");
        let content = br#"{"description":"keep","hooks":{"Stop":"user-command"}}
"#;
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        thread::sleep(Duration::from_millis(10));
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();

        let report = ensure_all(home, &bin).unwrap();
        assert_eq!(
            report
                .vendors
                .iter()
                .map(|vendor| (vendor.vendor.as_str(), vendor.status.clone()))
                .collect::<Vec<_>>(),
            vec![
                ("antigravity", VendorStatus::Changed),
                ("claude", VendorStatus::Changed),
                ("codex", VendorStatus::Degraded),
                ("copilot", VendorStatus::Changed),
            ]
        );
        assert_eq!(fs::read(&path).unwrap(), content);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), mtime);

        let doctor = doctor(home, &bin).unwrap();
        let codex = doctor
            .vendors
            .iter()
            .find(|vendor| vendor.vendor == "codex")
            .unwrap();
        assert_eq!(codex.status, VendorStatus::Degraded);
        let warning = codex.warning.as_deref().unwrap();
        assert!(warning.contains("settings cannot be safely merged"));
        assert!(warning.contains("hooks.Stop must be an array"));
    }

    #[test]
    fn ensure_and_doctor_use_the_effective_codex_home() {
        let sandbox = tempfile::tempdir().unwrap();
        let home = sandbox.path().join("home");
        let codex_home = sandbox.path().join("custom-codex-home");
        let bin = sandbox.path().join("bin");
        let hooks_path = codex_home.join("hooks.json");
        fs::create_dir_all(&codex_home).unwrap();
        fs::create_dir_all(&bin).unwrap();
        fs::write(&hooks_path, b"{").unwrap();

        let report = ensure_all_with_codex_home(&home, &bin, Some(&codex_home)).unwrap();
        let codex = report
            .vendors
            .iter()
            .find(|item| item.vendor == "codex")
            .unwrap();
        assert_eq!(codex.path, hooks_path);
        assert_eq!(codex.status, VendorStatus::Degraded);
        assert!(!home.join(".codex/hooks.json").exists());

        let doctor = doctor_with_codex_home(&home, &bin, Some(&codex_home)).unwrap();
        let codex = doctor
            .vendors
            .iter()
            .find(|item| item.vendor == "codex")
            .unwrap();
        assert_eq!(codex.path, hooks_path);
        assert_eq!(codex.status, VendorStatus::Degraded);
        assert_eq!(fs::read(&hooks_path).unwrap(), b"{");
    }

    #[test]
    fn explicit_vendor_path_supports_invocation_time_codex_home() {
        let sandbox = tempfile::tempdir().unwrap();
        let path = sandbox.path().join("custom-codex-home/hooks.json");
        let report = ensure_vendor_path("codex", &path).unwrap();
        assert_eq!(report.status, VendorStatus::Changed);
        assert_eq!(report.path, path);
        assert!(
            fs::read_to_string(&report.path)
                .unwrap()
                .contains("KMUX_AGENT_INTEGRATION_CONTRACT_VERSION=3")
        );
        assert!(!sandbox.path().join(".codex/hooks.json").exists());
        assert_eq!(
            ensure_vendor_path("codex", &report.path).unwrap().status,
            VendorStatus::Current
        );
    }

    #[test]
    fn repeated_and_concurrent_ensure_is_a_no_op() {
        let sandbox = tempfile::tempdir().unwrap();
        let home = Arc::new(sandbox.path().join("home"));
        let bin = Arc::new(sandbox.path().join("bin"));
        fs::create_dir_all(home.as_ref()).unwrap();
        fs::create_dir_all(bin.as_ref()).unwrap();
        let first = ensure_all(home.as_ref(), bin.as_ref()).unwrap();
        assert!(
            first
                .vendors
                .iter()
                .all(|item| item.status == VendorStatus::Changed)
        );
        let codex_path = home.join(".codex/hooks.json");
        let original_mtime = fs::metadata(&codex_path).unwrap().modified().unwrap();

        let workers = (0..8)
            .map(|_| {
                let home = Arc::clone(&home);
                let bin = Arc::clone(&bin);
                thread::spawn(move || ensure_all(home.as_ref(), bin.as_ref()).unwrap())
            })
            .collect::<Vec<_>>();
        for worker in workers {
            assert!(
                worker
                    .join()
                    .unwrap()
                    .vendors
                    .iter()
                    .all(|item| item.status == VendorStatus::Current)
            );
        }
        assert_eq!(
            fs::metadata(&codex_path).unwrap().modified().unwrap(),
            original_mtime
        );
    }

    #[test]
    fn ensure_uses_the_effective_copilot_home() {
        let sandbox = tempfile::tempdir().unwrap();
        let home = sandbox.path().join("home");
        let copilot_home = sandbox.path().join("custom-copilot-home");
        let bin = sandbox.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let environment = BTreeMap::from([(
            "COPILOT_HOME".to_owned(),
            copilot_home.to_string_lossy().into_owned(),
        )]);

        let report = ensure_all_with_environment(&home, &bin, Some(&environment)).unwrap();
        let copilot = report
            .vendors
            .iter()
            .find(|item| item.vendor == "copilot")
            .unwrap();
        let hooks_path = copilot_home.join("hooks/kmux.json");
        assert_eq!(copilot.path, hooks_path);
        assert_eq!(copilot.status, VendorStatus::Changed);
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&hooks_path).unwrap()).unwrap()["version"],
            1
        );
        assert!(!home.join(".copilot/hooks/kmux.json").exists());
    }

    #[test]
    fn planned_apply_is_idempotent_and_uses_snapshot_compare_and_swap() {
        let sandbox = tempfile::tempdir().unwrap();
        let home = sandbox.path().join("home");
        let bin = sandbox.path().join("bin");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&bin).unwrap();
        let path = home.join(".codex/hooks.json");

        let snapshot = snapshot_all_with_codex_home(&home, &bin, None).unwrap();
        let codex = snapshot
            .vendors
            .iter()
            .find(|vendor| vendor.vendor == "codex")
            .unwrap();
        assert_eq!(codex.state, "absent");
        let desired = merge_config("codex", serde_json::json!({ "user": "first" })).unwrap();
        let request = PlannedApplyRequest {
            operation_id: "operation-1".to_owned(),
            contract_version: snapshot.contract_version,
            vendor: "codex".to_owned(),
            path: path.clone(),
            expected: PlannedApplyExpected::Absent,
            content: format!("{}\n", serde_json::to_string_pretty(&desired).unwrap()),
        };
        let changed = apply_planned_with_codex_home(&home, None, &request).unwrap();
        assert_eq!(changed.status, "changed");
        let repeated = apply_planned_with_codex_home(&home, None, &request).unwrap();
        assert_eq!(repeated.status, "current");

        let current = snapshot_all_with_codex_home(&home, &bin, None).unwrap();
        let current_codex = current
            .vendors
            .iter()
            .find(|vendor| vendor.vendor == "codex")
            .unwrap();
        assert_eq!(current_codex.state, "present");
        assert_eq!(current_codex.sha256, changed.sha256);

        let user_content = b"{\"user\":\"second\"}\n";
        fs::write(&path, user_content).unwrap();
        let conflict = apply_planned_with_codex_home(
            &home,
            None,
            &PlannedApplyRequest {
                operation_id: "operation-2".to_owned(),
                contract_version: current.contract_version,
                vendor: "codex".to_owned(),
                path: path.clone(),
                expected: PlannedApplyExpected::Present {
                    sha256: current_codex.sha256.clone().unwrap(),
                },
                content: request.content.clone(),
            },
        )
        .unwrap();
        assert_eq!(conflict.status, "conflict");
        assert_eq!(fs::read(&path).unwrap(), user_content);
    }

    #[test]
    fn planned_snapshot_and_apply_reject_settings_symlinks_without_touching_targets() {
        let sandbox = tempfile::tempdir().unwrap();
        let home = sandbox.path().join("home");
        let bin = sandbox.path().join("bin");
        let parent = home.join(".codex");
        fs::create_dir_all(&parent).unwrap();
        fs::create_dir_all(&bin).unwrap();
        let target = sandbox.path().join("target.json");
        let original = b"{\"keep\":true}\n";
        fs::write(&target, original).unwrap();
        let path = parent.join("hooks.json");
        std::os::unix::fs::symlink(&target, &path).unwrap();

        let snapshot = snapshot_all_with_codex_home(&home, &bin, None).unwrap();
        let codex = snapshot
            .vendors
            .iter()
            .find(|vendor| vendor.vendor == "codex")
            .unwrap();
        assert_eq!(codex.state, "degraded");
        let desired = merge_config("codex", serde_json::json!({})).unwrap();
        let result = apply_planned_with_codex_home(
            &home,
            None,
            &PlannedApplyRequest {
                operation_id: "operation-symlink".to_owned(),
                contract_version: snapshot.contract_version,
                vendor: "codex".to_owned(),
                path,
                expected: PlannedApplyExpected::Absent,
                content: format!("{}\n", serde_json::to_string_pretty(&desired).unwrap()),
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read(&target).unwrap(), original);
    }

    #[test]
    fn settings_symlinks_degrade_without_touching_the_target() {
        let sandbox = tempfile::tempdir().unwrap();
        let home = sandbox.path().join("home");
        let bin = sandbox.path().join("bin");
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::create_dir_all(&bin).unwrap();
        let target = sandbox.path().join("user-owned.json");
        fs::write(&target, b"{\"keep\":true}").unwrap();
        std::os::unix::fs::symlink(&target, home.join(".codex/hooks.json")).unwrap();

        let report = ensure_all(&home, &bin).unwrap();
        assert_eq!(
            report
                .vendors
                .iter()
                .find(|item| item.vendor == "codex")
                .unwrap()
                .status,
            VendorStatus::Degraded
        );
        assert_eq!(fs::read(&target).unwrap(), b"{\"keep\":true}");
    }

    #[test]
    fn stale_read_only_settings_degrade_without_replacement() {
        let sandbox = tempfile::tempdir().unwrap();
        let home = sandbox.path().join("home");
        let bin = sandbox.path().join("bin");
        let path = home.join(".codex/hooks.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::create_dir_all(&bin).unwrap();
        let content = b"{\"userField\":\"keep\"}";
        fs::write(&path, content).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();

        let report = ensure_all(&home, &bin).unwrap();
        assert_eq!(
            report
                .vendors
                .iter()
                .find(|item| item.vendor == "codex")
                .unwrap()
                .status,
            VendorStatus::Degraded
        );
        assert_eq!(fs::read(&path).unwrap(), content);
    }

    #[test]
    fn bash_startup_restores_the_current_runtime_path_after_user_rc() {
        if !Path::new("/bin/bash").exists() {
            return;
        }
        let sandbox = tempfile::tempdir().unwrap();
        let install_root = sandbox.path().join("install");
        let executable = sandbox.path().join("kmuxd");
        fs::write(&executable, b"runtime").unwrap();
        let agent_bin = ensure_runtime_shims(&install_root, &executable, &"a".repeat(64)).unwrap();
        let home = sandbox.path().join("home");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(".bashrc"),
            "export PATH=/user/old-kmux:/usr/bin:/bin\n",
        )
        .unwrap();
        let mut env = BTreeMap::from([
            ("HOME".to_owned(), home.to_string_lossy().into_owned()),
            ("PATH".to_owned(), "/before-rc:/usr/bin:/bin".to_owned()),
            (
                "KMUX_AGENT_BIN_DIR".to_owned(),
                agent_bin.to_string_lossy().into_owned(),
            ),
        ]);
        prepare_shell_environment(Some("/bin/bash"), &mut env, &agent_bin).unwrap();

        let output = Command::new("/bin/bash")
            .args([
                "--noprofile",
                "-i",
                "-c",
                "printf '%s\\n%s' \"$PATH\" \"$HOME\"",
            ])
            .env_clear()
            .envs(&env)
            .output()
            .unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        let mut lines = stdout.lines();
        assert_eq!(
            lines.next().unwrap().split(':').next(),
            Some(agent_bin.to_string_lossy().as_ref())
        );
        assert_eq!(lines.next(), Some(home.to_string_lossy().as_ref()));
    }

    #[test]
    fn remote_codex_wrapper_uses_the_shared_policy_for_major_versions() {
        let sandbox = tempfile::tempdir().unwrap();
        let install_root = sandbox.path().join("install");
        let executable = sandbox.path().join("kmuxd");
        fs::write(
            &executable,
            b"#!/bin/sh\nprintf '%s\\n' \"$@\" >\"$KMUX_TEST_RUNTIME_LOG\"\npath=\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --path ]; then shift; path=$1; fi\n  shift\ndone\n[ -n \"$path\" ] || exit 1\nmkdir -p \"$(dirname -- \"$path\")\"\nprintf '%s' '{\"command\":\"KMUX_MANAGED_CODEX_HOOK=1 KMUX_AGENT_INTEGRATION_CONTRACT_VERSION=3\"}' >\"$path\"\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let agent_bin = ensure_runtime_shims(&install_root, &executable, &"b".repeat(64)).unwrap();
        let fake_bin = sandbox.path().join("real-bin");
        fs::create_dir_all(&fake_bin).unwrap();
        let real_codex = fake_bin.join("codex");
        fs::write(
            &real_codex,
            b"#!/bin/sh\nif [ \"${1:-}\" = --version ]; then printf 'codex-cli 1.0.0\\n'; exit 0; fi\nprintf '%s\\n' \"$@\"\n",
        )
        .unwrap();
        fs::set_permissions(&real_codex, fs::Permissions::from_mode(0o700)).unwrap();
        let home = sandbox.path().join("home");
        let codex_home = sandbox.path().join("custom-codex-home");
        let runtime_log = sandbox.path().join("runtime-args.log");
        fs::create_dir_all(&home).unwrap();

        let output = Command::new(agent_bin.join("codex"))
            .arg("status")
            .env("HOME", &home)
            .env("CODEX_HOME", &codex_home)
            .env("KMUX_TEST_RUNTIME_LOG", &runtime_log)
            .env("PATH", format!("{}:/usr/bin:/bin", fake_bin.display()))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(runtime_log.exists());
        assert!(codex_home.join("hooks.json").exists());
        assert!(!home.join(".codex/hooks.json").exists());
        assert_eq!(
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            [
                "--config",
                "tui.notification_method=osc9",
                "--enable",
                "hooks",
                "status"
            ]
        );
    }
}
