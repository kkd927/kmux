#![deny(unsafe_op_in_unsafe_fn)]

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

use kmux_journal::MutationJournal;
use kmux_platform::{PosixPtyBackend, PtyBackend, PtyError, PtySize};
use kmux_terminal::{HeadlessTerminalModel, TerminalModelError, TerminalMutation};
use serde::Serialize;
use thiserror::Error;

mod runtime;

pub use runtime::*;

// The spike report is control JSON, so retain enough room for worst-case JSON
// escaping under the 256 KiB outer control-message limit.
pub const MAX_PTY_SPIKE_REPORT_OUTPUT_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpikeReport {
    pub child_pid: u32,
    pub child_session_id: u32,
    pub exit_code: Option<i32>,
    pub output: String,
    pub output_truncated: bool,
    pub journal_admitted: u64,
    pub journal_synced: u64,
    pub checkpoint_format: String,
    pub checkpoint_sha256: String,
    pub checkpoint_bytes: usize,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Error)]
pub enum KeeperError {
    #[error("PTY failure: {0}")]
    Pty(#[from] PtyError),
    #[error("journal failure: {0}")]
    Journal(#[from] kmux_journal::JournalError),
    #[error("terminal model failure: {0}")]
    Terminal(#[from] TerminalModelError),
    #[error("journal file failed: {0}")]
    Io(#[from] std::io::Error),
}

pub fn run_pty_spike(
    executable: &str,
    args: &[String],
    journal_path: &Path,
    checkpoint_path: Option<&Path>,
    initial_size: PtySize,
) -> Result<PtySpikeReport, KeeperError> {
    let initial_size = initial_size.validate()?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(journal_path)?;
    let mut journal = MutationJournal::new(file, Duration::ZERO);
    let mut model = HeadlessTerminalModel::new(initial_size.cols, initial_size.rows);
    let backend = PosixPtyBackend;
    let mut child = backend.spawn(executable, args, initial_size)?;
    let child_pid = child.process_id();
    let child_session_id = child.session_id()?;
    let started = Instant::now();
    let mut sequence = 1_u64;
    child.resize(initial_size)?;
    let resize = TerminalMutation::Resize {
        sequence,
        cols: initial_size.cols,
        rows: initial_size.rows,
    };
    journal.append(&resize, started.elapsed())?;
    model.apply(&resize)?;
    sequence += 1;

    let mut output = Vec::new();
    let mut output_truncated = false;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let bytes = child.read_chunk(&mut buffer)?;
        if bytes == 0 {
            break;
        }
        let output_mutation = TerminalMutation::Output {
            sequence,
            data: buffer[..bytes].to_vec(),
        };
        let now = started.elapsed();
        journal.append(&output_mutation, now)?;
        model.apply(&output_mutation)?;
        journal.sync_if_due(now)?;

        let available = MAX_PTY_SPIKE_REPORT_OUTPUT_BYTES.saturating_sub(output.len());
        let retained = available.min(bytes);
        output.extend_from_slice(&buffer[..retained]);
        output_truncated |= retained < bytes;
        sequence += 1;
    }
    let status = child.wait()?;
    let exit = TerminalMutation::Exit {
        sequence,
        exit_code: status.code(),
    };
    let now = started.elapsed();
    journal.append(&exit, now)?;
    model.apply(&exit)?;
    let admission = journal.force_sync(now)?;
    let checkpoint = model.checkpoint(admission.journal_synced)?;
    if let Some(checkpoint_path) = checkpoint_path {
        write_atomic_checkpoint(checkpoint_path, &checkpoint.restore_stream)?;
    }

    Ok(PtySpikeReport {
        child_pid,
        child_session_id,
        exit_code: status.code(),
        output: String::from_utf8_lossy(&output).into_owned(),
        output_truncated,
        journal_admitted: admission.journal_admitted,
        journal_synced: admission.journal_synced,
        checkpoint_format: checkpoint.format,
        checkpoint_sha256: checkpoint.sha256,
        checkpoint_bytes: checkpoint.restore_stream.len(),
        cols: checkpoint.cols,
        rows: checkpoint.rows,
    })
}

fn write_atomic_checkpoint(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "checkpoint path has no parent",
        )
    })?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.as_file_mut().write_all(bytes)?;
    temporary.as_file_mut().sync_all()?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| error.error)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn pty_output_is_journaled_and_checkpointed_before_success() {
        let root = TempDir::new().unwrap();
        let report = run_pty_spike(
            "/bin/sh",
            &["-lc".to_owned(), "printf keeper-ok".to_owned()],
            &root.path().join("journal.bin"),
            Some(&root.path().join("checkpoint.vt")),
            PtySize { cols: 80, rows: 24 },
        )
        .unwrap();
        assert_eq!(report.exit_code, Some(0));
        assert_eq!(report.child_session_id, report.child_pid);
        assert!(report.output.contains("keeper-ok"));
        assert_eq!(report.journal_admitted, report.journal_synced);
        assert_eq!(report.checkpoint_format, "xterm-vt/1");
        assert!(!report.output_truncated);
        assert_eq!(
            std::fs::read(root.path().join("checkpoint.vt"))
                .unwrap()
                .len(),
            report.checkpoint_bytes
        );
    }

    #[test]
    fn pty_spike_never_follows_or_truncates_an_existing_journal_path() {
        let root = TempDir::new().unwrap();
        let victim = root.path().join("victim");
        let journal = root.path().join("journal.bin");
        std::fs::write(&victim, b"preserve-me").unwrap();
        symlink(&victim, &journal).unwrap();

        assert!(matches!(
            run_pty_spike(
                "/bin/true",
                &[],
                &journal,
                None,
                PtySize { cols: 80, rows: 24 },
            ),
            Err(KeeperError::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists
        ));
        assert_eq!(std::fs::read(&victim).unwrap(), b"preserve-me");
    }
}
