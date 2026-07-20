#![deny(unsafe_op_in_unsafe_fn)]

mod identity;
mod process;
mod pty;

pub use identity::{
    NodeIdentityBackend, NodeIdentityError, PlatformNodeIdentityBackend,
    RemoteAuthenticatedPrincipal, current_authenticated_home, current_authenticated_principal,
    verify_host_local_path, verify_host_local_path_location,
};
pub use process::{effective_uid, spawn_detached, spawn_reparented};
pub use pty::{MAX_PTY_DIMENSION, PosixPtyBackend, PtyBackend, PtyChild, PtyError, PtySize};
