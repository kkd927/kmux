use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};

use nix::unistd::Uid;

#[must_use]
pub fn effective_uid() -> u32 {
    Uid::effective().as_raw()
}

pub fn spawn_detached(command: &mut Command) -> io::Result<Child> {
    // SAFETY: the child callback invokes only the async-signal-safe setsid syscall.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn()
}

/// Spawn a long-lived, fire-and-forget process without leaving it as a child
/// that the caller must reap.
///
/// `Command` first creates a short-lived launcher. The launcher forks once;
/// its child creates the detached session and execs the requested command,
/// while the launcher exits and is synchronously reaped here. The exec child
/// is therefore adopted by the host's process reaper instead of becoming a
/// zombie owned by a long-lived bridge process when it later exits.
pub fn spawn_reparented(command: &mut Command) -> io::Result<()> {
    // SAFETY: the pre-exec callback invokes only async-signal-safe process
    // syscalls. The launcher branch exits with `_exit` and never returns into
    // Rust; only the exec child returns from the callback.
    unsafe {
        command.pre_exec(|| {
            let child = libc::fork();
            if child == -1 {
                return Err(io::Error::last_os_error());
            }
            if child > 0 {
                libc::_exit(0);
            }
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut launcher = command.spawn()?;
    let status = launcher.wait()?;
    if !status.success() {
        return Err(io::Error::other(format!(
            "detached process launcher exited with {status}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::process::Stdio;
    use std::thread;
    use std::time::{Duration, Instant};

    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::sys::wait::{WaitPidFlag, waitpid};
    use nix::unistd::Pid;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn reparented_process_is_not_owned_by_the_long_lived_caller() {
        let directory = tempdir().unwrap();
        let report = directory.path().join("process.txt");
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(
                "printf '%s %s %s\\n' \"$$\" \"$PPID\" \"$(ps -o pgid= -p $$)\" > \"$1\"; sleep 0.2",
            )
            .arg("kmux-reparented-test")
            .arg(&report)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        spawn_reparented(&mut command).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let contents = loop {
            match fs::read_to_string(&report) {
                Ok(contents) => break contents,
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound && Instant::now() < deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("reparented process did not report its identity: {error}"),
            }
        };
        let fields = contents.split_whitespace().collect::<Vec<_>>();
        assert_eq!(fields.len(), 3, "unexpected process report: {contents:?}");
        let pid = fields[0].parse::<i32>().unwrap();
        let parent_pid = fields[1].parse::<u32>().unwrap();
        let process_group_id = fields[2].parse::<i32>().unwrap();
        assert_ne!(parent_pid, std::process::id());
        assert_eq!(process_group_id, pid);
        assert!(matches!(
            waitpid(Pid::from_raw(pid), Some(WaitPidFlag::WNOHANG)),
            Err(Errno::ECHILD)
        ));

        let process = Pid::from_raw(pid);
        while Instant::now() < deadline {
            if matches!(kill(process, None), Err(Errno::ESRCH)) {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("reparented process was not reaped after exit");
    }

    #[test]
    fn reparented_process_preserves_exec_failure() {
        let mut command = Command::new("/kmux/missing/reparented-executable");
        let error = spawn_reparented(&mut command).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
