#![deny(unsafe_op_in_unsafe_fn)]

use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use nix::errno::Errno;
use nix::fcntl::{Flock, FlockArg, OFlag};
use nix::sys::signal::kill;
use nix::unistd::{Pid, geteuid};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const MAX_EXECUTABLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_SENTINEL_BYTES: u64 = 16 * 1024;
const MAX_DESCRIPTOR_BYTES: u64 = 256 * 1024;
const MAX_GENERATIONS: usize = 256;
const MAX_SESSION_DESCRIPTORS: usize = 4_096;
const DEFAULT_LOCK_TIMEOUT: Duration = Duration::from_secs(30);
const STALE_STAGE_AGE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Error)]
pub enum InstallError {
    #[error("remote runtime install I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("remote runtime install JSON failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("remote runtime install is invalid: {0}")]
    Invalid(String),
    #[error("remote runtime generation install lock is busy")]
    LockBusy,
    #[error("installed runtime generation is corrupt; explicit compatibility repair is required")]
    CorruptInstalledGeneration,
}

#[derive(Clone, Debug)]
pub struct InstallGenerationOptions {
    pub stage_directory: PathBuf,
    pub install_root: PathBuf,
    pub protocol_version: u16,
    pub expected_executable_sha256: String,
    pub expected_manifest_sha256: String,
    pub lock_timeout: Duration,
}

impl InstallGenerationOptions {
    pub fn with_default_timeout(
        stage_directory: PathBuf,
        install_root: PathBuf,
        protocol_version: u16,
        expected_executable_sha256: String,
        expected_manifest_sha256: String,
    ) -> Self {
        Self {
            stage_directory,
            install_root,
            protocol_version,
            expected_executable_sha256,
            expected_manifest_sha256,
            lock_timeout: DEFAULT_LOCK_TIMEOUT,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InstallGenerationStatus {
    Installed,
    Reused,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallGenerationReport {
    pub status: InstallGenerationStatus,
    pub generation: String,
    pub runtime_path: PathBuf,
}

#[derive(Clone, Debug)]
pub struct InspectGenerationOptions {
    pub runtime_path: PathBuf,
    pub protocol_version: u16,
    pub expected_executable_sha256: String,
    pub expected_manifest_sha256: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InspectGenerationReport {
    pub generation: String,
    pub runtime_path: PathBuf,
    pub complete: bool,
}

#[derive(Clone, Debug)]
pub struct GarbageCollectOptions {
    pub install_root: PathBuf,
    pub state_root: PathBuf,
    pub current_generation: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GarbageCollectReport {
    pub inspected: usize,
    pub removed: Vec<String>,
    pub live: Vec<String>,
    pub incomplete_or_corrupt: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ResetGenerationOptions {
    pub install_root: PathBuf,
    pub state_root: PathBuf,
    pub current_generation: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ResetGenerationStatus {
    Reset,
    AlreadyAbsent,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResetGenerationReport {
    pub status: ResetGenerationStatus,
    pub generation: String,
}

#[derive(Debug)]
pub struct GenerationLease {
    _lock: Flock<File>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeManifest {
    schema_version: u32,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompletionSentinel {
    schema_version: u32,
    generation: String,
    executable_sha256: String,
    manifest_sha256: String,
}

pub fn install_generation(
    options: &InstallGenerationOptions,
) -> Result<InstallGenerationReport, InstallError> {
    validate_install_options(options)?;
    let generation = generation_name(
        options.protocol_version,
        &options.expected_executable_sha256,
    )?;
    let install_root = &options.install_root;
    require_private_directory(install_root, "install root")?;
    let bin_root = ensure_private_directory(&install_root.join("bin"))?;
    let staging_root = ensure_private_directory(&install_root.join(".install-staging"))?;
    let lock_root = ensure_private_directory(&install_root.join(".install-locks"))?;
    require_direct_child(
        &options.stage_directory,
        &staging_root,
        "runtime staging directory",
    )?;
    require_private_directory(&options.stage_directory, "runtime staging directory")?;
    validate_generation_directory(
        &options.stage_directory,
        options.protocol_version,
        &options.expected_executable_sha256,
        &options.expected_manifest_sha256,
        false,
    )?;

    let _lock = acquire_lock(
        &lock_root.join(format!("{generation}.lock")),
        LockKind::Exclusive,
        options.lock_timeout,
    )?;
    cleanup_stale_generation_stages(&staging_root, &generation, &options.stage_directory);
    let final_directory = bin_root.join(&generation);
    if final_directory.exists() {
        match validate_generation_directory(
            &final_directory,
            options.protocol_version,
            &options.expected_executable_sha256,
            &options.expected_manifest_sha256,
            true,
        ) {
            Ok(()) => {
                remove_private_tree(&options.stage_directory)?;
                return Ok(InstallGenerationReport {
                    status: InstallGenerationStatus::Reused,
                    generation,
                    runtime_path: final_directory.join("kmuxd"),
                });
            }
            Err(error) if !final_directory.join("install-complete").exists() => {
                let recovered = staging_root.join(format!(
                    ".recovered-{generation}-{}",
                    Uuid::new_v4().simple()
                ));
                fs::rename(&final_directory, &recovered)?;
                sync_directory(&bin_root)?;
                remove_private_tree(&recovered)?;
                drop(error);
            }
            Err(_) => return Err(InstallError::CorruptInstalledGeneration),
        }
    }

    let executable_path = options.stage_directory.join("kmuxd");
    let manifest_path = options.stage_directory.join("manifest.json");
    fs::set_permissions(&executable_path, fs::Permissions::from_mode(0o700))?;
    fs::set_permissions(&manifest_path, fs::Permissions::from_mode(0o600))?;
    File::open(&executable_path)?.sync_all()?;
    File::open(&manifest_path)?.sync_all()?;
    let sentinel = CompletionSentinel {
        schema_version: 1,
        generation: generation.clone(),
        executable_sha256: options.expected_executable_sha256.clone(),
        manifest_sha256: options.expected_manifest_sha256.clone(),
    };
    write_new_private_file(
        &options.stage_directory.join("install-complete"),
        &serde_json::to_vec(&sentinel)?,
    )?;
    sync_directory(&options.stage_directory)?;
    fs::rename(&options.stage_directory, &final_directory)?;
    sync_directory(&bin_root)?;
    validate_generation_directory(
        &final_directory,
        options.protocol_version,
        &options.expected_executable_sha256,
        &options.expected_manifest_sha256,
        true,
    )?;
    Ok(InstallGenerationReport {
        status: InstallGenerationStatus::Installed,
        generation,
        runtime_path: final_directory.join("kmuxd"),
    })
}

pub fn inspect_generation(
    options: &InspectGenerationOptions,
) -> Result<InspectGenerationReport, InstallError> {
    if !options.runtime_path.is_absolute()
        || options
            .runtime_path
            .file_name()
            .and_then(|value| value.to_str())
            != Some("kmuxd")
    {
        return Err(InstallError::Invalid(
            "runtime inspection path must name an absolute kmuxd executable".to_owned(),
        ));
    }
    let generation = generation_name(
        options.protocol_version,
        &options.expected_executable_sha256,
    )?;
    let directory = options.runtime_path.parent().ok_or_else(|| {
        InstallError::Invalid("runtime inspection path has no generation directory".to_owned())
    })?;
    if directory.file_name().and_then(|value| value.to_str()) != Some(generation.as_str()) {
        return Err(InstallError::Invalid(
            "runtime executable is outside its content-addressed generation".to_owned(),
        ));
    }
    validate_generation_directory(
        directory,
        options.protocol_version,
        &options.expected_executable_sha256,
        &options.expected_manifest_sha256,
        true,
    )?;
    Ok(InspectGenerationReport {
        generation,
        runtime_path: options.runtime_path.clone(),
        complete: true,
    })
}

pub fn acquire_current_generation_lease() -> Result<Option<GenerationLease>, InstallError> {
    let executable = std::env::current_exe()?.canonicalize()?;
    let Some(generation_directory) = executable.parent() else {
        return Ok(None);
    };
    let Some(bin_root) = generation_directory.parent() else {
        return Ok(None);
    };
    let Some(install_root) = bin_root.parent() else {
        return Ok(None);
    };
    if bin_root.file_name().and_then(|value| value.to_str()) != Some("bin") {
        return Ok(None);
    }
    let Some(generation) = generation_directory
        .file_name()
        .and_then(|value| value.to_str())
    else {
        return Ok(None);
    };
    if parse_generation_name(generation).is_none() {
        return Ok(None);
    }
    let lease_root = ensure_private_directory(&install_root.join(".generation-leases"))?;
    let lock = acquire_lock(
        &lease_root.join(format!("{generation}.lock")),
        LockKind::Shared,
        DEFAULT_LOCK_TIMEOUT,
    )?;
    Ok(Some(GenerationLease { _lock: lock }))
}

pub fn garbage_collect_generations(
    options: &GarbageCollectOptions,
) -> Result<GarbageCollectReport, InstallError> {
    if !options.install_root.is_absolute() || !options.state_root.is_absolute() {
        return Err(InstallError::Invalid(
            "generation GC roots must be absolute".to_owned(),
        ));
    }
    if parse_generation_name(&options.current_generation).is_none() {
        return Err(InstallError::Invalid(
            "current generation identity is invalid".to_owned(),
        ));
    }
    require_private_directory(&options.install_root, "install root")?;
    let bin_root = ensure_private_directory(&options.install_root.join("bin"))?;
    let gc_root = ensure_private_directory(&options.install_root.join(".generation-gc"))?;
    let lease_root = ensure_private_directory(&options.install_root.join(".generation-leases"))?;
    let protected = collect_live_descriptor_generations(&options.state_root)?;
    let mut generation_names = fs::read_dir(&bin_root)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if parse_generation_name(&name).is_some() {
                Some(name)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    generation_names.sort();
    if generation_names.len() > MAX_GENERATIONS {
        return Err(InstallError::Invalid(
            "runtime generation inventory exceeds its hard bound".to_owned(),
        ));
    }
    let mut report = GarbageCollectReport {
        inspected: generation_names.len(),
        removed: Vec::new(),
        live: Vec::new(),
        incomplete_or_corrupt: Vec::new(),
    };
    for generation in generation_names {
        let Some((protocol_version, executable_sha256)) = parse_generation_name(&generation) else {
            continue;
        };
        if generation == options.current_generation || protected.contains(executable_sha256) {
            report.live.push(generation);
            continue;
        }
        let directory = bin_root.join(&generation);
        let manifest_sha256 = match manifest_sha256(&directory.join("manifest.json")) {
            Ok(value) => value,
            Err(_) => {
                report.incomplete_or_corrupt.push(generation);
                continue;
            }
        };
        if validate_generation_directory(
            &directory,
            protocol_version,
            executable_sha256,
            &manifest_sha256,
            true,
        )
        .is_err()
        {
            report.incomplete_or_corrupt.push(generation);
            continue;
        }
        let lease =
            match try_acquire_exclusive_lock(&lease_root.join(format!("{generation}.lock")))? {
                Some(lock) => lock,
                None => {
                    report.live.push(generation);
                    continue;
                }
            };
        let quarantined = gc_root.join(format!("{generation}.{}", Uuid::new_v4().simple()));
        fs::rename(&directory, &quarantined)?;
        sync_directory(&bin_root)?;
        drop(lease);
        remove_private_tree(&quarantined)?;
        sync_directory(&gc_root)?;
        report.removed.push(generation);
    }
    Ok(report)
}

pub fn reset_generation(
    options: &ResetGenerationOptions,
) -> Result<ResetGenerationReport, InstallError> {
    if !options.install_root.is_absolute() || !options.state_root.is_absolute() {
        return Err(InstallError::Invalid(
            "generation reset roots must be absolute".to_owned(),
        ));
    }
    let Some((_protocol_version, executable_sha256)) =
        parse_generation_name(&options.current_generation)
    else {
        return Err(InstallError::Invalid(
            "generation reset identity is invalid".to_owned(),
        ));
    };
    require_private_directory(&options.install_root, "install root")?;
    let bin_root = ensure_private_directory(&options.install_root.join("bin"))?;
    let gc_root = ensure_private_directory(&options.install_root.join(".generation-gc"))?;
    let lease_root = ensure_private_directory(&options.install_root.join(".generation-leases"))?;
    let install_lock_root = ensure_private_directory(&options.install_root.join(".install-locks"))?;
    let Some(_install_lock) = try_acquire_exclusive_lock(
        &install_lock_root.join(format!("{}.lock", options.current_generation)),
    )?
    else {
        return Err(InstallError::Invalid(
            "runtime generation install is in progress".to_owned(),
        ));
    };
    if collect_live_descriptor_generations(&options.state_root)?.contains(executable_sha256) {
        return Err(InstallError::Invalid(
            "runtime generation is referenced by a live keeper".to_owned(),
        ));
    }

    let directory = bin_root.join(&options.current_generation);
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ResetGenerationReport {
                status: ResetGenerationStatus::AlreadyAbsent,
                generation: options.current_generation.clone(),
            });
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != geteuid().as_raw()
    {
        return Err(InstallError::Invalid(
            "runtime generation reset path is unsafe".to_owned(),
        ));
    }
    let Some(lease) = try_acquire_exclusive_lock(
        &lease_root.join(format!("{}.lock", options.current_generation)),
    )?
    else {
        return Err(InstallError::Invalid(
            "runtime generation is still in use".to_owned(),
        ));
    };
    let quarantined = gc_root.join(format!(
        "{}.reset.{}",
        options.current_generation,
        Uuid::new_v4().simple()
    ));
    fs::rename(&directory, &quarantined)?;
    sync_directory(&bin_root)?;
    remove_private_tree(&quarantined)?;
    sync_directory(&gc_root)?;
    drop(lease);
    Ok(ResetGenerationReport {
        status: ResetGenerationStatus::Reset,
        generation: options.current_generation.clone(),
    })
}

fn validate_install_options(options: &InstallGenerationOptions) -> Result<(), InstallError> {
    if !options.stage_directory.is_absolute() || !options.install_root.is_absolute() {
        return Err(InstallError::Invalid(
            "runtime install roots must be absolute".to_owned(),
        ));
    }
    if options.protocol_version == 0
        || !is_sha256(&options.expected_executable_sha256)
        || !is_sha256(&options.expected_manifest_sha256)
        || options.lock_timeout.is_zero()
        || options.lock_timeout > Duration::from_secs(5 * 60)
    {
        return Err(InstallError::Invalid(
            "runtime generation identity or lock timeout is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_generation_directory(
    directory: &Path,
    protocol_version: u16,
    expected_executable_sha256: &str,
    expected_manifest_sha256: &str,
    require_complete: bool,
) -> Result<(), InstallError> {
    require_private_directory(directory, "runtime generation directory")?;
    let executable_path = directory.join("kmuxd");
    let manifest_path = directory.join("manifest.json");
    let executable = hash_private_file(&executable_path, MAX_EXECUTABLE_BYTES, true)?;
    let manifest_bytes = read_private_file(&manifest_path, MAX_MANIFEST_BYTES, false)?;
    let actual_manifest_sha256 = sha256_bytes(&manifest_bytes);
    if executable.sha256 != expected_executable_sha256
        || actual_manifest_sha256 != expected_manifest_sha256
    {
        return Err(InstallError::Invalid(
            "runtime staging read-back digest changed".to_owned(),
        ));
    }
    let manifest: RuntimeManifest = serde_json::from_slice(&manifest_bytes)?;
    validate_manifest(
        &manifest,
        protocol_version,
        expected_executable_sha256,
        executable.bytes,
    )?;
    if require_complete {
        let sentinel_bytes = read_private_file(
            &directory.join("install-complete"),
            MAX_SENTINEL_BYTES,
            false,
        )?;
        let sentinel: CompletionSentinel = serde_json::from_slice(&sentinel_bytes)?;
        let generation = generation_name(protocol_version, expected_executable_sha256)?;
        if sentinel.schema_version != 1
            || sentinel.generation != generation
            || sentinel.executable_sha256 != expected_executable_sha256
            || sentinel.manifest_sha256 != expected_manifest_sha256
        {
            return Err(InstallError::Invalid(
                "runtime completion sentinel does not match its generation".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_manifest(
    manifest: &RuntimeManifest,
    protocol_version: u16,
    expected_sha256: &str,
    executable_bytes: u64,
) -> Result<(), InstallError> {
    let tuple_valid = matches!(
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
    );
    let host_tuple_valid = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        manifest.target == "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        manifest.target == "darwin-x64"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        manifest.target == "linux-arm64-musl"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        manifest.target == "linux-x64-musl"
    } else {
        false
    };
    if manifest.schema_version != 1
        || !tuple_valid
        || !host_tuple_valid
        || manifest.runtime_version.is_empty()
        || manifest.runtime_version.len() > 256
        || manifest.runtime_version.chars().any(char::is_control)
        || manifest.remote_protocol_min == 0
        || manifest.remote_protocol_min > protocol_version
        || manifest.remote_protocol_max < protocol_version
        || manifest.remote_protocol_min > manifest.remote_protocol_max
        || manifest.keeper_local_protocol_major == 0
        || manifest.terminal_wire_version == 0
        || manifest.executable != "kmuxd"
        || manifest.sha256 != expected_sha256
        || manifest.bytes != executable_bytes
    {
        return Err(InstallError::Invalid(
            "runtime manifest does not match its artifact or protocol".to_owned(),
        ));
    }
    Ok(())
}

struct FileDigest {
    sha256: String,
    bytes: u64,
}

fn hash_private_file(
    path: &Path,
    maximum_bytes: u64,
    executable: bool,
) -> Result<FileDigest, InstallError> {
    let mut file = open_private_file(path, maximum_bytes, executable)?;
    let bytes = file.metadata()?.len();
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 16 * 1024];
    let mut read_bytes = 0_u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        read_bytes = read_bytes.saturating_add(count as u64);
        if read_bytes > maximum_bytes {
            return Err(InstallError::Invalid(
                "runtime artifact exceeds its hard byte bound".to_owned(),
            ));
        }
        hasher.update(&buffer[..count]);
    }
    Ok(FileDigest {
        sha256: format!("{:x}", hasher.finalize()),
        bytes,
    })
}

fn manifest_sha256(path: &Path) -> Result<String, InstallError> {
    Ok(sha256_bytes(&read_private_file(
        path,
        MAX_MANIFEST_BYTES,
        false,
    )?))
}

fn read_private_file(
    path: &Path,
    maximum_bytes: u64,
    executable: bool,
) -> Result<Vec<u8>, InstallError> {
    let file = open_private_file(path, maximum_bytes, executable)?;
    let mut bytes = Vec::with_capacity(file.metadata()?.len() as usize);
    file.take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum_bytes {
        return Err(InstallError::Invalid(
            "runtime metadata exceeds its hard byte bound".to_owned(),
        ));
    }
    Ok(bytes)
}

fn open_private_file(
    path: &Path,
    maximum_bytes: u64,
    executable: bool,
) -> Result<File, InstallError> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(OFlag::O_NOFOLLOW.bits())
        .open(path)?;
    let metadata = file.metadata()?;
    let mode = metadata.mode();
    if !metadata.is_file()
        || metadata.uid() != geteuid().as_raw()
        || metadata.len() == 0
        || metadata.len() > maximum_bytes
        || mode & 0o077 != 0
        || (executable && mode & 0o100 == 0)
    {
        return Err(InstallError::Invalid(
            "runtime artifact is missing, unsafe, or oversized".to_owned(),
        ));
    }
    Ok(file)
}

fn collect_live_descriptor_generations(
    state_root: &Path,
) -> Result<BTreeSet<String>, InstallError> {
    let sessions = state_root.join("sessions");
    let metadata = match fs::symlink_metadata(&sessions) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(BTreeSet::new());
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
    {
        return Err(InstallError::Invalid(
            "session descriptor root is unsafe".to_owned(),
        ));
    }
    let mut files = Vec::new();
    collect_regular_files(&sessions, &mut files)?;
    if files.len() > MAX_SESSION_DESCRIPTORS {
        return Err(InstallError::Invalid(
            "session descriptor inventory exceeds its hard bound".to_owned(),
        ));
    }
    let mut protected = BTreeSet::new();
    for path in files {
        let bytes = read_private_file(&path, MAX_DESCRIPTOR_BYTES, false)?;
        let value: serde_json::Value = serde_json::from_slice(&bytes)?;
        let Some(record) = value.as_object() else {
            return Err(InstallError::Invalid(
                "session descriptor is not an object".to_owned(),
            ));
        };
        let Some(generation_hash) = record
            .get("executableGeneration")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        if !is_sha256(generation_hash) {
            return Err(InstallError::Invalid(
                "session descriptor executable generation is invalid".to_owned(),
            ));
        }
        let state = record
            .get("state")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown");
        if matches!(state, "exited" | "terminated") {
            continue;
        }
        let live = match record.get("keeperPid").and_then(serde_json::Value::as_u64) {
            Some(pid) if pid > 1 && pid <= i32::MAX as u64 => process_is_live(pid as i32),
            _ => true,
        };
        if !live {
            continue;
        }
        // Descriptors store the executable content hash, while generation
        // directories additionally carry the negotiated remote protocol.
        protected.insert(generation_hash.to_owned());
    }
    Ok(protected)
}

fn collect_regular_files(root: &Path, files: &mut Vec<PathBuf>) -> Result<(), InstallError> {
    if files.len() > MAX_SESSION_DESCRIPTORS {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            return Err(InstallError::Invalid(
                "session descriptor tree contains a symbolic link".to_owned(),
            ));
        }
        if metadata.is_dir() {
            collect_regular_files(&entry.path(), files)?;
        } else if metadata.is_file()
            && entry.path().extension().and_then(|value| value.to_str()) == Some("json")
        {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn process_is_live(pid: i32) -> bool {
    match kill(Pid::from_raw(pid), None) {
        Ok(()) | Err(Errno::EPERM) => true,
        Err(Errno::ESRCH) => false,
        Err(_) => true,
    }
}

fn generation_name(protocol_version: u16, executable_sha256: &str) -> Result<String, InstallError> {
    if protocol_version == 0 || !is_sha256(executable_sha256) {
        return Err(InstallError::Invalid(
            "runtime generation identity is invalid".to_owned(),
        ));
    }
    Ok(format!("{protocol_version}+{executable_sha256}"))
}

fn parse_generation_name(value: &str) -> Option<(u16, &str)> {
    let (protocol, hash) = value.split_once('+')?;
    let protocol = protocol.parse::<u16>().ok()?;
    if protocol == 0 || !is_sha256(hash) {
        return None;
    }
    Some((protocol, hash))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn require_direct_child(path: &Path, parent: &Path, name: &str) -> Result<(), InstallError> {
    if path.parent() != Some(parent) || path.file_name().is_none() {
        return Err(InstallError::Invalid(format!(
            "{name} must be a direct child of the install staging root"
        )));
    }
    Ok(())
}

fn require_private_directory(path: &Path, name: &str) -> Result<(), InstallError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
    {
        return Err(InstallError::Invalid(format!("{name} is not private")));
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<PathBuf, InstallError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || metadata.uid() != geteuid().as_raw()
            {
                return Err(InstallError::Invalid(
                    "runtime install directory is unsafe".to_owned(),
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if let Err(create_error) = fs::create_dir(path)
                && create_error.kind() != io::ErrorKind::AlreadyExists
            {
                return Err(create_error.into());
            }
        }
        Err(error) => return Err(error.into()),
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    require_private_directory(path, "runtime install directory")?;
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(path.to_owned())
}

fn write_new_private_file(path: &Path, bytes: &[u8]) -> Result<(), InstallError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(OFlag::O_NOFOLLOW.bits())
        .open(path)?;
    file.write_all(bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), InstallError> {
    File::open(path)?.sync_all()?;
    Ok(())
}

fn remove_private_tree(path: &Path) -> Result<(), InstallError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != geteuid().as_raw()
    {
        return Err(InstallError::Invalid(
            "runtime cleanup path is unsafe".to_owned(),
        ));
    }
    fs::remove_dir_all(path)?;
    Ok(())
}

fn cleanup_stale_generation_stages(staging_root: &Path, generation: &str, current_stage: &Path) {
    let Ok(entries) = fs::read_dir(staging_root) else {
        return;
    };
    let prefix = format!("{generation}.");
    for entry in entries.take(MAX_GENERATIONS) {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if path == current_stage || !entry.file_name().to_string_lossy().starts_with(&prefix) {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != geteuid().as_raw()
        {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if SystemTime::now()
            .duration_since(modified)
            .is_ok_and(|age| age >= STALE_STAGE_AGE)
        {
            let _ = remove_private_tree(&path);
            let _ = sync_directory(staging_root);
        }
    }
}

enum LockKind {
    Shared,
    Exclusive,
}

fn acquire_lock(
    path: &Path,
    kind: LockKind,
    timeout: Duration,
) -> Result<Flock<File>, InstallError> {
    let file = open_lock_file(path)?;
    let deadline = Instant::now() + timeout;
    let mut file = file;
    loop {
        let argument = match kind {
            LockKind::Shared => FlockArg::LockSharedNonblock,
            LockKind::Exclusive => FlockArg::LockExclusiveNonblock,
        };
        match Flock::lock(file, argument) {
            Ok(lock) => return Ok(lock),
            Err((returned, Errno::EAGAIN)) => {
                file = returned;
                if Instant::now() >= deadline {
                    return Err(InstallError::LockBusy);
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err((_returned, error)) => {
                return Err(io::Error::from_raw_os_error(error as i32).into());
            }
        }
    }
}

fn try_acquire_exclusive_lock(path: &Path) -> Result<Option<Flock<File>>, InstallError> {
    let file = open_lock_file(path)?;
    match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
        Ok(lock) => Ok(Some(lock)),
        Err((_returned, Errno::EAGAIN)) => Ok(None),
        Err((_returned, error)) => Err(io::Error::from_raw_os_error(error as i32).into()),
    }
}

fn open_lock_file(path: &Path) -> Result<File, InstallError> {
    let parent = path
        .parent()
        .ok_or_else(|| InstallError::Invalid("generation lock has no parent".to_owned()))?;
    ensure_private_directory(parent)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(OFlag::O_NOFOLLOW.bits())
        .open(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != geteuid().as_raw() || metadata.mode() & 0o077 != 0 {
        return Err(InstallError::Invalid(
            "runtime generation lock is unsafe".to_owned(),
        ));
    }
    sync_directory(parent)?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use tempfile::TempDir;

    use super::*;

    const EXECUTABLE: &[u8] = b"#!/bin/sh\nexit 0\n";

    fn fixture(root: &TempDir, stage_name: &str) -> InstallGenerationOptions {
        let install_root = root.path().join("install");
        fs::create_dir_all(install_root.join(".install-staging")).unwrap();
        fs::set_permissions(&install_root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(
            install_root.join(".install-staging"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let stage = install_root.join(".install-staging").join(stage_name);
        fs::create_dir(&stage).unwrap();
        fs::set_permissions(&stage, fs::Permissions::from_mode(0o700)).unwrap();
        let executable_sha256 = sha256_bytes(EXECUTABLE);
        fs::write(stage.join("kmuxd"), EXECUTABLE).unwrap();
        fs::set_permissions(stage.join("kmuxd"), fs::Permissions::from_mode(0o700)).unwrap();
        let (target, platform, arch, abi, signed) =
            if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                ("darwin-arm64", "darwin", "arm64", "native", true)
            } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
                ("darwin-x64", "darwin", "x64", "native", true)
            } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
                ("linux-arm64-musl", "linux", "arm64", "musl", false)
            } else {
                ("linux-x64-musl", "linux", "x64", "musl", false)
            };
        let manifest = serde_json::json!({
            "schemaVersion": 1,
            "target": target,
            "platform": platform,
            "arch": arch,
            "abi": abi,
            "runtimeVersion": "0.1.0",
            "remoteProtocolMin": 1,
            "remoteProtocolMax": 1,
            "keeperLocalProtocolMajor": 1,
            "terminalWireVersion": 1,
            "executable": "kmuxd",
            "sha256": executable_sha256,
            "bytes": EXECUTABLE.len(),
            "signed": signed
        });
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap();
        fs::write(stage.join("manifest.json"), &manifest_bytes).unwrap();
        fs::set_permissions(
            stage.join("manifest.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        InstallGenerationOptions::with_default_timeout(
            stage,
            install_root,
            1,
            executable_sha256,
            sha256_bytes(&manifest_bytes),
        )
    }

    #[test]
    fn installs_one_complete_content_addressed_generation() {
        let root = TempDir::new().unwrap();
        let options = fixture(&root, "stage-a");
        let report = install_generation(&options).unwrap();
        assert_eq!(report.status, InstallGenerationStatus::Installed);
        assert_eq!(report.runtime_path.file_name().unwrap(), "kmuxd");
        assert!(
            report
                .runtime_path
                .parent()
                .unwrap()
                .join("install-complete")
                .is_file()
        );
        inspect_generation(&InspectGenerationOptions {
            runtime_path: report.runtime_path,
            protocol_version: 1,
            expected_executable_sha256: options.expected_executable_sha256,
            expected_manifest_sha256: options.expected_manifest_sha256,
        })
        .unwrap();
    }

    #[test]
    fn concurrent_installers_converge_without_overwriting() {
        let root = TempDir::new().unwrap();
        let first = fixture(&root, "stage-a");
        let second = fixture(&root, "stage-b");
        let barrier = Arc::new(Barrier::new(2));
        let reports = std::thread::scope(|scope| {
            let first_barrier = Arc::clone(&barrier);
            let first = scope.spawn(move || {
                first_barrier.wait();
                install_generation(&first).unwrap()
            });
            let second_barrier = Arc::clone(&barrier);
            let second = scope.spawn(move || {
                second_barrier.wait();
                install_generation(&second).unwrap()
            });
            [first.join().unwrap(), second.join().unwrap()]
        });
        assert_eq!(reports[0].runtime_path, reports[1].runtime_path);
        assert_eq!(
            reports
                .iter()
                .filter(|report| report.status == InstallGenerationStatus::Installed)
                .count(),
            1
        );
        assert_eq!(
            reports
                .iter()
                .filter(|report| report.status == InstallGenerationStatus::Reused)
                .count(),
            1
        );
    }

    #[test]
    fn corrupt_readback_never_creates_a_completed_generation() {
        let root = TempDir::new().unwrap();
        let options = fixture(&root, "stage-a");
        fs::write(options.stage_directory.join("kmuxd"), b"changed").unwrap();
        assert!(install_generation(&options).is_err());
        assert!(
            fs::read_dir(options.install_root.join("bin"))
                .unwrap()
                .next()
                .is_none()
        );
    }

    #[test]
    fn recovers_an_incomplete_final_directory_under_the_generation_lock() {
        let root = TempDir::new().unwrap();
        let options = fixture(&root, "stage-a");
        let generation = generation_name(1, &options.expected_executable_sha256).unwrap();
        let bin = options.install_root.join("bin");
        fs::create_dir(&bin).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
        let partial = bin.join(generation);
        fs::create_dir(&partial).unwrap();
        fs::set_permissions(&partial, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(partial.join("partial"), b"partial").unwrap();
        let report = install_generation(&options).unwrap();
        assert_eq!(report.status, InstallGenerationStatus::Installed);
        assert!(report.runtime_path.is_file());
    }

    #[test]
    fn recovers_a_stale_crash_stage_without_touching_the_current_stage() {
        let root = TempDir::new().unwrap();
        let options = fixture(&root, "stage-current");
        let generation = generation_name(1, &options.expected_executable_sha256).unwrap();
        let stale = options
            .install_root
            .join(".install-staging")
            .join(format!("{generation}.crashed"));
        fs::create_dir(&stale).unwrap();
        fs::set_permissions(&stale, fs::Permissions::from_mode(0o700)).unwrap();
        File::open(&stale)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(SystemTime::now() - Duration::from_secs(2 * 60 * 60)),
            )
            .unwrap();
        let report = install_generation(&options).unwrap();
        assert!(report.runtime_path.is_file());
        assert!(!stale.exists());
    }

    #[test]
    fn gc_removes_only_complete_unreferenced_generations() {
        let root = TempDir::new().unwrap();
        let current_options = fixture(&root, "stage-current");
        let current = install_generation(&current_options).unwrap();
        let old_options = fixture(&root, "stage-old");
        let mut old_bytes = EXECUTABLE.to_vec();
        old_bytes.extend_from_slice(b"# old\n");
        let old_hash = sha256_bytes(&old_bytes);
        fs::write(old_options.stage_directory.join("kmuxd"), &old_bytes).unwrap();
        fs::set_permissions(
            old_options.stage_directory.join("kmuxd"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let mut old_manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(old_options.stage_directory.join("manifest.json")).unwrap(),
        )
        .unwrap();
        old_manifest["sha256"] = old_hash.clone().into();
        old_manifest["bytes"] = old_bytes.len().into();
        let old_manifest_bytes = serde_json::to_vec_pretty(&old_manifest).unwrap();
        fs::write(
            old_options.stage_directory.join("manifest.json"),
            &old_manifest_bytes,
        )
        .unwrap();
        let old = install_generation(&InstallGenerationOptions {
            expected_executable_sha256: old_hash,
            expected_manifest_sha256: sha256_bytes(&old_manifest_bytes),
            ..old_options
        })
        .unwrap();
        let incomplete = current_options
            .install_root
            .join("bin/1+")
            .join("not-a-generation");
        fs::create_dir_all(&incomplete).unwrap();
        let gc_options = GarbageCollectOptions {
            install_root: current_options.install_root.clone(),
            state_root: root.path().join("state"),
            current_generation: current.generation,
        };
        let live_lease = acquire_lock(
            &current_options
                .install_root
                .join(".generation-leases")
                .join(format!("{}.lock", old.generation)),
            LockKind::Shared,
            DEFAULT_LOCK_TIMEOUT,
        )
        .unwrap();
        let protected = garbage_collect_generations(&gc_options).unwrap();
        assert!(protected.removed.is_empty());
        assert!(protected.live.contains(&old.generation));
        assert!(old.runtime_path.exists());
        drop(live_lease);
        let report = garbage_collect_generations(&gc_options).unwrap();
        assert_eq!(report.removed, vec![old.generation]);
        assert!(!old.runtime_path.exists());
        assert!(incomplete.exists());
    }

    #[test]
    fn explicit_reset_removes_only_an_idle_current_generation() {
        let root = TempDir::new().unwrap();
        let options = fixture(&root, "stage-current");
        let installed = install_generation(&options).unwrap();
        let reset = ResetGenerationOptions {
            install_root: options.install_root.clone(),
            state_root: root.path().join("state"),
            current_generation: installed.generation.clone(),
        };

        let report = reset_generation(&reset).unwrap();
        assert_eq!(report.status, ResetGenerationStatus::Reset);
        assert_eq!(report.generation, installed.generation);
        assert!(!installed.runtime_path.exists());
        assert_eq!(
            reset_generation(&reset).unwrap().status,
            ResetGenerationStatus::AlreadyAbsent
        );
    }

    #[test]
    fn explicit_reset_refuses_live_keeper_or_generation_lease() {
        let root = TempDir::new().unwrap();
        let options = fixture(&root, "stage-current");
        let installed = install_generation(&options).unwrap();
        let state_root = root.path().join("state");
        let sessions = state_root.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::set_permissions(&state_root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&sessions, fs::Permissions::from_mode(0o700)).unwrap();
        let descriptor = sessions.join("live.json");
        fs::write(
            &descriptor,
            serde_json::to_vec(&serde_json::json!({
                "executableGeneration": options.expected_executable_sha256.clone(),
                "state": "running",
                "keeperPid": std::process::id()
            }))
            .unwrap(),
        )
        .unwrap();
        fs::set_permissions(&descriptor, fs::Permissions::from_mode(0o600)).unwrap();
        let reset = ResetGenerationOptions {
            install_root: options.install_root.clone(),
            state_root,
            current_generation: installed.generation.clone(),
        };

        assert!(reset_generation(&reset).is_err());
        assert!(installed.runtime_path.exists());

        fs::write(
            &descriptor,
            serde_json::to_vec(&serde_json::json!({
                "executableGeneration": options.expected_executable_sha256.clone(),
                "state": "terminated",
                "keeperPid": std::process::id()
            }))
            .unwrap(),
        )
        .unwrap();
        let live_lease = acquire_lock(
            &options
                .install_root
                .join(".generation-leases")
                .join(format!("{}.lock", installed.generation)),
            LockKind::Shared,
            DEFAULT_LOCK_TIMEOUT,
        )
        .unwrap();
        assert!(reset_generation(&reset).is_err());
        assert!(installed.runtime_path.exists());
        drop(live_lease);

        let install_lock = acquire_lock(
            &options
                .install_root
                .join(".install-locks")
                .join(format!("{}.lock", installed.generation)),
            LockKind::Exclusive,
            DEFAULT_LOCK_TIMEOUT,
        )
        .unwrap();
        assert!(reset_generation(&reset).is_err());
        assert!(installed.runtime_path.exists());
        drop(install_lock);
        assert_eq!(
            reset_generation(&reset).unwrap().status,
            ResetGenerationStatus::Reset
        );
    }
}
