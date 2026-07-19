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
    #[arg(long, value_parser = parse_profile_chunk_bytes)]
    steady_chunk_bytes: usize,
    #[arg(long, value_parser = parse_profile_burst_bytes)]
    burst_bytes: usize,
    #[arg(long, value_parser = parse_profile_chunk_bytes)]
    burst_chunk_bytes: usize,
    #[arg(long, value_parser = parse_profile_interval_ms)]
    burst_chunk_interval_ms: u64,
    #[arg(long, value_parser = parse_profile_pause_ms)]
    burst_echo_pause_ms: u64,
    #[arg(long, value_parser = parse_profile_seed)]
    seed: u64,
}

const PROFILE_BURST_TRIGGER_PREFIX: &[u8] = b"KMUX_PROFILE_BURST:";
const PROFILE_BURST_BEGIN_PREFIX: &[u8] = b"KMUX_PROFILE_BURST_BEGIN:";
const PROFILE_BURST_END_PREFIX: &[u8] = b"KMUX_PROFILE_BURST_END:";
const PROFILE_STATUS_REQUEST_PREFIX: &[u8] = b"KMUX_PROFILE_STATUS:";
const PROFILE_STATUS_RESPONSE_PREFIX: &[u8] = b"KMUX_PROFILE_STATUS:";
const PROFILE_STATUS_END_PREFIX: &[u8] = b"KMUX_PROFILE_STATUS_END:";
const PROFILE_BURST_TOKEN_MAX_BYTES: usize = 128;

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
                run_profile_terminal_load(command)?;
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

fn parse_profile_chunk_bytes(value: &str) -> Result<usize, String> {
    let bytes = value
        .parse::<usize>()
        .map_err(|_| "chunk-bytes must be a positive integer".to_owned())?;
    if !(1..=1024 * 1024).contains(&bytes) {
        return Err("chunk-bytes must be between 1 and 1048576".to_owned());
    }
    Ok(bytes)
}

fn parse_profile_burst_bytes(value: &str) -> Result<usize, String> {
    let bytes = value
        .parse::<usize>()
        .map_err(|_| "burst-bytes must be a positive integer".to_owned())?;
    if !(1..=16 * 1024 * 1024).contains(&bytes) {
        return Err("burst-bytes must be between 1 and 16777216".to_owned());
    }
    Ok(bytes)
}

fn parse_profile_interval_ms(value: &str) -> Result<u64, String> {
    let milliseconds = value
        .parse::<u64>()
        .map_err(|_| "burst-chunk-interval-ms must be a positive integer".to_owned())?;
    if !(1..=1_000).contains(&milliseconds) {
        return Err("burst-chunk-interval-ms must be between 1 and 1000".to_owned());
    }
    Ok(milliseconds)
}

fn parse_profile_pause_ms(value: &str) -> Result<u64, String> {
    let milliseconds = value
        .parse::<u64>()
        .map_err(|_| "burst-echo-pause-ms must be a non-negative integer".to_owned())?;
    if milliseconds > 1_000 {
        return Err("burst-echo-pause-ms must be between 0 and 1000".to_owned());
    }
    Ok(milliseconds)
}

struct ProfileBurst {
    token: Vec<u8>,
    remaining_bytes: usize,
    next_chunk_at: Instant,
    paused_until: Instant,
}

#[derive(Debug, Eq, PartialEq)]
enum ProfileInputLine {
    Line(Vec<u8>),
    Oversized,
}

fn read_profile_input_line(
    input: &mut impl BufRead,
    maximum_bytes: usize,
) -> io::Result<Option<ProfileInputLine>> {
    let mut line = Vec::with_capacity(maximum_bytes.min(128));
    let read = input
        .by_ref()
        .take(u64::try_from(maximum_bytes.saturating_add(2)).unwrap_or(u64::MAX))
        .read_until(b'\n', &mut line)?;
    if read == 0 {
        return Ok(None);
    }
    if !line.ends_with(b"\n") && line.len() > maximum_bytes {
        input.skip_until(b'\n')?;
        return Ok(Some(ProfileInputLine::Oversized));
    }
    while matches!(line.last(), Some(b'\n' | b'\r')) {
        line.pop();
    }
    if line.len() > maximum_bytes {
        return Ok(Some(ProfileInputLine::Oversized));
    }
    Ok(Some(ProfileInputLine::Line(line)))
}

fn run_profile_terminal_load(command: ProfileTerminalLoadCommand) -> anyhow::Result<()> {
    // This hidden release-gate workload is intentionally implemented by the
    // shipped binary: targets do not need Python, Node, or another generator.
    // The PTY is raw/no-echo so an observed token is emitted by this process,
    // not optimistically echoed by the line discipline.
    anyhow::ensure!(
        command.burst_chunk_bytes <= command.burst_bytes
            && command
                .burst_bytes
                .is_multiple_of(command.burst_chunk_bytes),
        "profile burst bytes must be an exact positive multiple of its chunk size"
    );
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
            match read_profile_input_line(&mut input, 4 * 1024) {
                Ok(None) | Err(_) => return,
                Ok(Some(ProfileInputLine::Oversized)) => continue,
                Ok(Some(ProfileInputLine::Line(line))) => {
                    if input_sender.send(line).is_err() {
                        return;
                    }
                }
            }
        }
    });

    let steady_interval = Duration::from_secs_f64(
        command.steady_chunk_bytes as f64 / command.bytes_per_second as f64,
    );
    let burst_chunk_interval = Duration::from_millis(command.burst_chunk_interval_ms);
    let burst_echo_pause = Duration::from_millis(command.burst_echo_pause_ms);
    let mut next_output = Instant::now();
    let mut generator = XorShift64::new(command.seed);
    let mut steady_chunk = vec![0_u8; command.steady_chunk_bytes];
    let burst_chunk = vec![b'x'; command.burst_chunk_bytes];
    let mut burst: Option<ProfileBurst> = None;
    let mut burst_started = false;
    let mut steady_output_bytes = 0_u64;
    let mut burst_output_bytes = 0_u64;
    let mut output = io::BufWriter::with_capacity(64 * 1024, io::stdout().lock());
    output.write_all(b"KMUX_PROFILE_READY\n")?;
    output.flush()?;
    loop {
        while let Ok(token) = input_receiver.try_recv() {
            if let Some(status_token) = profile_status_token(&token) {
                write_profile_status(
                    &mut output,
                    status_token,
                    steady_output_bytes,
                    burst_output_bytes,
                )?;
                continue;
            }
            if !burst_started && let Some(burst_token) = profile_burst_token(&token) {
                write_profile_marker(&mut output, PROFILE_BURST_BEGIN_PREFIX, burst_token)?;
                let now = Instant::now();
                burst = Some(ProfileBurst {
                    token: burst_token.to_vec(),
                    remaining_bytes: command.burst_bytes,
                    next_chunk_at: now,
                    paused_until: now,
                });
                burst_started = true;
                continue;
            }
            output.write_all(&token)?;
            output.write_all(b"\n")?;
            output.flush()?;
            if let Some(active_burst) = burst.as_mut() {
                active_burst.paused_until = Instant::now() + burst_echo_pause;
            }
        }
        let now = Instant::now();
        if let Some(active_burst) = burst.as_mut() {
            let resume_at = active_burst.next_chunk_at.max(active_burst.paused_until);
            if now < resume_at {
                thread::sleep((resume_at - now).min(Duration::from_millis(2)));
                continue;
            }
            let chunk_bytes = active_burst.remaining_bytes.min(burst_chunk.len());
            output.write_all(&burst_chunk[..chunk_bytes])?;
            output.flush()?;
            burst_output_bytes =
                burst_output_bytes.saturating_add(u64::try_from(chunk_bytes).unwrap_or(u64::MAX));
            active_burst.remaining_bytes -= chunk_bytes;
            if active_burst.remaining_bytes == 0 {
                let completed_token = active_burst.token.clone();
                write_profile_marker(&mut output, PROFILE_BURST_END_PREFIX, &completed_token)?;
                burst = None;
                next_output = Instant::now() + steady_interval;
            } else {
                active_burst.next_chunk_at = Instant::now() + burst_chunk_interval;
            }
            continue;
        }
        if now >= next_output {
            generator.fill(&mut steady_chunk);
            output.write_all(&steady_chunk)?;
            output.flush()?;
            steady_output_bytes = steady_output_bytes
                .saturating_add(u64::try_from(steady_chunk.len()).unwrap_or(u64::MAX));
            next_output += steady_interval;
            continue;
        }
        thread::sleep((next_output - now).min(Duration::from_millis(2)));
    }
}

fn profile_burst_token(line: &[u8]) -> Option<&[u8]> {
    profile_control_token(line, PROFILE_BURST_TRIGGER_PREFIX)
}

fn profile_status_token(line: &[u8]) -> Option<&[u8]> {
    profile_control_token(line, PROFILE_STATUS_REQUEST_PREFIX)
}

fn profile_control_token<'a>(line: &'a [u8], prefix: &[u8]) -> Option<&'a [u8]> {
    let token = line.strip_prefix(prefix)?;
    if token.is_empty()
        || token.len() > PROFILE_BURST_TOKEN_MAX_BYTES
        || !token
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return None;
    }
    Some(token)
}

fn write_profile_status(
    output: &mut impl Write,
    token: &[u8],
    steady_output_bytes: u64,
    burst_output_bytes: u64,
) -> anyhow::Result<()> {
    output.write_all(PROFILE_STATUS_RESPONSE_PREFIX)?;
    output.write_all(token)?;
    writeln!(output, ":{steady_output_bytes}:{burst_output_bytes}")?;
    write_profile_marker(output, PROFILE_STATUS_END_PREFIX, token)
}

fn write_profile_marker(
    output: &mut impl Write,
    prefix: &[u8],
    token: &[u8],
) -> anyhow::Result<()> {
    output.write_all(prefix)?;
    output.write_all(token)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
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

    #[test]
    fn profile_terminal_load_requires_the_versioned_workload_arguments() {
        let command = CommandLine::try_parse_from([
            "kmuxd",
            "profile",
            "terminal-load",
            "--bytes-per-second",
            "262144",
            "--steady-chunk-bytes",
            "4096",
            "--burst-bytes",
            "4194304",
            "--burst-chunk-bytes",
            "65536",
            "--burst-chunk-interval-ms",
            "20",
            "--burst-echo-pause-ms",
            "100",
            "--seed",
            "0x4b4d555852454d31",
        ])
        .unwrap();
        let RuntimeCommand::Profile(profile) = command.command else {
            panic!("expected profile command");
        };
        let ProfileSubcommand::TerminalLoad(load) = profile.command;
        assert_eq!(load.bytes_per_second, 262_144);
        assert_eq!(load.steady_chunk_bytes, 4_096);
        assert_eq!(load.burst_bytes, 4_194_304);
        assert_eq!(load.burst_chunk_bytes, 65_536);
        assert_eq!(load.burst_chunk_interval_ms, 20);
        assert_eq!(load.burst_echo_pause_ms, 100);
        assert_eq!(load.seed, 0x4b4d_5558_5245_4d31);

        assert!(
            CommandLine::try_parse_from([
                "kmuxd",
                "profile",
                "terminal-load",
                "--bytes-per-second",
                "262144",
                "--seed",
                "0x4b4d555852454d31",
            ])
            .is_err()
        );
    }

    #[test]
    fn profile_burst_trigger_accepts_only_a_bounded_ascii_token() {
        assert_eq!(
            profile_burst_token(b"KMUX_PROFILE_BURST:profile_123"),
            Some(b"profile_123".as_slice())
        );
        assert_eq!(profile_burst_token(b"ordinary-input"), None);
        assert_eq!(profile_burst_token(b"KMUX_PROFILE_BURST:"), None);
        assert_eq!(profile_burst_token(b"KMUX_PROFILE_BURST:bad token"), None);
        assert_eq!(
            profile_status_token(b"KMUX_PROFILE_STATUS:status_123"),
            Some(b"status_123".as_slice())
        );
    }

    #[test]
    fn profile_input_reader_discards_an_oversized_line_without_losing_the_next_line() {
        let mut bytes = vec![b'x'; 4 * 1024 + 1];
        bytes.extend_from_slice(b"\nnext\n");
        let mut input = io::Cursor::new(bytes);

        assert_eq!(
            read_profile_input_line(&mut input, 4 * 1024).unwrap(),
            Some(ProfileInputLine::Oversized)
        );
        assert_eq!(
            read_profile_input_line(&mut input, 4 * 1024).unwrap(),
            Some(ProfileInputLine::Line(b"next".to_vec()))
        );
    }
}
