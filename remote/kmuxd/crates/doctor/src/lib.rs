#![deny(unsafe_op_in_unsafe_fn)]

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::Command;

use kmux_platform::{
    NodeIdentityBackend, NodeIdentityError, PlatformNodeIdentityBackend,
    RemoteAuthenticatedPrincipal, current_authenticated_principal, verify_host_local_path,
    verify_host_local_path_location,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

const MAX_AUTHORITY_RECORD_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug)]
pub struct DoctorPaths {
    pub install_root: PathBuf,
    pub authority_root: PathBuf,
    pub state_root: PathBuf,
    pub runtime_root: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityReport {
    pub remote_installation_id: Uuid,
    pub execution_node_id: Uuid,
    pub authenticated_principal: RemoteAuthenticatedPrincipal,
    pub platform: String,
    pub arch: String,
    pub abi: String,
    pub install_root: PathBuf,
    pub authority_root: PathBuf,
    pub state_root: PathBuf,
    pub runtime_root: PathBuf,
}

#[derive(Debug, Error)]
pub enum DoctorError {
    #[error("node identity failed: {0}")]
    NodeIdentity(#[from] NodeIdentityError),
    #[error("authority binding changed; explicit repair or rebind is required")]
    NodeBindingMismatch,
    #[error("authority record is invalid: {0}")]
    InvalidRecord(String),
    #[error("path capability failed for {path}: {source}")]
    PathCapability { path: PathBuf, source: io::Error },
    #[error("install root is not executable: {0}")]
    InstallNoExec(PathBuf),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallationRecord {
    schema_version: u32,
    remote_installation_id: Uuid,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionNodeRecord {
    schema_version: u32,
    execution_node_id: Uuid,
    node_binding_digest: String,
}

pub fn run_doctor(paths: &DoctorPaths) -> Result<AuthorityReport, DoctorError> {
    run_doctor_with_backend(paths, &PlatformNodeIdentityBackend::default())
}

pub fn run_doctor_with_backend(
    paths: &DoctorPaths,
    backend: &dyn NodeIdentityBackend,
) -> Result<AuthorityReport, DoctorError> {
    // Reject a known shared/network mount before mkdir/chmod/probe writes. The
    // completed paths are checked again below to close path replacement races.
    for path in [
        &paths.install_root,
        &paths.authority_root,
        &paths.state_root,
        &paths.runtime_root,
    ] {
        verify_host_local_path_location(path)?;
    }
    for path in [
        &paths.install_root,
        &paths.authority_root,
        &paths.state_root,
        &paths.runtime_root,
    ] {
        ensure_private_directory(path)?;
    }
    for path in [
        &paths.install_root,
        &paths.authority_root,
        &paths.state_root,
        &paths.runtime_root,
    ] {
        verify_host_local_path(path)?;
    }
    for path in [
        &paths.install_root,
        &paths.authority_root,
        &paths.state_root,
    ] {
        probe_atomic_rename_and_durability(path)?;
    }
    probe_executable(&paths.install_root)?;
    probe_runtime_socket(&paths.runtime_root)?;

    let installation_path = paths.authority_root.join("installation.json");
    let execution_path = paths.authority_root.join("execution-node.json");
    let installation: InstallationRecord = read_or_create(
        &installation_path,
        InstallationRecord {
            schema_version: 1,
            remote_installation_id: Uuid::new_v4(),
        },
    )?;
    let expected_digest = backend.binding_digest()?;
    let execution: ExecutionNodeRecord = read_or_create(
        &execution_path,
        ExecutionNodeRecord {
            schema_version: 1,
            execution_node_id: Uuid::new_v4(),
            node_binding_digest: expected_digest.clone(),
        },
    )?;
    if execution.node_binding_digest != expected_digest {
        return Err(DoctorError::NodeBindingMismatch);
    }

    Ok(AuthorityReport {
        remote_installation_id: installation.remote_installation_id,
        execution_node_id: execution.execution_node_id,
        authenticated_principal: current_authenticated_principal()?,
        platform: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        abi: if cfg!(target_env = "musl") {
            "musl".to_owned()
        } else {
            "native".to_owned()
        },
        install_root: paths.install_root.clone(),
        authority_root: paths.authority_root.clone(),
        state_root: paths.state_root.clone(),
        runtime_root: paths.runtime_root.clone(),
    })
}

fn ensure_private_directory(path: &Path) -> Result<(), DoctorError> {
    fs::create_dir_all(path).map_err(|source| DoctorError::PathCapability {
        path: path.to_owned(),
        source,
    })?;
    let metadata = fs::symlink_metadata(path).map_err(|source| DoctorError::PathCapability {
        path: path.to_owned(),
        source,
    })?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(DoctorError::PathCapability {
            path: path.to_owned(),
            source: io::Error::new(
                io::ErrorKind::InvalidInput,
                "runtime capability root must be a real directory",
            ),
        });
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|source| {
        DoctorError::PathCapability {
            path: path.to_owned(),
            source,
        }
    })?;
    Ok(())
}

fn probe_atomic_rename_and_durability(root: &Path) -> Result<(), DoctorError> {
    let suffix = Uuid::new_v4();
    let temporary = root.join(format!(".doctor-{suffix}.tmp"));
    let completed = root.join(format!(".doctor-{suffix}.complete"));
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(b"kmux-doctor")?;
        file.sync_all()?;
        fs::rename(&temporary, &completed)?;
        File::open(root)?.sync_all()?;
        fs::remove_file(&completed)?;
        File::open(root)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    let _ = fs::remove_file(&completed);
    result.map_err(|source| DoctorError::PathCapability {
        path: root.to_owned(),
        source,
    })
}

fn probe_executable(root: &Path) -> Result<(), DoctorError> {
    let probe = root.join(format!(".doctor-exec-{}", Uuid::new_v4()));
    fs::write(&probe, b"#!/bin/sh\nexit 0\n").map_err(|source| DoctorError::PathCapability {
        path: root.to_owned(),
        source,
    })?;
    fs::set_permissions(&probe, fs::Permissions::from_mode(0o700)).map_err(|source| {
        DoctorError::PathCapability {
            path: root.to_owned(),
            source,
        }
    })?;
    let status = Command::new(&probe).status();
    let _ = fs::remove_file(&probe);
    match status {
        Ok(status) if status.success() => Ok(()),
        _ => Err(DoctorError::InstallNoExec(root.to_owned())),
    }
}

fn probe_runtime_socket(root: &Path) -> Result<(), DoctorError> {
    let suffix = Uuid::new_v4().simple().to_string();
    let socket = root.join(format!(".p-{}.sock", &suffix[..8]));
    #[cfg(target_os = "macos")]
    const UNIX_SOCKET_PATH_MAX: usize = 103;
    #[cfg(target_os = "linux")]
    const UNIX_SOCKET_PATH_MAX: usize = 107;
    if socket.as_os_str().as_encoded_bytes().len() > UNIX_SOCKET_PATH_MAX {
        return Err(DoctorError::PathCapability {
            path: root.to_owned(),
            source: io::Error::new(io::ErrorKind::InvalidInput, "socket path too long"),
        });
    }
    let listener = UnixListener::bind(&socket).map_err(|source| DoctorError::PathCapability {
        path: root.to_owned(),
        source,
    })?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).map_err(|source| {
        DoctorError::PathCapability {
            path: root.to_owned(),
            source,
        }
    })?;
    drop(listener);
    fs::remove_file(&socket).map_err(|source| DoctorError::PathCapability {
        path: root.to_owned(),
        source,
    })
}

fn read_or_create<T>(path: &Path, initial: T) -> Result<T, DoctorError>
where
    T: Serialize + for<'de> Deserialize<'de> + Clone + ValidateRecord,
{
    if path.exists() {
        return read_record(path);
    }
    initial.validate()?;
    let parent = path
        .parent()
        .ok_or_else(|| DoctorError::InvalidRecord("record has no parent".to_owned()))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .ok_or_else(|| DoctorError::InvalidRecord("record has no file name".to_owned()))?
            .to_string_lossy(),
        Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec_pretty(&initial)
        .map_err(|error| DoctorError::InvalidRecord(error.to_string()))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|source| DoctorError::PathCapability {
            path: temporary.clone(),
            source,
        })?;
    if let Err(source) = file
        .write_all(&bytes)
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.sync_all())
    {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(DoctorError::PathCapability {
            path: temporary.clone(),
            source,
        });
    }
    let linked = fs::hard_link(&temporary, path);
    let _ = fs::remove_file(&temporary);
    match linked {
        Ok(()) => {
            File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|source| DoctorError::PathCapability {
                    path: parent.to_owned(),
                    source,
                })?;
            Ok(initial)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => read_record(path),
        Err(source) => Err(DoctorError::PathCapability {
            path: path.to_owned(),
            source,
        }),
    }
}

trait ValidateRecord {
    fn validate(&self) -> Result<(), DoctorError>;
}

impl ValidateRecord for InstallationRecord {
    fn validate(&self) -> Result<(), DoctorError> {
        if self.schema_version != 1 || self.remote_installation_id.is_nil() {
            return Err(DoctorError::InvalidRecord(
                "unsupported installation record".to_owned(),
            ));
        }
        Ok(())
    }
}

impl ValidateRecord for ExecutionNodeRecord {
    fn validate(&self) -> Result<(), DoctorError> {
        if self.schema_version != 1
            || self.execution_node_id.is_nil()
            || !is_lowercase_sha256(&self.node_binding_digest)
        {
            return Err(DoctorError::InvalidRecord(
                "unsupported execution-node record".to_owned(),
            ));
        }
        Ok(())
    }
}

fn read_record<T>(path: &Path) -> Result<T, DoctorError>
where
    T: for<'de> Deserialize<'de> + ValidateRecord,
{
    let metadata = fs::symlink_metadata(path).map_err(|source| DoctorError::PathCapability {
        path: path.to_owned(),
        source,
    })?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(DoctorError::InvalidRecord(
            "authority record must be a private regular file".to_owned(),
        ));
    }
    if metadata.len() == 0 || metadata.len() > MAX_AUTHORITY_RECORD_BYTES {
        return Err(DoctorError::InvalidRecord(
            "authority record exceeds its bounded size".to_owned(),
        ));
    }
    let file = File::open(path).map_err(|source| DoctorError::PathCapability {
        path: path.to_owned(),
        source,
    })?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_AUTHORITY_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| DoctorError::PathCapability {
            path: path.to_owned(),
            source,
        })?;
    if bytes.len() as u64 > MAX_AUTHORITY_RECORD_BYTES {
        return Err(DoctorError::InvalidRecord(
            "authority record exceeds its bounded size".to_owned(),
        ));
    }
    let record: T = serde_json::from_slice(&bytes)
        .map_err(|error| DoctorError::InvalidRecord(error.to_string()))?;
    record.validate()?;
    Ok(record)
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;
    use std::sync::{Arc, Barrier};

    use tempfile::TempDir;

    use super::*;

    const NODE_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const NODE_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    struct FixedNode(&'static str);

    impl NodeIdentityBackend for FixedNode {
        fn binding_digest(&self) -> Result<String, NodeIdentityError> {
            Ok(self.0.to_owned())
        }
    }

    fn paths(root: &TempDir) -> DoctorPaths {
        DoctorPaths {
            install_root: root.path().join("install"),
            authority_root: root.path().join("authority"),
            state_root: root.path().join("state"),
            runtime_root: root.path().join("run"),
        }
    }

    #[test]
    fn authority_ids_are_stable_for_the_same_node_observation() {
        let root = TempDir::new().unwrap();
        let paths = paths(&root);
        let first = run_doctor_with_backend(&paths, &FixedNode(NODE_A)).unwrap();
        let second = run_doctor_with_backend(&paths, &FixedNode(NODE_A)).unwrap();
        assert_eq!(first.remote_installation_id, second.remote_installation_id);
        assert_eq!(first.execution_node_id, second.execution_node_id);
    }

    #[test]
    fn copied_authority_record_fails_closed_on_another_node() {
        let root = TempDir::new().unwrap();
        let paths = paths(&root);
        run_doctor_with_backend(&paths, &FixedNode(NODE_A)).unwrap();
        assert!(matches!(
            run_doctor_with_backend(&paths, &FixedNode(NODE_B)),
            Err(DoctorError::NodeBindingMismatch)
        ));
    }

    #[test]
    fn concurrent_first_use_converges_on_one_authority_identity() {
        let root = TempDir::new().unwrap();
        let paths = paths(&root);
        let barrier = Arc::new(Barrier::new(8));
        let reports = std::thread::scope(|scope| {
            let handles = (0..8)
                .map(|_| {
                    let paths = paths.clone();
                    let barrier = Arc::clone(&barrier);
                    scope.spawn(move || {
                        barrier.wait();
                        run_doctor_with_backend(&paths, &FixedNode(NODE_A)).unwrap()
                    })
                })
                .collect::<Vec<_>>();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(reports.iter().all(|report| {
            report.remote_installation_id == reports[0].remote_installation_id
                && report.execution_node_id == reports[0].execution_node_id
        }));
    }

    #[test]
    fn oversized_authority_record_fails_before_json_allocation() {
        let root = TempDir::new().unwrap();
        let paths = paths(&root);
        run_doctor_with_backend(&paths, &FixedNode(NODE_A)).unwrap();
        fs::write(
            paths.authority_root.join("execution-node.json"),
            vec![b'x'; MAX_AUTHORITY_RECORD_BYTES as usize + 1],
        )
        .unwrap();
        assert!(matches!(
            run_doctor_with_backend(&paths, &FixedNode(NODE_A)),
            Err(DoctorError::InvalidRecord(message))
                if message.contains("bounded size")
        ));
    }

    #[test]
    fn capability_root_symlink_is_rejected_without_chmodding_its_target() {
        let root = TempDir::new().unwrap();
        let real_install = root.path().join("real-install");
        fs::create_dir(&real_install).unwrap();
        fs::set_permissions(&real_install, fs::Permissions::from_mode(0o755)).unwrap();
        let paths = paths(&root);
        symlink(&real_install, &paths.install_root).unwrap();

        assert!(matches!(
            run_doctor_with_backend(&paths, &FixedNode(NODE_A)),
            Err(DoctorError::PathCapability { .. })
        ));
        assert_eq!(
            fs::metadata(&real_install).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}
