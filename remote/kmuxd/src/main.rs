use std::io::{self, BufRead, Read, Write};
use std::net::Shutdown;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Context;
use clap::{Args, Parser, Subcommand};
use kmux_doctor::DoctorPaths;
use kmux_platform::PtySize;
use nix::sys::termios::{
    ControlFlags, InputFlags, LocalFlags, OutputFlags, SetArg, SpecialCharacterIndices, tcgetattr,
    tcsetattr,
};

#[derive(Parser)]
#[command(name = "kmuxd", version, about = "kmux remote runtime")]
struct CommandLine {
    #[command(subcommand)]
    command: RuntimeCommand,
}

#[derive(Subcommand)]
enum RuntimeCommand {
    Bridge(BridgeCommand),
    Keeper(KeeperCommand),
    Hook(HookCommand),
    Cli(CliCommand),
    Doctor(DoctorCommand),
    #[command(hide = true)]
    Bootstrap(BootstrapCommand),
    #[command(hide = true)]
    Profile(ProfileCommand),
}

#[derive(Args)]
struct BootstrapCommand {
    #[command(subcommand)]
    command: BootstrapSubcommand,
}

#[derive(Subcommand)]
enum BootstrapSubcommand {
    Install(BootstrapInstallCommand),
    Inspect(BootstrapInspectCommand),
    Gc(BootstrapGcCommand),
    Reset(BootstrapResetCommand),
}

#[derive(Args)]
struct BootstrapInstallCommand {
    #[arg(long)]
    stage_directory: PathBuf,
    #[arg(long)]
    install_root: PathBuf,
    #[arg(long)]
    protocol_version: u16,
    #[arg(long)]
    expected_executable_sha256: String,
    #[arg(long)]
    expected_manifest_sha256: String,
}

#[derive(Args)]
struct BootstrapInspectCommand {
    #[arg(long)]
    runtime_path: PathBuf,
    #[arg(long)]
    protocol_version: u16,
    #[arg(long)]
    expected_executable_sha256: String,
    #[arg(long)]
    expected_manifest_sha256: String,
}

#[derive(Args)]
struct BootstrapGcCommand {
    #[arg(long)]
    install_root: PathBuf,
    #[arg(long)]
    state_root: PathBuf,
    #[arg(long)]
    current_generation: String,
}

#[derive(Args)]
struct BootstrapResetCommand {
    #[arg(long)]
    install_root: PathBuf,
    #[arg(long)]
    state_root: PathBuf,
    #[arg(long)]
    current_generation: String,
}

#[derive(Args)]
struct ProfileCommand {
    #[command(subcommand)]
    command: ProfileSubcommand,
}

#[derive(Subcommand)]
enum ProfileSubcommand {
    TerminalLoad(ProfileTerminalLoadCommand),
}

#[derive(Args)]
struct ProfileTerminalLoadCommand {
    #[arg(long, value_parser = parse_positive_rate)]
    bytes_per_second: u64,
    #[arg(long, value_parser = parse_profile_seed)]
    seed: u64,
}

#[derive(Args)]
struct HookCommand {
    #[arg(long, default_value_t = false)]
    capabilities: bool,
    #[command(subcommand)]
    command: Option<HookSubcommand>,
}

#[derive(Subcommand)]
enum HookSubcommand {
    Emit(HookEmitCommand),
}

#[derive(Args)]
struct HookEmitCommand {
    #[arg(long)]
    endpoint_path: Option<PathBuf>,
    #[arg(long)]
    kind: String,
    #[arg(long)]
    name: String,
    #[arg(long)]
    event_id: Option<String>,
}

#[derive(Args)]
struct CliCommand {
    #[arg(long, default_value_t = false)]
    capabilities: bool,
    #[arg(long)]
    endpoint_path: Option<PathBuf>,
    #[arg(long)]
    target: Option<String>,
    #[arg(long)]
    workspace: Option<String>,
    #[arg(long)]
    session: Option<String>,
    #[command(subcommand)]
    command: Option<CliSubcommand>,
}

#[derive(Subcommand)]
enum CliSubcommand {
    Surface(CliSurfaceCommand),
}

#[derive(Args)]
struct CliSurfaceCommand {
    #[command(subcommand)]
    command: CliSurfaceSubcommand,
}

#[derive(Subcommand)]
enum CliSurfaceSubcommand {
    SendText(CliSendTextCommand),
    SendKey(CliSendKeyCommand),
    Capture(CliCaptureCommand),
    Status,
}

#[derive(Args)]
struct CliSendTextCommand {
    #[arg(long)]
    text: String,
    #[arg(long)]
    operation_id: Option<String>,
}

#[derive(Args)]
struct CliSendKeyCommand {
    #[arg(long)]
    key: String,
    #[arg(long)]
    operation_id: Option<String>,
}

#[derive(Args)]
struct CliCaptureCommand {
    #[arg(long)]
    capture_id: Option<String>,
    #[arg(long, default_value_t = 200)]
    lines: usize,
    #[arg(long, default_value_t = 1024 * 1024)]
    max_bytes: usize,
}

#[derive(Args)]
struct BridgeCommand {
    #[arg(long, default_value_t = false)]
    capabilities: bool,
    #[command(subcommand)]
    command: Option<BridgeSubcommand>,
}

#[derive(Subcommand)]
enum BridgeSubcommand {
    Serve,
    Token(BridgeTokenCommand),
    CohortProxy(CohortProxyCommand),
}

#[derive(Args)]
struct BridgeTokenCommand {
    #[command(subcommand)]
    command: BridgeTokenSubcommand,
}

#[derive(Subcommand)]
enum BridgeTokenSubcommand {
    Rotate,
}

#[derive(Args)]
struct CohortProxyCommand {
    #[command(subcommand)]
    command: CohortProxySubcommand,
}

#[derive(Subcommand)]
enum CohortProxySubcommand {
    Serve(CohortProxyServeCommand),
    Attach(CohortProxyAttachCommand),
}

#[derive(Args)]
struct CohortProxyServeCommand {
    #[arg(long)]
    socket_path: PathBuf,
    #[arg(long)]
    state_root: PathBuf,
    #[arg(long)]
    runtime_root: PathBuf,
    #[arg(long)]
    target_id: String,
    #[arg(long)]
    executable_generation: String,
    #[arg(long)]
    keeper_local_protocol_major: u16,
}

#[derive(Args)]
struct CohortProxyAttachCommand {
    #[arg(long)]
    socket_path: PathBuf,
}

#[derive(Args)]
struct KeeperCommand {
    #[command(subcommand)]
    command: KeeperSubcommand,
}

#[derive(Subcommand)]
enum KeeperSubcommand {
    PtySpike(PtySpikeCommand),
    Serve(KeeperServeCommand),
    Proxy,
}

#[derive(Args)]
struct KeeperServeCommand {
    #[arg(long)]
    descriptor_path: PathBuf,
    #[arg(long)]
    generation: String,
}

#[derive(Args)]
struct PtySpikeCommand {
    #[arg(long)]
    journal_path: PathBuf,
    #[arg(long)]
    checkpoint_path: Option<PathBuf>,
    #[arg(long, default_value_t = 80)]
    cols: u16,
    #[arg(long, default_value_t = 24)]
    rows: u16,
    #[arg(long)]
    executable: String,
    #[arg(last = true)]
    args: Vec<String>,
}

#[derive(Args)]
struct DoctorCommand {
    #[arg(long)]
    install_root: PathBuf,
    #[arg(long)]
    authority_root: PathBuf,
    #[arg(long)]
    state_root: PathBuf,
    #[arg(long)]
    runtime_root: PathBuf,
}

fn main() -> anyhow::Result<()> {
    // A generation lease is process-scoped and acquired before any subcommand
    // performs work. GC can therefore never remove the executable backing a
    // live bridge, keeper, cohort proxy, hook, CLI, or diagnostic command.
    let _generation_lease = kmux_install::acquire_current_generation_lease()
        .context("runtime executable generation lease failed")?;
    let command_line = CommandLine::parse();
    match command_line.command {
        RuntimeCommand::Bridge(bridge_command) => match bridge_command.command {
            Some(BridgeSubcommand::Serve) if !bridge_command.capabilities => {
                kmux_bridge::run_bridge_server(io::stdin().lock(), io::stdout().lock())?;
            }
            Some(BridgeSubcommand::Token(command)) if !bridge_command.capabilities => {
                match command.command {
                    BridgeTokenSubcommand::Rotate => {
                        kmux_bridge::rotate_bridge_token(io::stdin().lock(), io::stdout().lock())?;
                    }
                }
            }
            Some(BridgeSubcommand::CohortProxy(command)) if !bridge_command.capabilities => {
                match command.command {
                    CohortProxySubcommand::Serve(command) => {
                        kmux_bridge::run_cohort_proxy_server(
                            kmux_bridge::CohortProxyServeOptions {
                                socket_path: command.socket_path,
                                state_root: command.state_root,
                                runtime_root: command.runtime_root,
                                target_id: command.target_id,
                                executable_generation: command.executable_generation,
                                keeper_local_protocol_major: command.keeper_local_protocol_major,
                            },
                        )?;
                    }
                    CohortProxySubcommand::Attach(command) => {
                        run_cohort_proxy(command.socket_path)?;
                    }
                }
            }
            None if bridge_command.capabilities => print_json(&kmux_bridge::capabilities())?,
            _ => anyhow::bail!("bridge requires either --capabilities or the serve subcommand"),
        },
        RuntimeCommand::Keeper(command) => match command.command {
            KeeperSubcommand::PtySpike(command) => {
                let report = kmux_keeper::run_pty_spike(
                    &command.executable,
                    &command.args,
                    &command.journal_path,
                    command.checkpoint_path.as_deref(),
                    PtySize {
                        cols: command.cols,
                        rows: command.rows,
                    },
                )
                .context("keeper PTY spike failed")?;
                print_json(&report)?;
            }
            KeeperSubcommand::Serve(command) => {
                kmux_keeper::run_keeper_server(&command.descriptor_path, &command.generation)
                    .context("keeper server failed")?;
            }
            KeeperSubcommand::Proxy => run_keeper_proxy()?,
        },
        RuntimeCommand::Hook(command) => run_hook(command)?,
        RuntimeCommand::Cli(command) => run_cli(command)?,
        RuntimeCommand::Doctor(command) => {
            let report = kmux_doctor::run_doctor(&DoctorPaths {
                install_root: command.install_root,
                authority_root: command.authority_root,
                state_root: command.state_root,
                runtime_root: command.runtime_root,
            })
            .context("remote path/authority doctor failed")?;
            print_json(&report)?;
        }
        RuntimeCommand::Bootstrap(command) => match command.command {
            BootstrapSubcommand::Install(command) => {
                let report = kmux_install::install_generation(
                    &kmux_install::InstallGenerationOptions::with_default_timeout(
                        command.stage_directory,
                        command.install_root,
                        command.protocol_version,
                        command.expected_executable_sha256,
                        command.expected_manifest_sha256,
                    ),
                )
                .context("content-addressed runtime install failed")?;
                print_json(&report)?;
            }
            BootstrapSubcommand::Inspect(command) => {
                let report =
                    kmux_install::inspect_generation(&kmux_install::InspectGenerationOptions {
                        runtime_path: command.runtime_path,
                        protocol_version: command.protocol_version,
                        expected_executable_sha256: command.expected_executable_sha256,
                        expected_manifest_sha256: command.expected_manifest_sha256,
                    })
                    .context("installed runtime inspection failed")?;
                print_json(&report)?;
            }
            BootstrapSubcommand::Gc(command) => {
                let report = kmux_install::garbage_collect_generations(
                    &kmux_install::GarbageCollectOptions {
                        install_root: command.install_root,
                        state_root: command.state_root,
                        current_generation: command.current_generation,
                    },
                )
                .context("runtime generation GC failed")?;
                print_json(&report)?;
            }
            BootstrapSubcommand::Reset(command) => {
                // Reset removes the executable generation that is running this
                // command. Release this process's shared generation lease,
                // then require an exclusive lease so any bridge, keeper,
                // cohort, hook, CLI, or diagnostic process still using it
                // fences the destructive repair.
                drop(_generation_lease);
                let report =
                    kmux_install::reset_generation(&kmux_install::ResetGenerationOptions {
                        install_root: command.install_root,
                        state_root: command.state_root,
                        current_generation: command.current_generation,
                    })
                    .context("runtime generation reset failed")?;
                print_json(&report)?;
            }
        },
        RuntimeCommand::Profile(command) => match command.command {
            ProfileSubcommand::TerminalLoad(command) => {
                run_profile_terminal_load(command.bytes_per_second, command.seed)?;
            }
        },
    }
    Ok(())
}

fn parse_positive_rate(value: &str) -> Result<u64, String> {
    let rate = value
        .parse::<u64>()
        .map_err(|_| "bytes-per-second must be a positive integer".to_owned())?;
    if !(1..=16 * 1024 * 1024).contains(&rate) {
        return Err("bytes-per-second must be between 1 and 16777216".to_owned());
    }
    Ok(rate)
}

fn parse_profile_seed(value: &str) -> Result<u64, String> {
    let normalized = value.strip_prefix("0x").unwrap_or(value);
    let seed = u64::from_str_radix(normalized, 16)
        .map_err(|_| "seed must be a non-zero hexadecimal u64".to_owned())?;
    if seed == 0 {
        return Err("seed must be non-zero".to_owned());
    }
    Ok(seed)
}

fn run_profile_terminal_load(bytes_per_second: u64, seed: u64) -> anyhow::Result<()> {
    // This hidden release-gate workload is intentionally implemented by the
    // shipped binary: targets do not need Python, Node, or another generator.
    // The PTY is raw/no-echo so an observed token is emitted by this process,
    // not optimistically echoed by the line discipline.
    let stdin = io::stdin();
    let mut terminal = tcgetattr(&stdin).context("profile PTY termios read failed")?;
    terminal.local_flags.remove(
        LocalFlags::ECHO
            | LocalFlags::ECHONL
            | LocalFlags::ICANON
            | LocalFlags::ISIG
            | LocalFlags::IEXTEN,
    );
    terminal.input_flags.remove(
        InputFlags::BRKINT
            | InputFlags::ICRNL
            | InputFlags::INPCK
            | InputFlags::ISTRIP
            | InputFlags::IXON,
    );
    terminal.output_flags.remove(OutputFlags::OPOST);
    terminal.control_flags.insert(ControlFlags::CS8);
    terminal.control_chars[SpecialCharacterIndices::VMIN as usize] = 1;
    terminal.control_chars[SpecialCharacterIndices::VTIME as usize] = 0;
    tcsetattr(&stdin, SetArg::TCSANOW, &terminal).context("profile PTY termios update failed")?;

    let (input_sender, input_receiver) = mpsc::sync_channel::<Vec<u8>>(256);
    thread::spawn(move || {
        let mut input = io::BufReader::new(io::stdin().lock());
        loop {
            let mut line = Vec::with_capacity(128);
            match input.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {
                    while matches!(line.last(), Some(b'\n' | b'\r')) {
                        line.pop();
                    }
                    if line.len() <= 4 * 1024 && input_sender.send(line).is_err() {
                        return;
                    }
                }
            }
        }
    });

    let chunk_bytes = usize::try_from(bytes_per_second.min(4 * 1024))
        .context("profile output chunk size overflowed")?;
    let interval = Duration::from_secs_f64(chunk_bytes as f64 / bytes_per_second as f64);
    let mut next_output = Instant::now();
    let mut generator = XorShift64::new(seed);
    let mut chunk = vec![0_u8; chunk_bytes];
    let mut output = io::BufWriter::with_capacity(64 * 1024, io::stdout().lock());
    output.write_all(b"KMUX_PROFILE_READY\n")?;
    output.flush()?;
    loop {
        while let Ok(token) = input_receiver.try_recv() {
            output.write_all(&token)?;
            output.write_all(b"\n")?;
        }
        let now = Instant::now();
        if now >= next_output {
            generator.fill(&mut chunk);
            output.write_all(&chunk)?;
            output.flush()?;
            next_output += interval;
            continue;
        }
        thread::sleep((next_output - now).min(Duration::from_millis(2)));
    }
}

struct XorShift64(u64);

impl XorShift64 {
    fn new(seed: u64) -> Self {
        debug_assert_ne!(seed, 0);
        Self(seed)
    }

    fn next(&mut self) -> u64 {
        let mut value = self.0;
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        self.0 = value;
        value
    }

    fn fill(&mut self, bytes: &mut [u8]) {
        for chunk in bytes.chunks_mut(std::mem::size_of::<u64>()) {
            let generated = self.next().to_le_bytes();
            chunk.copy_from_slice(&generated[..chunk.len()]);
        }
    }
}

fn run_keeper_proxy() -> anyhow::Result<()> {
    let stdin = io::stdin();
    let frame = kmux_compat::read_remote_frame(&mut stdin.lock())?
        .context("keeper proxy requires an attach control frame")?;
    anyhow::ensure!(
        frame.kind == kmux_compat::RemoteFrameKind::Control,
        "keeper proxy first frame must be control JSON"
    );
    let request: kmux_compat::KeeperAttachRequest = serde_json::from_slice(&frame.payload)?;
    let keeper = kmux_bridge::open_keeper_proxy(&request)?;
    proxy_stdio(keeper)
}

fn run_cohort_proxy(socket_path: PathBuf) -> anyhow::Result<()> {
    let stdin = io::stdin();
    let frame = kmux_compat::read_remote_frame(&mut stdin.lock())?
        .context("cohort proxy requires an attach control frame")?;
    anyhow::ensure!(
        frame.kind == kmux_compat::RemoteFrameKind::Control,
        "cohort proxy first frame must be control JSON"
    );
    let request: kmux_compat::KeeperAttachRequest = serde_json::from_slice(&frame.payload)?;
    let proxy = kmux_bridge::open_cohort_proxy(&socket_path, &request)?;
    proxy_stdio(proxy)
}

fn proxy_stdio(mut keeper: std::os::unix::net::UnixStream) -> anyhow::Result<()> {
    let stdin = io::stdin();
    let mut keeper_input = keeper.try_clone()?;
    thread::spawn(move || {
        let _ = io::copy(&mut stdin.lock(), &mut keeper_input);
        let _ = keeper_input.shutdown(Shutdown::Write);
    });
    let stdout = io::stdout();
    copy_and_flush(&mut keeper, &mut stdout.lock())?;
    Ok(())
}

fn copy_and_flush(reader: &mut impl Read, writer: &mut impl Write) -> io::Result<u64> {
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let bytes = match reader.read(&mut buffer) {
            Ok(0) => return Ok(copied),
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        writer.write_all(&buffer[..bytes])?;
        writer.flush()?;
        copied = copied.saturating_add(bytes as u64);
    }
}

fn run_hook(command: HookCommand) -> anyhow::Result<()> {
    match command.command {
        None if command.capabilities => print_json(&kmux_hook::capabilities()),
        Some(HookSubcommand::Emit(emit)) if !command.capabilities => {
            let endpoint_path =
                resolve_endpoint_path(emit.endpoint_path, "KMUX_AGENT_HOOK_ENDPOINT")?;
            let token = require_env("KMUX_AUTH_TOKEN")?;
            let payload = read_bounded_stdin_json(kmux_hook::MAX_HOOK_PAYLOAD_BYTES)?;
            let agent_response = agent_hook_response(&emit.kind, &emit.name);
            let admission = kmux_hook::admit_event_from_endpoint(
                &endpoint_path,
                &token,
                kmux_hook::AdmitEventRequest {
                    event_id: emit.event_id,
                    kind: emit.kind,
                    name: emit.name,
                    payload,
                },
            )?;
            if std::env::var("KMUX_AGENT_HOOK_OUTPUT_MODE").as_deref() == Ok("json") {
                print_json(&agent_response)
            } else {
                print_json(&admission)
            }
        }
        _ => anyhow::bail!("hook requires --capabilities or the emit subcommand"),
    }
}

fn agent_hook_response(kind: &str, name: &str) -> serde_json::Value {
    if kind != "agent-hook" {
        return serde_json::json!({});
    }
    let Some((agent, event)) = name.split_once('.') else {
        return serde_json::json!({});
    };
    let normalized_agent = agent.trim().to_ascii_lowercase();
    let normalized_event = event
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>();
    if matches!(
        normalized_agent.as_str(),
        "agy" | "antigravity" | "antigravity-cli"
    ) && matches!(normalized_event.as_str(), "pretooluse" | "stop")
    {
        serde_json::json!({ "decision": "allow" })
    } else {
        serde_json::json!({})
    }
}

fn run_cli(command: CliCommand) -> anyhow::Result<()> {
    let Some(subcommand) = command.command else {
        anyhow::ensure!(
            command.capabilities,
            "cli requires --capabilities or a command"
        );
        return print_json(&kmux_cli::capabilities());
    };
    anyhow::ensure!(
        !command.capabilities,
        "--capabilities cannot be combined with a command"
    );
    let endpoint_path =
        resolve_endpoint_path(command.endpoint_path, "KMUX_REMOTE_CONTROL_ENDPOINT")?;
    let token = require_env("KMUX_AUTH_TOKEN")?;
    let scope = kmux_cli::CliScope {
        expected_target_id: command.target,
        expected_workspace_id: command.workspace,
        expected_session_id: command.session,
    };
    let CliSubcommand::Surface(surface) = subcommand;
    let surface_command = match surface.command {
        CliSurfaceSubcommand::SendText(input) => kmux_cli::CliSurfaceCommand::SendText {
            operation_id: input.operation_id,
            text: input.text,
        },
        CliSurfaceSubcommand::SendKey(input) => kmux_cli::CliSurfaceCommand::SendKey {
            operation_id: input.operation_id,
            key: input.key,
        },
        CliSurfaceSubcommand::Capture(capture) => kmux_cli::CliSurfaceCommand::Capture {
            capture_id: capture.capture_id,
            line_limit: capture.lines,
            max_bytes: capture.max_bytes,
        },
        CliSurfaceSubcommand::Status => kmux_cli::CliSurfaceCommand::Status,
    };
    let result =
        kmux_cli::execute_surface_command(&endpoint_path, &token, &scope, surface_command)?;
    print_json(&result)
}

fn resolve_endpoint_path(path: Option<PathBuf>, env_name: &str) -> anyhow::Result<PathBuf> {
    let path = match path {
        Some(path) => path,
        None => PathBuf::from(require_env(env_name)?),
    };
    anyhow::ensure!(path.is_absolute(), "{env_name} must be an absolute path");
    Ok(path)
}

fn require_env(name: &str) -> anyhow::Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is required"))?;
    anyhow::ensure!(
        !value.is_empty() && value.len() <= 32 * 1024,
        "{name} is invalid"
    );
    Ok(value)
}

fn read_bounded_stdin_json(max_bytes: usize) -> anyhow::Result<serde_json::Value> {
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() <= max_bytes,
        "hook payload exceeds its hard limit"
    );
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(serde_json::json!({}));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn print_json(value: &impl serde::Serialize) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string(value)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    struct ChunkReader {
        chunks: VecDeque<Vec<u8>>,
    }

    impl Read for ChunkReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let Some(chunk) = self.chunks.pop_front() else {
                return Ok(0);
            };
            buffer[..chunk.len()].copy_from_slice(&chunk);
            Ok(chunk.len())
        }
    }

    #[derive(Default)]
    struct FlushRecordingWriter {
        bytes: Vec<u8>,
        flushed_lengths: Vec<usize>,
    }

    impl Write for FlushRecordingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flushed_lengths.push(self.bytes.len());
            Ok(())
        }
    }

    #[test]
    fn proxy_flushes_each_keeper_chunk_before_the_stream_closes() {
        let mut reader = ChunkReader {
            chunks: VecDeque::from([b"ready".to_vec(), b"mutation".to_vec()]),
        };
        let mut writer = FlushRecordingWriter::default();

        assert_eq!(copy_and_flush(&mut reader, &mut writer).unwrap(), 13);
        assert_eq!(writer.bytes, b"readymutation");
        assert_eq!(writer.flushed_lengths, [5, 13]);
    }

    #[test]
    fn agent_hook_response_matches_the_managed_antigravity_contract() {
        assert_eq!(
            agent_hook_response("agent-hook", "antigravity.PreToolUse"),
            serde_json::json!({ "decision": "allow" })
        );
        assert_eq!(
            agent_hook_response("agent-hook", "agy.Stop"),
            serde_json::json!({ "decision": "allow" })
        );
        assert_eq!(
            agent_hook_response("agent-hook", "claude.Stop"),
            serde_json::json!({})
        );
        assert_eq!(
            agent_hook_response("notification", "antigravity.Stop"),
            serde_json::json!({})
        );
    }
}
