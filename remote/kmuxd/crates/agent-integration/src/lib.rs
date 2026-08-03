#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

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
    codex_wrapper: CodexWrapperContract,
    vendors: BTreeMap<String, VendorContract>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexWrapperContract {
    contract_marker: String,
    legacy_hooks_feature: String,
    current_hooks_feature: String,
    current_hooks_feature_minor: u16,
    notification_method: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VendorContract {
    format: String,
    relative_path: String,
    namespace: Option<String>,
    marker: String,
    managed: Vec<HookSpec>,
    #[allow(dead_code)]
    deprecated: Vec<String>,
    output_mode: String,
    fallback: Option<String>,
    fallback_by_event: Option<BTreeMap<String, String>>,
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
    require_absolute(home, "home")?;
    require_absolute(agent_bin_dir, "agent bin directory")?;
    let contract = contract()?;
    let vendors = contract
        .vendors
        .iter()
        .map(|(vendor, definition)| {
            ensure_vendor_file(
                vendor_settings_path(home, codex_home, vendor, definition),
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
    require_absolute(home, "home")?;
    require_absolute(agent_bin_dir, "agent bin directory")?;
    let contract = contract()?;
    let vendors = contract
        .vendors
        .iter()
        .map(|(vendor, definition)| {
            let path = vendor_settings_path(home, codex_home, vendor, definition);
            match snapshot_vendor_path(vendor, &path, settings_root(home, codex_home, vendor)) {
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
    let expected_path = vendor_settings_path(home, codex_home, &request.vendor, definition);
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
    let root = settings_root(home, codex_home, &request.vendor);
    ensure_safe_settings_parent(root, &request.path)?;
    with_lock(&request.path, || {
        ensure_safe_settings_parent(root, &request.path)?;
        let current = read_settings_bytes(&request.path, root)?;
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

fn settings_root<'a>(home: &'a Path, codex_home: Option<&'a Path>, vendor: &str) -> &'a Path {
    if vendor == "codex"
        && let Some(codex_home) = codex_home.filter(|path| path.is_absolute())
    {
        return codex_home;
    }
    home
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
    require_absolute(home, "home")?;
    require_absolute(agent_bin_dir, "agent bin directory")?;
    let contract = contract()?;
    let helper_ready = executable_regular_file(&agent_bin_dir.join("kmux-agent-hook"));
    let (transport_ready, transport_reason) = remote_transport_readiness();
    let mut vendors = Vec::new();
    for (vendor, definition) in &contract.vendors {
        let path = vendor_settings_path(home, codex_home, vendor, definition);
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
    codex_home: Option<&Path>,
    vendor: &str,
    definition: &VendorContract,
) -> PathBuf {
    if vendor == "codex"
        && let Some(codex_home) = codex_home.filter(|path| path.is_absolute())
    {
        return codex_home.join("hooks.json");
    }
    home.join(&definition.relative_path)
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
    let hook = remote_hook_script(&quoted);
    let contract = contract()?;
    let codex_marker = &contract
        .vendors
        .get("codex")
        .ok_or_else(|| IntegrationError::Invalid("codex contract is missing".to_owned()))?
        .marker;
    let codex = codex_wrapper_script(&contract.codex_wrapper, codex_marker);
    write_executable_atomic(&directory.join("kmux"), cli.as_bytes())?;
    write_executable_atomic(&directory.join("kmux-agent-hook"), hook.as_bytes())?;
    write_executable_atomic(&directory.join("codex"), codex.as_bytes())?;
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
    let Value::Object(mut root) = input else {
        return Err(IntegrationError::UnsupportedSettings(format!(
            "{vendor} settings must contain a JSON object"
        )));
    };
    if definition.format == "grouped-hooks" {
        let mut hooks = match root.remove("hooks") {
            Some(Value::Object(hooks)) => hooks,
            None => Map::new(),
            Some(_) => {
                return Err(IntegrationError::UnsupportedSettings(format!(
                    "{vendor} hooks must be an object"
                )));
            }
        };
        for hook in &definition.managed {
            if hooks
                .get(&hook.event)
                .is_some_and(|existing| !existing.is_array())
            {
                return Err(IntegrationError::UnsupportedSettings(format!(
                    "{vendor} hooks.{} must be an array",
                    hook.event
                )));
            }
        }
        for value in hooks.values_mut() {
            *value =
                prune_managed(value.clone(), &definition.marker).unwrap_or(Value::Array(vec![]));
        }
        hooks.retain(|_, value| !matches!(value, Value::Array(items) if items.is_empty()));
        for hook in &definition.managed {
            let groups = hooks
                .entry(hook.event.clone())
                .or_insert_with(|| Value::Array(vec![]));
            let mut group = Map::new();
            if let Some(matcher) = &hook.matcher {
                group.insert("matcher".to_owned(), Value::String(matcher.clone()));
            }
            group.insert(
                "hooks".to_owned(),
                Value::Array(vec![managed_command(
                    vendor,
                    &hook.event,
                    definition,
                    contract,
                )]),
            );
            groups
                .as_array_mut()
                .expect("array assigned above")
                .push(Value::Object(group));
        }
        root.insert("hooks".to_owned(), Value::Object(hooks));
        return Ok(Value::Object(root));
    }
    if definition.format != "namespaced-hooks" {
        return Err(IntegrationError::Invalid(format!(
            "unsupported integration format {}",
            definition.format
        )));
    }
    let namespace = definition
        .namespace
        .as_ref()
        .ok_or_else(|| IntegrationError::Invalid("namespace is missing".to_owned()))?;
    if let Some(existing) = root.get(namespace) {
        let Value::Object(existing) = existing else {
            return Err(IntegrationError::UnsupportedSettings(format!(
                "{vendor} {namespace} must be an object"
            )));
        };
        for hook in &definition.managed {
            if existing
                .get(&hook.event)
                .is_some_and(|entry| !entry.is_array())
            {
                return Err(IntegrationError::UnsupportedSettings(format!(
                    "{vendor} {namespace}.{} must be an array",
                    hook.event
                )));
            }
        }
    }
    let pruned = prune_managed(Value::Object(root), &definition.marker)
        .unwrap_or_else(|| Value::Object(Map::new()));
    let Value::Object(mut root) = pruned else {
        return Err(IntegrationError::Invalid(
            "pruned settings are invalid".to_owned(),
        ));
    };
    let mut managed = match root.remove(namespace) {
        Some(Value::Object(managed)) => managed,
        _ => Map::new(),
    };
    for hook in &definition.managed {
        let command = managed_command(vendor, &hook.event, definition, contract);
        let entry = managed
            .entry(hook.event.clone())
            .or_insert_with(|| Value::Array(vec![]));
        if let Some(matcher) = &hook.matcher {
            entry
                .as_array_mut()
                .expect("array assigned above")
                .push(serde_json::json!({ "matcher": matcher, "hooks": [command] }));
        } else {
            entry
                .as_array_mut()
                .expect("array assigned above")
                .push(command);
        }
    }
    root.insert(namespace.clone(), Value::Object(managed));
    Ok(Value::Object(root))
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
    serde_json::json!({ "type": "command", "command": command })
}

fn prune_managed(value: Value, marker: &str) -> Option<Value> {
    match value {
        Value::Array(items) => Some(Value::Array(
            items
                .into_iter()
                .filter_map(|item| prune_managed(item, marker))
                .collect(),
        )),
        Value::Object(object) => {
            if object
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|command| command.contains(marker))
            {
                return None;
            }
            let had_hooks = object.get("hooks").is_some_and(Value::is_array);
            let mut next = Map::new();
            for (key, nested) in object {
                if let Some(pruned) = prune_managed(nested, marker) {
                    next.insert(key, pruned);
                }
            }
            if had_hooks
                && next
                    .get("hooks")
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
    if contract.contract_version != 2 || contract.vendors.len() != 3 {
        return Err(IntegrationError::Invalid(
            "unsupported contract version or vendor set".to_owned(),
        ));
    }
    Ok(contract)
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

fn remote_hook_script(executable: &str) -> String {
    format!(
        r#"#!/bin/sh
mode=${{KMUX_AGENT_HOOK_OUTPUT_MODE:-silent}}
fallback() {{
  [ "$mode" = json ] || return 0
  agent=$(printf '%s' "${{1:-}}" | tr '[:upper:]' '[:lower:]')
  event=$(printf '%s' "${{2:-}}" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')
  if {{ [ "$agent" = agy ] || [ "$agent" = antigravity ] || [ "$agent" = antigravity-cli ]; }} && {{ [ "$event" = pretooluse ] || [ "$event" = stop ]; }}; then
    printf '{{"decision":"allow"}}\n'
  else
    printf '{{}}\n'
  fi
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
    )
}

fn codex_wrapper_script(policy: &CodexWrapperContract, managed_marker: &str) -> String {
    r#"#!/bin/sh
set -u
self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
filtered=; old_ifs=$IFS; IFS=:
for segment in ${PATH:-}; do
  [ "$segment" = "$self_dir" ] && continue
  if [ -z "$filtered" ]; then filtered=$segment; else filtered=$filtered:$segment; fi
done
IFS=$old_ifs; PATH=$filtered; export PATH
real_codex=$(command -v codex 2>/dev/null || true)
[ -n "$real_codex" ] || exit 127
has_notification_override() {
  expect=0
  for arg in "$@"; do
    if [ "$expect" = 1 ]; then case "$arg" in tui.notification_method=*) return 0 ;; esac; expect=0; continue; fi
    case "$arg" in --config|-c) expect=1 ;; --config=tui.notification_method=*|-ctui.notification_method=*) return 0 ;; esac
  done
  return 1
}
hooks_file=${CODEX_HOME:-${HOME}/.codex}/hooks.json
"$self_dir/kmux-agent-hook" --ensure-integration codex "$hooks_file" >/dev/null 2>&1 || true
if [ -f "$hooks_file" ] && grep -q '__KMUX_MANAGED_MARKER__' "$hooks_file" 2>/dev/null && grep -q '__KMUX_CONTRACT_MARKER__' "$hooks_file" 2>/dev/null; then
  version=$($real_codex --version 2>/dev/null || true)
  major=$(printf '%s' "$version" | sed -n 's/.*[[:space:]]\([0-9][0-9]*\)\.\([0-9][0-9]*\)\..*/\1/p')
  minor=$(printf '%s' "$version" | sed -n 's/.*[[:space:]]\([0-9][0-9]*\)\.\([0-9][0-9]*\)\..*/\2/p')
  feature=__KMUX_LEGACY_HOOKS_FEATURE__
  if { [ -n "$major" ] && [ "$major" -gt 0 ] 2>/dev/null; } || { [ -n "$minor" ] && [ "$minor" -ge __KMUX_CURRENT_HOOKS_MINOR__ ] 2>/dev/null; }; then
    feature=__KMUX_CURRENT_HOOKS_FEATURE__
  fi
  set -- --enable "$feature" "$@"
fi
has_notification_override "$@" || set -- --config tui.notification_method=__KMUX_NOTIFICATION_METHOD__ "$@"
exec "$real_codex" "$@"
"#
    .replace("__KMUX_MANAGED_MARKER__", managed_marker)
    .replace("__KMUX_CONTRACT_MARKER__", &policy.contract_marker)
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
            "../../../../../packages/agent-integration/fixtures/merge-v2.json"
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
                .contains("KMUX_AGENT_INTEGRATION_CONTRACT_VERSION=2")
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
                .contains("KMUX_AGENT_INTEGRATION_CONTRACT_VERSION=2")
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
            b"#!/bin/sh\nprintf '%s\\n' \"$@\" >\"$KMUX_TEST_RUNTIME_LOG\"\npath=\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --path ]; then shift; path=$1; fi\n  shift\ndone\n[ -n \"$path\" ] || exit 1\nmkdir -p \"$(dirname -- \"$path\")\"\nprintf '%s' '{\"command\":\"KMUX_MANAGED_CODEX_HOOK=1 KMUX_AGENT_INTEGRATION_CONTRACT_VERSION=2\"}' >\"$path\"\n",
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
