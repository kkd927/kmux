use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};

use nix::pty::{OpenptyResult, Winsize, openpty};
use nix::unistd::{Pid, dup, getsid};
use thiserror::Error;

pub const MAX_PTY_DIMENSION: u16 = 32_767;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

impl PtySize {
    pub fn validate(self) -> Result<Self, PtyError> {
        if self.cols == 0
            || self.rows == 0
            || self.cols > MAX_PTY_DIMENSION
            || self.rows > MAX_PTY_DIMENSION
        {
            return Err(PtyError::InvalidSize);
        }
        Ok(self)
    }
}

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("PTY dimensions must be within 1..={MAX_PTY_DIMENSION}")]
    InvalidSize,
    #[error("PTY system call failed: {0}")]
    System(#[from] nix::Error),
    #[error("PTY I/O failed: {0}")]
    Io(#[from] io::Error),
}

pub trait PtyBackend {
    fn spawn(&self, executable: &str, args: &[String], size: PtySize)
    -> Result<PtyChild, PtyError>;

    fn spawn_configured(
        &self,
        executable: &str,
        args: &[String],
        cwd: &Path,
        env: &BTreeMap<String, String>,
        size: PtySize,
    ) -> Result<PtyChild, PtyError>;
}

#[derive(Default)]
pub struct PosixPtyBackend;

impl PtyBackend for PosixPtyBackend {
    fn spawn(
        &self,
        executable: &str,
        args: &[String],
        size: PtySize,
    ) -> Result<PtyChild, PtyError> {
        self.spawn_command(executable, args, None, None, size)
    }

    fn spawn_configured(
        &self,
        executable: &str,
        args: &[String],
        cwd: &Path,
        env: &BTreeMap<String, String>,
        size: PtySize,
    ) -> Result<PtyChild, PtyError> {
        self.spawn_command(executable, args, Some(cwd), Some(env), size)
    }
}

impl PosixPtyBackend {
    fn spawn_command(
        &self,
        executable: &str,
        args: &[String],
        cwd: Option<&Path>,
        env: Option<&BTreeMap<String, String>>,
        size: PtySize,
    ) -> Result<PtyChild, PtyError> {
        let size = size.validate()?;
        let OpenptyResult { master, slave } = openpty(
            Some(&Winsize {
                ws_row: size.rows,
                ws_col: size.cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            }),
            None,
        )?;
        set_close_on_exec(master.as_raw_fd())?;
        set_close_on_exec(slave.as_raw_fd())?;
        let stdin = dup(&slave)?;
        let stdout = dup(&slave)?;
        let stderr = dup(&slave)?;
        set_close_on_exec(stdin.as_raw_fd())?;
        set_close_on_exec(stdout.as_raw_fd())?;
        set_close_on_exec(stderr.as_raw_fd())?;
        let mut command = Command::new(executable);
        command
            .args(args)
            .stdin(Stdio::from(stdin))
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        if let Some(env) = env {
            command.envs(env);
        }
        // SAFETY: this closure runs in the child after fork and calls only async-signal-safe
        // process/session and ioctl operations before exec. File descriptors 0..2 already
        // refer to the PTY slave supplied through Stdio.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn()?;
        drop(slave);
        Ok(PtyChild {
            master: File::from(master),
            child,
            size,
        })
    }
}

fn set_close_on_exec(fd: std::os::fd::RawFd) -> Result<(), PtyError> {
    // SAFETY: `fd` is owned by the caller for the duration of both fcntl
    // operations. F_GETFD/F_SETFD do not dereference pointers.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags == -1 {
        return Err(PtyError::Io(io::Error::last_os_error()));
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
        return Err(PtyError::Io(io::Error::last_os_error()));
    }
    Ok(())
}

pub struct PtyChild {
    master: File,
    child: Child,
    size: PtySize,
}

impl PtyChild {
    #[must_use]
    pub fn process_id(&self) -> u32 {
        self.child.id()
    }

    pub fn session_id(&self) -> Result<u32, PtyError> {
        let pid = i32::try_from(self.child.id()).map_err(|_| {
            PtyError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "child PID exceeds the POSIX pid_t range",
            ))
        })?;
        let session = match getsid(Some(Pid::from_raw(pid))) {
            Ok(session) => session.as_raw(),
            // A successful spawn means pre_exec completed setsid before exec.
            // A very short-lived child may exit before this observation.
            Err(nix::errno::Errno::ESRCH) => pid,
            Err(error) => return Err(PtyError::System(error)),
        };
        u32::try_from(session).map_err(|_| {
            PtyError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "child session ID is negative",
            ))
        })
    }

    #[must_use]
    pub fn size(&self) -> PtySize {
        self.size
    }

    pub fn write_all(&mut self, bytes: &[u8]) -> Result<(), PtyError> {
        self.master.write_all(bytes)?;
        Ok(())
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<usize, PtyError> {
        Ok(self.master.write(bytes)?)
    }

    pub fn set_nonblocking(&self, nonblocking: bool) -> Result<(), PtyError> {
        let flags = unsafe { libc::fcntl(self.master.as_raw_fd(), libc::F_GETFL) };
        if flags == -1 {
            return Err(PtyError::Io(io::Error::last_os_error()));
        }
        let next = if nonblocking {
            flags | libc::O_NONBLOCK
        } else {
            flags & !libc::O_NONBLOCK
        };
        if unsafe { libc::fcntl(self.master.as_raw_fd(), libc::F_SETFL, next) } == -1 {
            return Err(PtyError::Io(io::Error::last_os_error()));
        }
        Ok(())
    }

    pub fn try_read_chunk(&mut self, buffer: &mut [u8]) -> Result<Option<usize>, PtyError> {
        match self.master.read(buffer) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(error) if error.raw_os_error() == Some(libc::EIO) => Ok(Some(0)),
            Err(error) => Err(PtyError::Io(error)),
        }
    }

    pub fn try_wait(&mut self) -> Result<Option<ExitStatus>, PtyError> {
        Ok(self.child.try_wait()?)
    }

    pub fn terminate_process_group(
        &self,
        signal: nix::sys::signal::Signal,
    ) -> Result<(), PtyError> {
        let pid = i32::try_from(self.child.id()).map_err(|_| {
            PtyError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "child PID exceeds the POSIX pid_t range",
            ))
        })?;
        nix::sys::signal::killpg(Pid::from_raw(pid), signal)?;
        Ok(())
    }

    pub fn resize(&mut self, size: PtySize) -> Result<(), PtyError> {
        let size = size.validate()?;
        let winsize = libc::winsize {
            ws_row: size.rows,
            ws_col: size.cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: master is a live PTY descriptor and winsize points to initialized data.
        let result = unsafe {
            libc::ioctl(
                self.master.as_raw_fd(),
                libc::TIOCSWINSZ as _,
                &winsize as *const libc::winsize,
            )
        };
        if result == -1 {
            return Err(PtyError::Io(io::Error::last_os_error()));
        }
        self.size = size;
        Ok(())
    }

    pub fn read_chunk(&mut self, buffer: &mut [u8]) -> Result<usize, PtyError> {
        match self.master.read(buffer) {
            Ok(bytes) => Ok(bytes),
            Err(error) if error.raw_os_error() == Some(libc::EIO) => Ok(0),
            Err(error) => Err(PtyError::Io(error)),
        }
    }

    pub fn wait(mut self) -> Result<ExitStatus, PtyError> {
        Ok(self.child.wait()?)
    }

    pub fn read_to_exit_bounded(
        mut self,
        max_output_bytes: usize,
    ) -> Result<(ExitStatus, Vec<u8>, bool), PtyError> {
        let mut output = Vec::with_capacity(max_output_bytes.min(64 * 1024));
        let mut output_truncated = false;
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let bytes = self.read_chunk(&mut buffer)?;
            if bytes == 0 {
                break;
            }
            let available = max_output_bytes.saturating_sub(output.len());
            let retained = available.min(bytes);
            output.extend_from_slice(&buffer[..retained]);
            output_truncated |= retained < bytes;
        }
        let status = self.child.wait()?;
        Ok((status, output, output_truncated))
    }
}

#[allow(dead_code)]
fn _assert_owned_fd(_: OwnedFd) {}

#[cfg(test)]
mod tests {
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn posix_backend_owns_a_real_pty_and_detached_child_session() {
        let backend = PosixPtyBackend;
        let child = backend
            .spawn(
                "/bin/sh",
                &["-lc".to_owned(), "printf 'pty-ok:%s' \"$$\"".to_owned()],
                PtySize { cols: 80, rows: 24 },
            )
            .unwrap();
        let pid = child.process_id();
        assert_eq!(child.session_id().unwrap(), pid);
        let (status, output, output_truncated) = child.read_to_exit_bounded(64 * 1024).unwrap();
        assert!(status.success());
        assert!(!output_truncated);
        assert!(String::from_utf8_lossy(&output).contains(&format!("pty-ok:{pid}")));
    }

    #[test]
    fn closing_the_only_pty_master_does_not_leave_the_exec_child_alive() {
        let backend = PosixPtyBackend;
        let child = backend
            .spawn(
                "/bin/sh",
                &["-c".to_owned(), "exec /bin/sh".to_owned()],
                PtySize { cols: 80, rows: 24 },
            )
            .unwrap();
        let PtyChild {
            master,
            child: mut process,
            ..
        } = child;
        drop(master);

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if process.try_wait().unwrap().is_some() {
                return;
            }
            if Instant::now() >= deadline {
                process.kill().unwrap();
                process.wait().unwrap();
                panic!("PTY child retained an inherited master after exec");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}
