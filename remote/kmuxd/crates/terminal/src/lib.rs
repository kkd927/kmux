#![forbid(unsafe_code)]

use std::collections::{HashSet, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{
    Receiver, RecvTimeoutError, SendTimeoutError, Sender, TrySendError, bounded,
};
use parking_lot::RwLock;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const CHECKPOINT_FORMAT: &str = "xterm-vt/1";
pub const CHECKPOINT_PARSER_VERSION: &str = "vt100/0.16";
pub const MAX_CHECKPOINT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_PARSER_RETAINED_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PARSER_CHANNEL_CAPACITY: usize = 65_536;
pub const MAX_TERMINAL_DIMENSION: u16 = 32_767;
pub const PARSER_CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(1);

/// Converts arbitrary PTY reads into independently valid UTF-8 mutation
/// payloads without replacing a code point merely because the kernel split it
/// across reads. At most one incomplete scalar (three bytes) is retained.
#[derive(Debug, Default)]
pub struct Utf8OutputNormalizer {
    pending: Vec<u8>,
}

impl Utf8OutputNormalizer {
    #[must_use]
    pub fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(bytes);
        self.drain(false)
    }

    #[must_use]
    pub fn flush(&mut self) -> Vec<u8> {
        self.drain(true)
    }

    fn drain(&mut self, flush: bool) -> Vec<u8> {
        let mut output = Vec::with_capacity(self.pending.len());
        loop {
            if self.pending.is_empty() {
                break;
            }
            match std::str::from_utf8(&self.pending) {
                Ok(_) => {
                    output.extend_from_slice(&self.pending);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    let error_len = error.error_len();
                    if valid_up_to > 0 {
                        output.extend(self.pending.drain(..valid_up_to));
                    }
                    match error_len {
                        Some(length) => {
                            output.extend_from_slice("�".as_bytes());
                            self.pending.drain(..length);
                        }
                        None if flush => {
                            output.extend_from_slice(
                                String::from_utf8_lossy(&self.pending).as_bytes(),
                            );
                            self.pending.clear();
                            break;
                        }
                        None => break,
                    }
                }
            }
        }
        debug_assert!(flush || self.pending.len() <= 3);
        output
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalMutation {
    Output {
        sequence: u64,
        data: Vec<u8>,
    },
    Resize {
        sequence: u64,
        cols: u16,
        rows: u16,
    },
    Exit {
        sequence: u64,
        exit_code: Option<i32>,
    },
}

impl TerminalMutation {
    #[must_use]
    pub fn sequence(&self) -> u64 {
        match self {
            Self::Output { sequence, .. }
            | Self::Resize { sequence, .. }
            | Self::Exit { sequence, .. } => *sequence,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalCheckpoint {
    pub format: String,
    pub parser_version: String,
    pub last_mutation_sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub restore_stream: Vec<u8>,
    pub sha256: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TerminalModelError {
    #[error("mutation sequence {actual} did not follow {expected_previous}")]
    SequenceGap { expected_previous: u64, actual: u64 },
    #[error("terminal dimensions must both be non-zero")]
    InvalidDimensions,
    #[error("checkpoint exceeds the {MAX_CHECKPOINT_BYTES} byte hard limit")]
    CheckpointTooLarge,
    #[error("checkpoint format or parser version is incompatible")]
    IncompatibleCheckpoint,
    #[error("checkpoint digest does not match its restore stream")]
    CheckpointDigestMismatch,
    #[error("parser checkpoint did not complete before its deadline")]
    CheckpointTimedOut,
    #[error("parser worker is unavailable")]
    ParserUnavailable,
}

pub struct HeadlessTerminalModel {
    parser: vt100::Parser,
    cols: u16,
    rows: u16,
    last_sequence: u64,
}

impl HeadlessTerminalModel {
    #[must_use]
    pub fn new(cols: u16, rows: u16) -> Self {
        assert!(
            valid_dimensions(cols, rows),
            "terminal dimensions must be within 1..={MAX_TERMINAL_DIMENSION}"
        );
        Self {
            parser: vt100::Parser::new(rows, cols, 0),
            cols,
            rows,
            last_sequence: 0,
        }
    }

    pub fn from_checkpoint(checkpoint: &TerminalCheckpoint) -> Result<Self, TerminalModelError> {
        if checkpoint.format != CHECKPOINT_FORMAT
            || checkpoint.parser_version != CHECKPOINT_PARSER_VERSION
        {
            return Err(TerminalModelError::IncompatibleCheckpoint);
        }
        if !valid_dimensions(checkpoint.cols, checkpoint.rows) {
            return Err(TerminalModelError::InvalidDimensions);
        }
        if checkpoint.restore_stream.len() > MAX_CHECKPOINT_BYTES {
            return Err(TerminalModelError::CheckpointTooLarge);
        }
        let actual_digest = format!("{:x}", Sha256::digest(&checkpoint.restore_stream));
        if actual_digest != checkpoint.sha256 {
            return Err(TerminalModelError::CheckpointDigestMismatch);
        }
        let mut model = Self::new(checkpoint.cols, checkpoint.rows);
        model.parser.process(&checkpoint.restore_stream);
        model.last_sequence = checkpoint.last_mutation_sequence;
        Ok(model)
    }

    pub fn apply(&mut self, mutation: &TerminalMutation) -> Result<(), TerminalModelError> {
        let actual = mutation.sequence();
        if self.last_sequence.checked_add(1) != Some(actual) {
            return Err(TerminalModelError::SequenceGap {
                expected_previous: self.last_sequence,
                actual,
            });
        }
        match mutation {
            TerminalMutation::Output { data, .. } => self.parser.process(data),
            TerminalMutation::Resize { cols, rows, .. } => {
                if !valid_dimensions(*cols, *rows) {
                    return Err(TerminalModelError::InvalidDimensions);
                }
                self.parser.screen_mut().set_size(*rows, *cols);
                self.cols = *cols;
                self.rows = *rows;
            }
            TerminalMutation::Exit { .. } => {}
        }
        self.last_sequence = actual;
        Ok(())
    }

    pub fn replay<'a>(
        &mut self,
        mutations: impl IntoIterator<Item = &'a TerminalMutation>,
    ) -> Result<(), TerminalModelError> {
        for mutation in mutations {
            self.apply(mutation)?;
        }
        Ok(())
    }

    pub fn checkpoint(
        &self,
        synced_through: u64,
    ) -> Result<TerminalCheckpoint, TerminalModelError> {
        let last_mutation_sequence = self.last_sequence.min(synced_through);
        if last_mutation_sequence != self.last_sequence {
            return Err(TerminalModelError::SequenceGap {
                expected_previous: synced_through,
                actual: self.last_sequence,
            });
        }
        let restore_stream = self.parser.screen().state_formatted();
        if restore_stream.len() > MAX_CHECKPOINT_BYTES {
            return Err(TerminalModelError::CheckpointTooLarge);
        }
        let sha256 = format!("{:x}", Sha256::digest(&restore_stream));
        Ok(TerminalCheckpoint {
            format: CHECKPOINT_FORMAT.to_owned(),
            parser_version: CHECKPOINT_PARSER_VERSION.to_owned(),
            last_mutation_sequence,
            cols: self.cols,
            rows: self.rows,
            restore_stream,
            sha256,
        })
    }

    #[must_use]
    pub fn plain_text(&self) -> String {
        self.parser.screen().contents()
    }

    #[must_use]
    pub fn last_sequence(&self) -> u64 {
        self.last_sequence
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParserStatus {
    Running,
    Behind,
    Rebuilding,
    Degraded,
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum ParserSideEffectKind {
    Bell,
    Notification {
        protocol: u16,
        title: Option<String>,
        message: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ParserSideEffect {
    pub mutation_sequence: u64,
    pub action_index: u32,
    pub kind: ParserSideEffectKind,
}

const MAX_OSC_SIDE_EFFECT_BYTES: usize = 64 * 1024;
const MAX_NOTIFICATION_TEXT_BYTES: usize = 4 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum OscScanState {
    #[default]
    Ground,
    Escape,
    Osc,
    OscEscape,
    DiscardOsc,
    DiscardOscEscape,
}

#[derive(Clone, Debug, Default)]
pub struct TerminalSideEffectScanner {
    state: OscScanState,
    osc: Vec<u8>,
    title: Option<String>,
    cwd: Option<String>,
    osc99_pending_title: Option<String>,
    oversized_osc_count: u64,
}

impl TerminalSideEffectScanner {
    #[must_use]
    pub fn scan(&mut self, mutation: &TerminalMutation) -> Vec<ParserSideEffect> {
        let TerminalMutation::Output { sequence, data } = mutation else {
            return Vec::new();
        };
        let mut effects = Vec::new();
        for &byte in data {
            match self.state {
                OscScanState::Ground => match byte {
                    0x1b => self.state = OscScanState::Escape,
                    0x07 => {
                        push_scanned_effect(&mut effects, *sequence, ParserSideEffectKind::Bell)
                    }
                    _ => {}
                },
                OscScanState::Escape => {
                    if byte == b']' {
                        self.osc.clear();
                        self.state = OscScanState::Osc;
                    } else {
                        self.state = OscScanState::Ground;
                        if byte == 0x1b {
                            self.state = OscScanState::Escape;
                        } else if byte == 0x07 {
                            push_scanned_effect(
                                &mut effects,
                                *sequence,
                                ParserSideEffectKind::Bell,
                            );
                        }
                    }
                }
                OscScanState::Osc => match byte {
                    0x07 => self.finish_osc(*sequence, &mut effects),
                    0x1b => self.state = OscScanState::OscEscape,
                    _ => self.push_osc_byte(byte),
                },
                OscScanState::OscEscape => {
                    if byte == b'\\' || byte == 0x07 {
                        self.finish_osc(*sequence, &mut effects);
                    } else {
                        self.push_osc_byte(0x1b);
                        if self.state == OscScanState::Osc {
                            if byte == 0x1b {
                                self.state = OscScanState::OscEscape;
                            } else {
                                self.push_osc_byte(byte);
                            }
                        }
                    }
                }
                OscScanState::DiscardOsc => match byte {
                    0x07 => self.reset_osc(),
                    0x1b => self.state = OscScanState::DiscardOscEscape,
                    _ => {}
                },
                OscScanState::DiscardOscEscape => {
                    if byte == b'\\' || byte == 0x07 {
                        self.reset_osc();
                    } else if byte != 0x1b {
                        self.state = OscScanState::DiscardOsc;
                    }
                }
            }
        }
        effects
    }

    #[must_use]
    pub fn oversized_osc_count(&self) -> u64 {
        self.oversized_osc_count
    }

    fn push_osc_byte(&mut self, byte: u8) {
        if self.osc.len() >= MAX_OSC_SIDE_EFFECT_BYTES {
            self.osc.clear();
            self.oversized_osc_count = self.oversized_osc_count.saturating_add(1);
            self.state = OscScanState::DiscardOsc;
            return;
        }
        self.osc.push(byte);
        self.state = OscScanState::Osc;
    }

    fn finish_osc(&mut self, sequence: u64, effects: &mut Vec<ParserSideEffect>) {
        let data = std::mem::take(&mut self.osc);
        self.state = OscScanState::Ground;
        let text = String::from_utf8_lossy(&data);
        let Some((command, payload)) = text.split_once(';') else {
            return;
        };
        match command.trim() {
            "0" | "2" => self.title = normalize_notification_text(payload),
            "7" => self.cwd = normalize_notification_text(payload),
            "9" => {
                if let Some((title, message)) = parse_osc9_notification(payload, &self.title) {
                    push_scanned_effect(
                        effects,
                        sequence,
                        ParserSideEffectKind::Notification {
                            protocol: 9,
                            title,
                            message,
                        },
                    );
                }
            }
            "99" => {
                if let Some((title, message)) = self.parse_osc99_notification(payload) {
                    push_scanned_effect(
                        effects,
                        sequence,
                        ParserSideEffectKind::Notification {
                            protocol: 99,
                            title,
                            message,
                        },
                    );
                }
            }
            "777" => {
                if let Some((title, message)) =
                    parse_osc777_notification(payload, &self.title, &self.cwd)
                {
                    push_scanned_effect(
                        effects,
                        sequence,
                        ParserSideEffectKind::Notification {
                            protocol: 777,
                            title,
                            message,
                        },
                    );
                }
            }
            _ => {}
        }
    }

    fn parse_osc99_notification(
        &mut self,
        payload: &str,
    ) -> Option<(Option<String>, Option<String>)> {
        let trimmed = payload.trim();
        if trimmed.is_empty() {
            return None;
        }
        let (head, tail) = payload
            .split_once(';')
            .map_or((payload.trim(), ""), |(head, tail)| (head.trim(), tail));
        if head == "d=0" {
            self.osc99_pending_title = normalize_notification_text(tail);
            return None;
        }
        if head == "p=body" {
            let message = normalize_notification_text(tail);
            let pending_title = self.osc99_pending_title.take();
            let title = pending_title.clone().or_else(|| self.title.clone());
            return (pending_title.is_some() || message.is_some()).then_some((title, message));
        }
        self.osc99_pending_title = None;
        Some((self.title.clone(), normalize_notification_text(trimmed)))
    }

    fn reset_osc(&mut self) {
        self.osc.clear();
        self.state = OscScanState::Ground;
    }
}

fn push_scanned_effect(
    effects: &mut Vec<ParserSideEffect>,
    mutation_sequence: u64,
    kind: ParserSideEffectKind,
) {
    let action_index = u32::try_from(effects.len()).unwrap_or(u32::MAX);
    effects.push(ParserSideEffect {
        mutation_sequence,
        action_index,
        kind,
    });
}

fn parse_osc9_notification(
    payload: &str,
    fallback_title: &Option<String>,
) -> Option<(Option<String>, Option<String>)> {
    if let Some((subtype, message)) = payload.split_once(';')
        && subtype.bytes().all(|byte| byte.is_ascii_digit())
    {
        if subtype.parse::<u64>().ok() != Some(1) {
            return None;
        }
        return Some((fallback_title.clone(), normalize_notification_text(message)));
    }
    Some((fallback_title.clone(), normalize_notification_text(payload)))
}

fn parse_osc777_notification(
    payload: &str,
    fallback_title: &Option<String>,
    fallback_message: &Option<String>,
) -> Option<(Option<String>, Option<String>)> {
    let mut parts = payload.split(';');
    if parts.next()?.trim() != "notify" {
        return None;
    }
    let title = parts
        .next()
        .and_then(normalize_notification_text)
        .or_else(|| fallback_title.clone());
    let message = normalize_notification_text(&parts.collect::<Vec<_>>().join(";"))
        .or_else(|| fallback_message.clone());
    Some((title, message))
}

fn normalize_notification_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut end = trimmed.len().min(MAX_NOTIFICATION_TEXT_BYTES);
    while !trimmed.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    Some(trimmed[..end].to_owned())
}

enum ParserCommand {
    Mutation(TerminalMutation),
    Snapshot(Sender<Result<TerminalCheckpoint, TerminalModelError>>, u64),
    InjectPanic,
    #[cfg(test)]
    InjectStall(Sender<()>, Receiver<()>),
    Stop,
}

#[derive(Clone, Default)]
struct ParserRecoveryState {
    checkpoint: Option<TerminalCheckpoint>,
    tail: VecDeque<TerminalMutation>,
    tail_bytes: usize,
    missing_tail: bool,
}

impl ParserRecoveryState {
    fn retain(&mut self, mutation: TerminalMutation) -> bool {
        let previous = self
            .tail
            .back()
            .map(TerminalMutation::sequence)
            .or_else(|| {
                self.checkpoint
                    .as_ref()
                    .map(|checkpoint| checkpoint.last_mutation_sequence)
            })
            .unwrap_or(0);
        if previous.checked_add(1) != Some(mutation.sequence()) {
            self.missing_tail = true;
            return false;
        }
        let bytes = retained_mutation_bytes(&mutation);
        if bytes > MAX_PARSER_RETAINED_BYTES {
            self.tail.clear();
            self.tail_bytes = 0;
            self.missing_tail = true;
            return true;
        }
        while self.tail_bytes.saturating_add(bytes) > MAX_PARSER_RETAINED_BYTES {
            let Some(removed) = self.tail.pop_front() else {
                break;
            };
            self.tail_bytes = self
                .tail_bytes
                .saturating_sub(retained_mutation_bytes(&removed));
            self.missing_tail = true;
        }
        self.tail_bytes = self.tail_bytes.saturating_add(bytes);
        self.tail.push_back(mutation);
        true
    }

    fn advance_checkpoint(&mut self, checkpoint: TerminalCheckpoint) {
        while self
            .tail
            .front()
            .is_some_and(|mutation| mutation.sequence() <= checkpoint.last_mutation_sequence)
        {
            if let Some(removed) = self.tail.pop_front() {
                self.tail_bytes = self
                    .tail_bytes
                    .saturating_sub(retained_mutation_bytes(&removed));
            }
        }
        self.missing_tail = self.tail.front().is_some_and(|mutation| {
            checkpoint
                .last_mutation_sequence
                .checked_add(1)
                .is_none_or(|expected| mutation.sequence() != expected)
        });
        self.checkpoint = Some(checkpoint);
    }

    fn rebuild(&self, cols: u16, rows: u16) -> Result<HeadlessTerminalModel, TerminalModelError> {
        if self.missing_tail {
            return Err(TerminalModelError::SequenceGap {
                expected_previous: self
                    .checkpoint
                    .as_ref()
                    .map_or(0, |checkpoint| checkpoint.last_mutation_sequence),
                actual: self.tail.front().map_or(0, TerminalMutation::sequence),
            });
        }
        let mut replacement = match &self.checkpoint {
            Some(checkpoint) => HeadlessTerminalModel::from_checkpoint(checkpoint)?,
            None => HeadlessTerminalModel::new(cols, rows),
        };
        replacement.replay(self.tail.iter())?;
        Ok(replacement)
    }

    fn latest_sequence(&self) -> u64 {
        self.tail
            .back()
            .map(TerminalMutation::sequence)
            .or_else(|| {
                self.checkpoint
                    .as_ref()
                    .map(|checkpoint| checkpoint.last_mutation_sequence)
            })
            .unwrap_or(0)
    }
}

fn retained_mutation_bytes(mutation: &TerminalMutation) -> usize {
    match mutation {
        TerminalMutation::Output { data, .. } => data.len().saturating_add(32),
        TerminalMutation::Resize { .. } | TerminalMutation::Exit { .. } => 32,
    }
}

fn valid_dimensions(cols: u16, rows: u16) -> bool {
    cols > 0 && rows > 0 && cols <= MAX_TERMINAL_DIMENSION && rows <= MAX_TERMINAL_DIMENSION
}

pub struct ParserWorker {
    sender: Sender<ParserCommand>,
    status: Arc<RwLock<ParserStatus>>,
    retained: Arc<RwLock<ParserRecoveryState>>,
    side_effects: Receiver<ParserSideEffect>,
    join: Option<JoinHandle<()>>,
}

impl ParserWorker {
    #[must_use]
    pub fn start(cols: u16, rows: u16, capacity: usize) -> Self {
        assert!(
            (1..=MAX_PARSER_CHANNEL_CAPACITY).contains(&capacity),
            "parser capacity must be within its hard bound"
        );
        let (sender, receiver) = bounded(capacity);
        let (side_effect_sender, side_effects) = bounded(capacity.saturating_mul(4));
        let status = Arc::new(RwLock::new(ParserStatus::Running));
        let retained = Arc::new(RwLock::new(ParserRecoveryState::default()));
        let worker_status = Arc::clone(&status);
        let worker_retained = Arc::clone(&retained);
        let join = thread::Builder::new()
            .name("kmux-headless-parser".to_owned())
            .spawn(move || {
                parser_loop(
                    receiver,
                    worker_status,
                    worker_retained,
                    side_effect_sender,
                    cols,
                    rows,
                );
            })
            .expect("parser worker thread must start");
        Self {
            sender,
            status,
            retained,
            side_effects,
            join: Some(join),
        }
    }

    pub fn try_submit(&self, mutation: TerminalMutation) -> bool {
        if !self.retained.write().retain(mutation.clone()) {
            *self.status.write() = ParserStatus::Degraded;
            return false;
        }
        match self.sender.try_send(ParserCommand::Mutation(mutation)) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                *self.status.write() = ParserStatus::Behind;
                false
            }
            Err(TrySendError::Disconnected(_)) => {
                *self.status.write() = ParserStatus::Degraded;
                false
            }
        }
    }

    pub fn inject_panic(&self) -> bool {
        self.sender.try_send(ParserCommand::InjectPanic).is_ok()
    }

    pub fn checkpoint(
        &self,
        synced_through: u64,
    ) -> Result<TerminalCheckpoint, TerminalModelError> {
        self.checkpoint_with_timeout(synced_through, PARSER_CHECKPOINT_TIMEOUT)
    }

    fn checkpoint_with_timeout(
        &self,
        synced_through: u64,
        timeout: Duration,
    ) -> Result<TerminalCheckpoint, TerminalModelError> {
        let (sender, receiver) = bounded(1);
        let deadline = Instant::now() + timeout;
        match self
            .sender
            .send_timeout(ParserCommand::Snapshot(sender, synced_through), timeout)
        {
            Ok(()) => {}
            Err(SendTimeoutError::Timeout(_)) => {
                *self.status.write() = ParserStatus::Behind;
                return Err(TerminalModelError::CheckpointTimedOut);
            }
            Err(SendTimeoutError::Disconnected(_)) => {
                *self.status.write() = ParserStatus::Degraded;
                return Err(TerminalModelError::ParserUnavailable);
            }
        }
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                *self.status.write() = ParserStatus::Degraded;
                Err(TerminalModelError::CheckpointTimedOut)
            }
            Err(RecvTimeoutError::Disconnected) => {
                *self.status.write() = ParserStatus::Degraded;
                Err(TerminalModelError::ParserUnavailable)
            }
        }
    }

    #[cfg(test)]
    fn inject_stall(&self, ready: Sender<()>, release: Receiver<()>) -> bool {
        self.sender
            .try_send(ParserCommand::InjectStall(ready, release))
            .is_ok()
    }

    #[must_use]
    pub fn status(&self) -> ParserStatus {
        *self.status.read()
    }

    pub fn try_side_effect(&self) -> Option<ParserSideEffect> {
        self.side_effects.try_recv().ok()
    }
}

impl Drop for ParserWorker {
    fn drop(&mut self) {
        let _ = self.sender.send(ParserCommand::Stop);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

#[derive(Default)]
pub struct SideEffectDeduplicator {
    applied: HashSet<(u64, u32)>,
}

impl SideEffectDeduplicator {
    pub fn admit(&mut self, effect: &ParserSideEffect) -> bool {
        self.applied
            .insert((effect.mutation_sequence, effect.action_index))
    }
}

fn parser_loop(
    receiver: Receiver<ParserCommand>,
    status: Arc<RwLock<ParserStatus>>,
    retained: Arc<RwLock<ParserRecoveryState>>,
    side_effects: Sender<ParserSideEffect>,
    cols: u16,
    rows: u16,
) {
    let mut model = HeadlessTerminalModel::new(cols, rows);
    while let Ok(command) = receiver.recv() {
        if matches!(command, ParserCommand::Stop) {
            *status.write() = ParserStatus::Stopped;
            return;
        }
        let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<(), TerminalModelError> {
            match command {
                ParserCommand::Mutation(ref mutation) => {
                    if mutation.sequence() <= model.last_sequence() {
                        return Ok(());
                    }
                    model.apply(mutation)?;
                    emit_side_effects(mutation, &side_effects);
                    Ok(())
                }
                ParserCommand::Snapshot(ref response, synced_through) => {
                    let result = model.checkpoint(synced_through);
                    if let Ok(checkpoint) = &result {
                        retained.write().advance_checkpoint(checkpoint.clone());
                    }
                    let _ = response.send(result);
                    Ok(())
                }
                ParserCommand::InjectPanic => panic!("injected parser unwind"),
                #[cfg(test)]
                ParserCommand::InjectStall(ref ready, ref release) => {
                    let _ = ready.send(());
                    let _ = release.recv();
                    Ok(())
                }
                ParserCommand::Stop => Ok(()),
            }
        }));
        let needs_rebuild = outcome.is_err()
            || outcome.as_ref().is_ok_and(Result::is_err)
            || *status.read() == ParserStatus::Behind;
        if needs_rebuild {
            *status.write() = ParserStatus::Rebuilding;
            let rebuilt = catch_unwind(AssertUnwindSafe(|| {
                rebuild_until_caught_up(&status, &retained, &side_effects, cols, rows)
            }));
            match rebuilt {
                Ok(Ok(replacement)) => model = replacement,
                Ok(Err(_)) | Err(_) => *status.write() = ParserStatus::Degraded,
            }
        }
    }
    *status.write() = ParserStatus::Stopped;
}

fn rebuild_until_caught_up(
    status: &RwLock<ParserStatus>,
    retained: &RwLock<ParserRecoveryState>,
    side_effects: &Sender<ParserSideEffect>,
    cols: u16,
    rows: u16,
) -> Result<HeadlessTerminalModel, TerminalModelError> {
    loop {
        let recovery = retained.read().clone();
        let replacement = recovery.rebuild(cols, rows)?;
        for mutation in &recovery.tail {
            emit_side_effects(mutation, side_effects);
        }

        // Publish Running while retention is read-locked so a later queue
        // overflow cannot be hidden by a stale recovery completion.
        let current = retained.read();
        if current.latest_sequence() == replacement.last_sequence() {
            *status.write() = ParserStatus::Running;
            return Ok(replacement);
        }
    }
}

fn emit_side_effects(mutation: &TerminalMutation, sender: &Sender<ParserSideEffect>) {
    let TerminalMutation::Output { sequence, data } = mutation else {
        return;
    };
    let mut action_index = 0_u32;
    for byte in data {
        let kind = match byte {
            0x07 => Some(ParserSideEffectKind::Bell),
            _ => None,
        };
        if let Some(kind) = kind {
            let _ = sender.try_send(ParserSideEffect {
                mutation_sequence: *sequence,
                action_index,
                kind,
            });
            action_index = action_index.saturating_add(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn utf8_output_normalizer_preserves_scalars_split_across_pty_reads() {
        let mut normalizer = Utf8OutputNormalizer::default();
        assert_eq!(normalizer.push(&[b'a', 0xe2]), b"a");
        assert!(normalizer.push(&[0x82]).is_empty());
        assert_eq!(normalizer.push(&[0xac, b'b']), "€b".as_bytes());
        assert!(normalizer.flush().is_empty());
    }

    #[test]
    fn utf8_output_normalizer_replaces_invalid_and_flushed_incomplete_bytes() {
        let mut normalizer = Utf8OutputNormalizer::default();
        assert_eq!(normalizer.push(&[0xff, b'a']), "�a".as_bytes());
        assert!(normalizer.push(&[0xf0, 0x9f]).is_empty());
        assert_eq!(normalizer.flush(), "�".as_bytes());
    }

    fn fixture_mutations() -> Vec<TerminalMutation> {
        vec![
            TerminalMutation::Output {
                sequence: 1,
                data: b"alpha\r\n".to_vec(),
            },
            TerminalMutation::Resize {
                sequence: 2,
                cols: 100,
                rows: 30,
            },
            TerminalMutation::Output {
                sequence: 3,
                data: b"\x1b[32mbeta\x1b[0m".to_vec(),
            },
        ]
    }

    #[test]
    fn checkpoint_resize_output_replays_to_the_live_screen() {
        let mutations = fixture_mutations();
        let mut live = HeadlessTerminalModel::new(80, 24);
        live.replay(&mutations).unwrap();

        let mut before_delta = HeadlessTerminalModel::new(80, 24);
        before_delta.apply(&mutations[0]).unwrap();
        let checkpoint = before_delta.checkpoint(1).unwrap();
        let mut restored = HeadlessTerminalModel::from_checkpoint(&checkpoint).unwrap();
        restored.replay(&mutations[1..]).unwrap();
        let restored_checkpoint = restored.checkpoint(3).unwrap();
        let live_checkpoint = live.checkpoint(3).unwrap();

        assert_eq!(restored.plain_text(), live.plain_text());
        assert_eq!(
            restored_checkpoint.restore_stream,
            live_checkpoint.restore_stream
        );
        assert_eq!(
            (restored_checkpoint.cols, restored_checkpoint.rows),
            (100, 30)
        );
        assert_eq!(checkpoint.format, CHECKPOINT_FORMAT);
    }

    #[test]
    fn parser_unwind_rebuilds_without_losing_retained_mutations() {
        let worker = ParserWorker::start(80, 24, 16);
        for mutation in fixture_mutations() {
            assert!(worker.try_submit(mutation));
        }
        assert!(worker.inject_panic());
        let deadline = Instant::now() + Duration::from_secs(2);
        while worker.status() != ParserStatus::Running && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let checkpoint = worker.checkpoint(3).unwrap();
        let restored = HeadlessTerminalModel::from_checkpoint(&checkpoint).unwrap();
        assert!(restored.plain_text().contains("beta"));

        assert!(worker.try_submit(TerminalMutation::Output {
            sequence: 4,
            data: b"after-unwind".to_vec(),
        }));
        let checkpoint = worker.checkpoint(4).unwrap();
        let restored = HeadlessTerminalModel::from_checkpoint(&checkpoint).unwrap();
        assert!(restored.plain_text().contains("after-unwind"));
    }

    #[test]
    fn stalled_parser_checkpoint_returns_within_its_deadline() {
        let worker = ParserWorker::start(80, 24, 4);
        let (ready_sender, ready_receiver) = bounded(1);
        let (release_sender, release_receiver) = bounded(1);
        assert!(worker.inject_stall(ready_sender, release_receiver));
        ready_receiver.recv_timeout(Duration::from_secs(1)).unwrap();

        let timeout = Duration::from_millis(25);
        let started = Instant::now();
        assert_eq!(
            worker.checkpoint_with_timeout(0, timeout),
            Err(TerminalModelError::CheckpointTimedOut)
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(worker.status(), ParserStatus::Degraded);

        release_sender.send(()).unwrap();
    }

    #[test]
    fn checkpoint_compatibility_and_digest_fail_closed() {
        let mut live = HeadlessTerminalModel::new(80, 24);
        live.apply(&TerminalMutation::Output {
            sequence: 1,
            data: b"checkpoint".to_vec(),
        })
        .unwrap();
        let mut checkpoint = live.checkpoint(1).unwrap();
        checkpoint.restore_stream.push(b'x');
        assert!(matches!(
            HeadlessTerminalModel::from_checkpoint(&checkpoint),
            Err(TerminalModelError::CheckpointDigestMismatch)
        ));

        checkpoint.sha256 = format!("{:x}", Sha256::digest(&checkpoint.restore_stream));
        checkpoint.parser_version = "other-parser/1".to_owned();
        assert!(matches!(
            HeadlessTerminalModel::from_checkpoint(&checkpoint),
            Err(TerminalModelError::IncompatibleCheckpoint)
        ));
    }

    #[test]
    fn replayed_side_effect_identity_is_deduplicated_by_the_owner() {
        let mut dedupe = SideEffectDeduplicator::default();
        let effect = ParserSideEffect {
            mutation_sequence: 7,
            action_index: 0,
            kind: ParserSideEffectKind::Bell,
        };
        assert!(dedupe.admit(&effect));
        assert!(!dedupe.admit(&effect));
    }

    #[test]
    fn side_effect_scanner_parses_split_osc_notifications_with_stable_identity() {
        let mut scanner = TerminalSideEffectScanner::default();
        let first = TerminalMutation::Output {
            sequence: 1,
            data: b"\x1b]2;shell\x07\x1b]777;notify;Build".to_vec(),
        };
        assert!(scanner.scan(&first).is_empty());

        let second = TerminalMutation::Output {
            sequence: 2,
            data: b" complete;All tasks passed\x1b\\\x07".to_vec(),
        };
        assert_eq!(
            scanner.scan(&second),
            vec![
                ParserSideEffect {
                    mutation_sequence: 2,
                    action_index: 0,
                    kind: ParserSideEffectKind::Notification {
                        protocol: 777,
                        title: Some("Build complete".to_owned()),
                        message: Some("All tasks passed".to_owned()),
                    },
                },
                ParserSideEffect {
                    mutation_sequence: 2,
                    action_index: 1,
                    kind: ParserSideEffectKind::Bell,
                }
            ]
        );
    }

    #[test]
    fn side_effect_scanner_matches_osc9_and_osc99_notification_semantics() {
        let mut scanner = TerminalSideEffectScanner::default();
        let effects = scanner.scan(&TerminalMutation::Output {
            sequence: 4,
            data: concat!(
                "\x1b]9;4;0;\x07",
                "\x1b]9;1;finished\x07",
                "\x1b]99;d=0;Build complete\x07",
                "\x1b]99;p=body;All tasks passed\x07"
            )
            .as_bytes()
            .to_vec(),
        });
        assert_eq!(effects.len(), 2);
        assert_eq!(effects[0].action_index, 0);
        assert_eq!(
            effects[0].kind,
            ParserSideEffectKind::Notification {
                protocol: 9,
                title: None,
                message: Some("finished".to_owned()),
            }
        );
        assert_eq!(effects[1].action_index, 1);
        assert_eq!(
            effects[1].kind,
            ParserSideEffectKind::Notification {
                protocol: 99,
                title: Some("Build complete".to_owned()),
                message: Some("All tasks passed".to_owned()),
            }
        );

        let zero_padded = scanner.scan(&TerminalMutation::Output {
            sequence: 4,
            data: b"\x1b]9;01;Padded subtype\x07".to_vec(),
        });
        assert_eq!(zero_padded.len(), 1);
        assert_eq!(
            zero_padded[0].kind,
            ParserSideEffectKind::Notification {
                protocol: 9,
                title: None,
                message: Some("Padded subtype".to_owned()),
            }
        );
    }

    #[test]
    fn side_effect_scanner_discards_oversized_osc_without_treating_its_bell_as_a_bell() {
        let mut scanner = TerminalSideEffectScanner::default();
        let mut data = b"\x1b]9;".to_vec();
        data.extend(std::iter::repeat_n(b'x', MAX_OSC_SIDE_EFFECT_BYTES + 1));
        data.push(0x07);
        data.extend_from_slice(b"\x1b]9;ok\x07");
        let effects = scanner.scan(&TerminalMutation::Output { sequence: 5, data });
        assert_eq!(scanner.oversized_osc_count(), 1);
        assert_eq!(effects.len(), 1);
        assert!(matches!(
            &effects[0].kind,
            ParserSideEffectKind::Notification {
                protocol: 9,
                message: Some(message),
                ..
            } if message == "ok"
        ));
    }

    #[test]
    fn parser_recovery_retention_is_bounded_and_a_fresh_checkpoint_heals_the_gap() {
        let mut recovery = ParserRecoveryState::default();
        assert!(recovery.retain(TerminalMutation::Output {
            sequence: 1,
            data: vec![b'a'; 3 * 1024 * 1024],
        }));
        assert!(recovery.retain(TerminalMutation::Output {
            sequence: 2,
            data: vec![b'b'; 3 * 1024 * 1024],
        }));
        assert!(recovery.tail_bytes <= MAX_PARSER_RETAINED_BYTES);
        assert!(recovery.missing_tail);

        let mut model = HeadlessTerminalModel::new(80, 24);
        model
            .apply(&TerminalMutation::Output {
                sequence: 1,
                data: b"a".to_vec(),
            })
            .unwrap();
        model
            .apply(&TerminalMutation::Output {
                sequence: 2,
                data: b"b".to_vec(),
            })
            .unwrap();
        recovery.advance_checkpoint(model.checkpoint(2).unwrap());
        assert!(!recovery.missing_tail);
        assert!(recovery.tail.is_empty());
        assert!(recovery.retain(TerminalMutation::Output {
            sequence: 3,
            data: b"tail".to_vec(),
        }));
        assert_eq!(recovery.rebuild(80, 24).unwrap().last_sequence(), 3);
    }

    #[test]
    fn full_parser_queue_eventually_rebuilds_through_the_latest_mutation() {
        const LAST_SEQUENCE: u64 = 5_000;
        let worker = ParserWorker::start(80, 24, 1);
        let mut dropped_from_queue = 0_u64;
        for sequence in 1..=LAST_SEQUENCE {
            if !worker.try_submit(TerminalMutation::Output {
                sequence,
                data: b"x".to_vec(),
            }) {
                dropped_from_queue += 1;
            }
        }
        assert!(dropped_from_queue > 0);

        let deadline = Instant::now() + Duration::from_secs(5);
        while worker.status() != ParserStatus::Running && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(worker.status(), ParserStatus::Running);
        assert_eq!(
            worker
                .checkpoint(LAST_SEQUENCE)
                .unwrap()
                .last_mutation_sequence,
            LAST_SEQUENCE
        );
    }
}
