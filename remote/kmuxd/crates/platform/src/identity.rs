use std::ffi::CString;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;

use nix::unistd::{Uid, User};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAuthenticatedPrincipal {
    pub uid: u32,
    pub account_name: String,
}

#[derive(Debug, Error)]
pub enum NodeIdentityError {
    #[error("authenticated UID has no canonical account record")]
    PrincipalUnavailable,
    #[error("canonical account name is not valid UTF-8")]
    PrincipalEncoding,
    #[error("node observation is unavailable: {0}")]
    ObservationUnavailable(String),
    #[error("node observation is empty, malformed, or known-generic")]
    ObservationInvalid,
    #[error("path is not on verified host-local storage: {0}")]
    SharedFilesystem(PathBuf),
    #[error("path probe failed for {path}: {source}")]
    PathProbe {
        path: PathBuf,
        source: std::io::Error,
    },
}

pub trait NodeIdentityBackend: Send + Sync {
    fn binding_digest(&self) -> Result<String, NodeIdentityError>;
}

#[derive(Clone, Debug)]
#[cfg_attr(target_os = "macos", derive(Default))]
pub struct PlatformNodeIdentityBackend {
    #[cfg(target_os = "linux")]
    machine_id_path: PathBuf,
}

#[cfg(target_os = "linux")]
impl Default for PlatformNodeIdentityBackend {
    fn default() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            machine_id_path: PathBuf::from("/etc/machine-id"),
        }
    }
}

#[cfg(target_os = "linux")]
impl PlatformNodeIdentityBackend {
    #[cfg(test)]
    pub fn with_machine_id_path(path: impl Into<PathBuf>) -> Self {
        Self {
            machine_id_path: path.into(),
        }
    }
}

impl NodeIdentityBackend for PlatformNodeIdentityBackend {
    fn binding_digest(&self) -> Result<String, NodeIdentityError> {
        #[cfg(target_os = "linux")]
        let observation = fs::read_to_string(&self.machine_id_path).map_err(|error| {
            NodeIdentityError::ObservationUnavailable(format!(
                "{}: {error}",
                self.machine_id_path.display()
            ))
        })?;

        #[cfg(target_os = "macos")]
        let observation = {
            let output = Command::new("/usr/sbin/ioreg")
                .args(["-rd1", "-c", "IOPlatformExpertDevice"])
                .output()
                .map_err(|error| NodeIdentityError::ObservationUnavailable(error.to_string()))?;
            if !output.status.success() {
                return Err(NodeIdentityError::ObservationUnavailable(
                    String::from_utf8_lossy(&output.stderr).into_owned(),
                ));
            }
            let stdout = String::from_utf8(output.stdout)
                .map_err(|_| NodeIdentityError::ObservationInvalid)?;
            stdout
                .lines()
                .find_map(|line| {
                    let (_, value) = line.split_once("IOPlatformUUID")?;
                    let (_, value) = value.split_once('=')?;
                    Some(value.trim().trim_matches('"').to_owned())
                })
                .ok_or(NodeIdentityError::ObservationInvalid)?
        };

        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        compile_error!("kmuxd supports only Linux and macOS remote targets");

        digest_observation(&observation)
    }
}

pub fn current_authenticated_principal() -> Result<RemoteAuthenticatedPrincipal, NodeIdentityError>
{
    let uid = Uid::effective();
    let user = User::from_uid(uid)
        .map_err(|_| NodeIdentityError::PrincipalUnavailable)?
        .ok_or(NodeIdentityError::PrincipalUnavailable)?;
    if user.name.is_empty() {
        return Err(NodeIdentityError::PrincipalEncoding);
    }
    Ok(RemoteAuthenticatedPrincipal {
        uid: uid.as_raw(),
        account_name: user.name,
    })
}

pub fn current_authenticated_home() -> Result<PathBuf, NodeIdentityError> {
    let user = User::from_uid(Uid::effective())
        .map_err(|_| NodeIdentityError::PrincipalUnavailable)?
        .ok_or(NodeIdentityError::PrincipalUnavailable)?;
    if !user.dir.is_absolute() {
        return Err(NodeIdentityError::PrincipalUnavailable);
    }
    Ok(user.dir)
}

pub fn verify_host_local_path(path: &Path) -> Result<(), NodeIdentityError> {
    let canonical = path
        .canonicalize()
        .map_err(|source| NodeIdentityError::PathProbe {
            path: path.to_owned(),
            source,
        })?;
    let c_path = CString::new(canonical.as_os_str().as_encoded_bytes())
        .map_err(|_| NodeIdentityError::ObservationInvalid)?;

    #[cfg(target_os = "linux")]
    {
        let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: c_path is NUL-terminated and stats points to writable storage.
        let result = unsafe { libc::statfs(c_path.as_ptr(), stats.as_mut_ptr()) };
        if result != 0 {
            return Err(NodeIdentityError::PathProbe {
                path: canonical,
                source: std::io::Error::last_os_error(),
            });
        }
        // SAFETY: statfs returned success and initialized stats.
        let stats = unsafe { stats.assume_init() };
        if linux_filesystem_is_shared(stats.f_type as libc::c_long) {
            return Err(NodeIdentityError::SharedFilesystem(canonical));
        }
    }

    #[cfg(target_os = "macos")]
    {
        let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: c_path is NUL-terminated and stats points to writable storage.
        let result = unsafe { libc::statfs(c_path.as_ptr(), stats.as_mut_ptr()) };
        if result != 0 {
            return Err(NodeIdentityError::PathProbe {
                path: canonical,
                source: std::io::Error::last_os_error(),
            });
        }
        // SAFETY: statfs returned success and initialized stats.
        let stats = unsafe { stats.assume_init() };
        if macos_filesystem_is_shared(stats.f_flags) {
            return Err(NodeIdentityError::SharedFilesystem(canonical));
        }
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_filesystem_is_shared(filesystem_type: libc::c_long) -> bool {
    const NFS_SUPER_MAGIC: libc::c_long = 0x6969;
    const SMB_SUPER_MAGIC: libc::c_long = 0x517B;
    const CIFS_MAGIC_NUMBER: libc::c_long = 0xFF53_4D42_u32 as libc::c_long;
    matches!(
        filesystem_type,
        NFS_SUPER_MAGIC | SMB_SUPER_MAGIC | CIFS_MAGIC_NUMBER
    )
}

#[cfg(target_os = "macos")]
fn macos_filesystem_is_shared(flags: u32) -> bool {
    flags & (libc::MNT_LOCAL as u32) == 0
}

/// Verifies the filesystem that would contain `path` without creating it.
/// The nearest existing ancestor is sufficient for the pre-mutation check;
/// callers must verify the completed path again after creating it to close
/// mount/symlink races.
pub fn verify_host_local_path_location(path: &Path) -> Result<(), NodeIdentityError> {
    if !path.is_absolute() {
        return Err(NodeIdentityError::PathProbe {
            path: path.to_owned(),
            source: std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "host-local path probe requires an absolute path",
            ),
        });
    }
    let mut candidate = path;
    loop {
        match fs::symlink_metadata(candidate) {
            Ok(_) => return verify_host_local_path(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                candidate = candidate
                    .parent()
                    .ok_or_else(|| NodeIdentityError::PathProbe {
                        path: path.to_owned(),
                        source: std::io::Error::new(
                            std::io::ErrorKind::NotFound,
                            "host-local path has no existing ancestor",
                        ),
                    })?;
            }
            Err(source) => {
                return Err(NodeIdentityError::PathProbe {
                    path: candidate.to_owned(),
                    source,
                });
            }
        }
    }
}

fn digest_observation(raw: &str) -> Result<String, NodeIdentityError> {
    let normalized = raw.trim();
    let compact = normalized.replace('-', "").to_ascii_lowercase();
    if compact.len() != 32
        || !compact.bytes().all(|byte| byte.is_ascii_hexdigit())
        || compact.bytes().all(|byte| byte == b'0')
        || compact.bytes().all(|byte| byte == b'f')
    {
        return Err(NodeIdentityError::ObservationInvalid);
    }
    let mut digest = Sha256::new();
    digest.update(b"kmux-node-binding-v1\0");
    digest.update(compact.as_bytes());
    Ok(hex::encode(digest.finalize()))
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use std::io::Write;

    #[cfg(target_os = "linux")]
    use tempfile::NamedTempFile;

    use super::*;

    #[test]
    fn raw_node_observation_is_reduced_to_a_one_way_digest() {
        let digest = digest_observation("0123456789abcdef0123456789abcdef").unwrap();
        assert_eq!(digest.len(), 64);
        assert!(!digest.contains("0123456789abcdef"));
    }

    #[test]
    fn generic_or_malformed_observations_fail_closed() {
        for raw in ["", "hostname", "00000000000000000000000000000000"] {
            assert!(matches!(
                digest_observation(raw),
                Err(NodeIdentityError::ObservationInvalid)
            ));
        }
    }

    #[test]
    fn host_local_location_probe_does_not_create_the_requested_path() {
        let root = tempfile::tempdir().unwrap();
        let requested = root.path().join("missing").join("state");

        verify_host_local_path_location(&requested).unwrap();

        assert!(!requested.exists());
        assert!(matches!(
            verify_host_local_path_location(Path::new("relative/path")),
            Err(NodeIdentityError::PathProbe { .. })
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_shared_filesystem_types_are_rejected() {
        assert!(linux_filesystem_is_shared(0x6969));
        assert!(linux_filesystem_is_shared(0x517B));
        assert!(linux_filesystem_is_shared(0xFF53_4D42_u32 as libc::c_long));
        assert!(!linux_filesystem_is_shared(0x0102_1994));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_requires_the_kernel_local_mount_flag() {
        assert!(macos_filesystem_is_shared(0));
        assert!(!macos_filesystem_is_shared(libc::MNT_LOCAL as u32));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_backend_reads_the_configured_machine_id_file() {
        let mut file = NamedTempFile::new().unwrap();
        writeln!(file, "0123456789abcdef0123456789abcdef").unwrap();
        let backend = PlatformNodeIdentityBackend::with_machine_id_path(file.path());
        assert_eq!(backend.binding_digest().unwrap().len(), 64);
    }
}
