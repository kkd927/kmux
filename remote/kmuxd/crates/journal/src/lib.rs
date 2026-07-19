#![forbid(unsafe_code)]

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::time::{Duration, Instant};

use kmux_terminal::TerminalMutation;
use thiserror::Error;

pub const JOURNAL_GROUP_SYNC_INTERVAL: Duration = Duration::from_millis(50);
pub const JOURNAL_GROUP_SYNC_BYTES: usize = 1024 * 1024;
pub const STORAGE_DEGRADED_SYNC_DURATION: Duration = Duration::from_secs(2);
pub const MAX_JOURNAL_RECORD_BYTES: usize = 1024 * 1024;
pub const JOURNAL_RECORD_VERSION: u8 = 1;
pub const MAX_JOURNAL_RECOVERY_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_JOURNAL_RECOVERY_MUTATIONS: usize = 1_000_000;

pub trait JournalStorage: Write + Send {
    fn current_offset(&mut self) -> io::Result<u64>;
    fn current_len(&self) -> io::Result<u64>;
    fn rollback_to(&mut self, offset: u64) -> io::Result<()>;
    fn sync_data_with_duration(&mut self) -> io::Result<Duration>;
}

impl JournalStorage for File {
    fn current_offset(&mut self) -> io::Result<u64> {
        self.stream_position()
    }

    fn current_len(&self) -> io::Result<u64> {
        Ok(self.metadata()?.len())
    }

    fn rollback_to(&mut self, offset: u64) -> io::Result<()> {
        self.set_len(offset)?;
        self.seek(SeekFrom::Start(offset))?;
        Ok(())
    }

    fn sync_data_with_duration(&mut self) -> io::Result<Duration> {
        let started = Instant::now();
        self.sync_data()?;
        Ok(started.elapsed())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JournalAdmission {
    pub journal_admitted: u64,
    pub journal_synced: u64,
    pub storage_degraded: bool,
}

#[derive(Debug, Error)]
pub enum JournalError {
    #[error("mutation sequence {actual} did not follow {previous}")]
    SequenceGap { previous: u64, actual: u64 },
    #[error("journal record exceeds its hard limit")]
    RecordTooLarge,
    #[error("journal storage is unavailable after an earlier write or sync failure")]
    StorageUnavailable,
    #[error("journal storage failed: {0}")]
    Storage(#[from] io::Error),
    #[error("journal write failed ({write_error}) and rollback failed ({rollback_error})")]
    StorageRollback {
        write_error: io::Error,
        rollback_error: io::Error,
    },
    #[error("journal record is corrupt: {0}")]
    CorruptRecord(&'static str),
    #[error("journal recovery exceeds its bounded byte or mutation limit")]
    RecoveryLimit,
    #[error("journal compaction has no synced checkpoint for every admitted mutation")]
    CompactionUnsafe,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalRecovery {
    pub mutations: Vec<TerminalMutation>,
    pub last_complete_sequence: u64,
    pub truncated_tail: bool,
}

pub struct MutationJournal<S: JournalStorage> {
    storage: S,
    admitted_sequence: u64,
    synced_sequence: u64,
    pending_bytes: usize,
    last_sync_at: Duration,
    storage_degraded: bool,
    storage_failed: bool,
    last_sync_duration: Option<Duration>,
}

impl<S: JournalStorage> MutationJournal<S> {
    #[must_use]
    pub fn new(storage: S, now: Duration) -> Self {
        Self::new_after_checkpoint(storage, 0, now)
    }

    #[must_use]
    pub fn new_after_checkpoint(storage: S, checkpoint_sequence: u64, now: Duration) -> Self {
        Self {
            storage,
            admitted_sequence: checkpoint_sequence,
            synced_sequence: checkpoint_sequence,
            pending_bytes: 0,
            last_sync_at: now,
            storage_degraded: false,
            storage_failed: false,
            last_sync_duration: None,
        }
    }

    pub fn append(
        &mut self,
        mutation: &TerminalMutation,
        now: Duration,
    ) -> Result<JournalAdmission, JournalError> {
        let sequence = mutation.sequence();
        if self.admitted_sequence.checked_add(1) != Some(sequence) {
            return Err(JournalError::SequenceGap {
                previous: self.admitted_sequence,
                actual: sequence,
            });
        }
        if self.storage_failed {
            return Err(JournalError::StorageUnavailable);
        }
        let payload = encode_mutation(mutation)?;
        let length = u32::try_from(payload.len()).map_err(|_| JournalError::RecordTooLarge)?;
        let checksum = crc32fast::hash(&payload).to_be_bytes();
        let record_start = match self.storage.current_offset() {
            Ok(offset) => offset,
            Err(error) => {
                self.storage_failed = true;
                self.storage_degraded = true;
                return Err(JournalError::Storage(error));
            }
        };
        if let Err(write_error) = self
            .storage
            .write_all(&length.to_be_bytes())
            .and_then(|()| self.storage.write_all(&payload))
            .and_then(|()| self.storage.write_all(&checksum))
        {
            self.storage_degraded = true;
            return match self.storage.rollback_to(record_start) {
                Ok(()) => Err(JournalError::Storage(write_error)),
                Err(rollback_error) => {
                    self.storage_failed = true;
                    Err(JournalError::StorageRollback {
                        write_error,
                        rollback_error,
                    })
                }
            };
        }
        self.admitted_sequence = sequence;
        self.pending_bytes = self
            .pending_bytes
            .saturating_add(payload.len().saturating_add(8));
        if self.pending_bytes >= JOURNAL_GROUP_SYNC_BYTES {
            // The record is already journal-admitted at this point. A group-sync
            // failure must not make the caller retry and duplicate that record;
            // degraded state plus the unchanged pending byte count drive the
            // subsequent sync retry/backpressure path.
            let _ = self.sync(now);
        }
        Ok(self.admission())
    }

    pub fn sync_if_due(&mut self, now: Duration) -> Result<JournalAdmission, JournalError> {
        if self.storage_failed {
            return Err(JournalError::StorageUnavailable);
        }
        if (self.pending_bytes > 0 || self.storage_degraded)
            && now.saturating_sub(self.last_sync_at) >= JOURNAL_GROUP_SYNC_INTERVAL
        {
            self.sync(now)?;
        }
        Ok(self.admission())
    }

    pub fn force_sync(&mut self, now: Duration) -> Result<JournalAdmission, JournalError> {
        if self.storage_failed {
            return Err(JournalError::StorageUnavailable);
        }
        if self.pending_bytes > 0 || self.storage_degraded {
            self.sync(now)?;
        }
        Ok(self.admission())
    }

    #[must_use]
    pub fn admission(&self) -> JournalAdmission {
        JournalAdmission {
            journal_admitted: self.admitted_sequence,
            journal_synced: self.synced_sequence,
            storage_degraded: self.storage_degraded,
        }
    }

    #[must_use]
    pub fn pending_bytes(&self) -> usize {
        self.pending_bytes
    }

    #[must_use]
    pub fn last_sync_duration(&self) -> Option<Duration> {
        self.last_sync_duration
    }

    pub fn storage_mut(&mut self) -> &mut S {
        &mut self.storage
    }

    pub fn storage_len(&self) -> Result<u64, JournalError> {
        Ok(self.storage.current_len()?)
    }

    pub fn replace_with_compacted_storage(
        &mut self,
        storage: S,
        checkpoint_sequence: u64,
        now: Duration,
    ) -> Result<JournalAdmission, JournalError> {
        if checkpoint_sequence != self.admitted_sequence
            || self.synced_sequence != self.admitted_sequence
            || self.pending_bytes != 0
        {
            return Err(JournalError::CompactionUnsafe);
        }
        self.storage = storage;
        self.last_sync_at = now;
        self.storage_degraded = false;
        self.storage_failed = false;
        self.last_sync_duration = None;
        Ok(self.admission())
    }

    fn sync(&mut self, now: Duration) -> Result<(), JournalError> {
        if self.storage_failed {
            return Err(JournalError::StorageUnavailable);
        }
        let completion = match self.storage.sync_data_with_duration() {
            Ok(completion) => completion,
            Err(error) => {
                self.storage_degraded = true;
                self.last_sync_at = now;
                self.last_sync_duration = None;
                return Err(JournalError::Storage(error));
            }
        };
        self.synced_sequence = self.admitted_sequence;
        self.pending_bytes = 0;
        self.last_sync_at = now.saturating_add(completion);
        self.storage_degraded = completion >= STORAGE_DEGRADED_SYNC_DURATION;
        self.last_sync_duration = Some(completion);
        Ok(())
    }

    pub fn into_storage(self) -> S {
        self.storage
    }
}

pub fn recover_journal(mut source: impl Read) -> Result<JournalRecovery, JournalError> {
    recover_journal_after(&mut source, 0)
}

pub fn recover_journal_after(
    mut source: impl Read,
    checkpoint_sequence: u64,
) -> Result<JournalRecovery, JournalError> {
    recover_journal_with_limits(
        &mut source,
        checkpoint_sequence,
        MAX_JOURNAL_RECOVERY_BYTES,
        MAX_JOURNAL_RECOVERY_MUTATIONS,
    )
}

fn recover_journal_with_limits(
    mut source: impl Read,
    checkpoint_sequence: u64,
    max_bytes: usize,
    max_mutations: usize,
) -> Result<JournalRecovery, JournalError> {
    let mut mutations = Vec::new();
    let mut last_complete_sequence = checkpoint_sequence;
    let mut recovered_bytes = 0_usize;
    loop {
        let mut length_bytes = [0_u8; 4];
        match read_exact_or_tail(&mut source, &mut length_bytes)? {
            ReadFramePart::CleanEof => break,
            ReadFramePart::Truncated => {
                return Ok(JournalRecovery {
                    mutations,
                    last_complete_sequence,
                    truncated_tail: true,
                });
            }
            ReadFramePart::Complete => {}
        }
        let length = u32::from_be_bytes(length_bytes) as usize;
        if length == 0 || length > MAX_JOURNAL_RECORD_BYTES {
            return Err(JournalError::RecordTooLarge);
        }
        let frame_bytes = length.checked_add(8).ok_or(JournalError::RecoveryLimit)?;
        if recovered_bytes.saturating_add(frame_bytes) > max_bytes
            || mutations.len() >= max_mutations
        {
            return Err(JournalError::RecoveryLimit);
        }
        let mut payload = vec![0_u8; length];
        if read_exact_or_tail(&mut source, &mut payload)? != ReadFramePart::Complete {
            return Ok(JournalRecovery {
                mutations,
                last_complete_sequence,
                truncated_tail: true,
            });
        }
        let mut checksum = [0_u8; 4];
        if read_exact_or_tail(&mut source, &mut checksum)? != ReadFramePart::Complete {
            return Ok(JournalRecovery {
                mutations,
                last_complete_sequence,
                truncated_tail: true,
            });
        }
        if u32::from_be_bytes(checksum) != crc32fast::hash(&payload) {
            return Err(JournalError::CorruptRecord("checksum mismatch"));
        }
        let mutation = decode_mutation(&payload)?;
        if last_complete_sequence.checked_add(1) != Some(mutation.sequence()) {
            return Err(JournalError::SequenceGap {
                previous: last_complete_sequence,
                actual: mutation.sequence(),
            });
        }
        last_complete_sequence = mutation.sequence();
        mutations.push(mutation);
        recovered_bytes = recovered_bytes.saturating_add(frame_bytes);
    }
    Ok(JournalRecovery {
        mutations,
        last_complete_sequence,
        truncated_tail: false,
    })
}

fn encode_mutation(mutation: &TerminalMutation) -> Result<Vec<u8>, JournalError> {
    let mut payload = vec![JOURNAL_RECORD_VERSION];
    match mutation {
        TerminalMutation::Output { sequence, data } => {
            payload.reserve_exact(9_usize.saturating_add(data.len()));
            payload.push(1);
            payload.extend_from_slice(&sequence.to_be_bytes());
            payload.extend_from_slice(data);
        }
        TerminalMutation::Resize {
            sequence,
            cols,
            rows,
        } => {
            payload.reserve_exact(13);
            payload.push(2);
            payload.extend_from_slice(&sequence.to_be_bytes());
            payload.extend_from_slice(&cols.to_be_bytes());
            payload.extend_from_slice(&rows.to_be_bytes());
        }
        TerminalMutation::Exit {
            sequence,
            exit_code,
        } => {
            payload.reserve_exact(14);
            payload.push(3);
            payload.extend_from_slice(&sequence.to_be_bytes());
            match exit_code {
                Some(code) => {
                    payload.push(1);
                    payload.extend_from_slice(&code.to_be_bytes());
                }
                None => payload.push(0),
            }
        }
    }
    if payload.len() > MAX_JOURNAL_RECORD_BYTES {
        return Err(JournalError::RecordTooLarge);
    }
    Ok(payload)
}

fn decode_mutation(payload: &[u8]) -> Result<TerminalMutation, JournalError> {
    let (&version, payload) = payload
        .split_first()
        .ok_or(JournalError::CorruptRecord("empty payload"))?;
    if version != JOURNAL_RECORD_VERSION {
        return Err(JournalError::CorruptRecord(
            "unsupported journal record version",
        ));
    }
    let (&kind, body) = payload
        .split_first()
        .ok_or(JournalError::CorruptRecord("missing mutation kind"))?;
    let sequence = read_u64(body)?;
    let body = &body[8..];
    match kind {
        1 => Ok(TerminalMutation::Output {
            sequence,
            data: body.to_vec(),
        }),
        2 if body.len() == 4 => Ok(TerminalMutation::Resize {
            sequence,
            cols: u16::from_be_bytes([body[0], body[1]]),
            rows: u16::from_be_bytes([body[2], body[3]]),
        }),
        3 if body == [0] => Ok(TerminalMutation::Exit {
            sequence,
            exit_code: None,
        }),
        3 if body.len() == 5 && body[0] == 1 => Ok(TerminalMutation::Exit {
            sequence,
            exit_code: Some(i32::from_be_bytes([body[1], body[2], body[3], body[4]])),
        }),
        2 | 3 => Err(JournalError::CorruptRecord("invalid fixed-size payload")),
        _ => Err(JournalError::CorruptRecord("unknown mutation kind")),
    }
}

fn read_u64(bytes: &[u8]) -> Result<u64, JournalError> {
    let prefix: [u8; 8] = bytes
        .get(..8)
        .ok_or(JournalError::CorruptRecord("missing mutation sequence"))?
        .try_into()
        .expect("slice length was checked");
    Ok(u64::from_be_bytes(prefix))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadFramePart {
    CleanEof,
    Truncated,
    Complete,
}

fn read_exact_or_tail(
    source: &mut impl Read,
    mut buffer: &mut [u8],
) -> Result<ReadFramePart, JournalError> {
    let mut read_any = false;
    while !buffer.is_empty() {
        match source.read(buffer) {
            Ok(0) => {
                return Ok(if read_any {
                    ReadFramePart::Truncated
                } else {
                    ReadFramePart::CleanEof
                });
            }
            Ok(bytes) => {
                read_any = true;
                buffer = &mut buffer[bytes..];
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(JournalError::Storage(error)),
        }
    }
    Ok(ReadFramePart::Complete)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    struct TestStorage {
        bytes: Cursor<Vec<u8>>,
        sync_duration: Duration,
        fail_write_after: Option<usize>,
        fail_syncs: usize,
        fail_rollback: bool,
        sync_count: usize,
    }

    impl Write for TestStorage {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if let Some(remaining) = self.fail_write_after {
                if remaining == 0 {
                    self.fail_write_after = None;
                    return Err(io::Error::new(io::ErrorKind::StorageFull, "full"));
                }
                let accepted = remaining.min(buffer.len());
                self.fail_write_after = Some(remaining - accepted);
                return self.bytes.write(&buffer[..accepted]);
            }
            self.bytes.write(buffer)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.bytes.flush()
        }
    }

    impl JournalStorage for TestStorage {
        fn current_offset(&mut self) -> io::Result<u64> {
            Ok(self.bytes.position())
        }

        fn current_len(&self) -> io::Result<u64> {
            Ok(self.bytes.get_ref().len() as u64)
        }

        fn rollback_to(&mut self, offset: u64) -> io::Result<()> {
            if self.fail_rollback {
                return Err(io::Error::other("rollback failed"));
            }
            let offset = usize::try_from(offset)
                .map_err(|_| io::Error::other("rollback offset overflowed"))?;
            self.bytes.get_mut().truncate(offset);
            self.bytes.set_position(offset as u64);
            Ok(())
        }

        fn sync_data_with_duration(&mut self) -> io::Result<Duration> {
            self.sync_count += 1;
            if self.fail_syncs > 0 {
                self.fail_syncs -= 1;
                return Err(io::Error::other("sync failed"));
            }
            Ok(self.sync_duration)
        }
    }

    fn output(sequence: u64, bytes: usize) -> TerminalMutation {
        TerminalMutation::Output {
            sequence,
            data: vec![b'x'; bytes],
        }
    }

    fn storage() -> TestStorage {
        TestStorage {
            bytes: Cursor::new(Vec::new()),
            sync_duration: Duration::from_millis(1),
            fail_write_after: None,
            fail_syncs: 0,
            fail_rollback: false,
            sync_count: 0,
        }
    }

    #[test]
    fn admits_before_group_sync_and_syncs_by_fifty_milliseconds() {
        let mut journal = MutationJournal::new(storage(), Duration::ZERO);
        let admission = journal
            .append(&output(1, 16), Duration::from_millis(1))
            .unwrap();
        assert_eq!(admission.journal_admitted, 1);
        assert_eq!(admission.journal_synced, 0);
        let synced = journal.sync_if_due(Duration::from_millis(50)).unwrap();
        assert_eq!(synced.journal_synced, 1);
    }

    #[test]
    fn syncs_when_pending_records_cross_one_mebibyte() {
        let mut journal = MutationJournal::new(storage(), Duration::ZERO);
        let mut admission = journal.admission();
        for sequence in 1..=4 {
            admission = journal
                .append(
                    &output(sequence, JOURNAL_GROUP_SYNC_BYTES / 4),
                    Duration::ZERO,
                )
                .unwrap();
        }
        assert_eq!(admission.journal_synced, 4);
    }

    #[test]
    fn two_second_sync_enters_storage_degraded() {
        let mut delayed = storage();
        delayed.sync_duration = Duration::from_secs(2);
        let mut journal = MutationJournal::new(delayed, Duration::ZERO);
        journal.append(&output(1, 16), Duration::ZERO).unwrap();
        let admission = journal.force_sync(Duration::from_millis(1)).unwrap();
        assert!(admission.storage_degraded);
    }

    #[test]
    fn append_error_rolls_back_and_retries_without_advancing_admission() {
        let mut full = storage();
        full.fail_write_after = Some(6);
        let mut journal = MutationJournal::new(full, Duration::ZERO);
        assert!(journal.append(&output(1, 16), Duration::ZERO).is_err());
        assert_eq!(journal.admission().journal_admitted, 0);
        assert!(journal.storage_mut().bytes.get_ref().is_empty());

        let admission = journal
            .append(&output(1, 16), Duration::from_millis(1))
            .unwrap();
        assert_eq!(admission.journal_admitted, 1);
        let bytes = journal.into_storage().bytes.into_inner();
        assert_eq!(
            recover_journal(bytes.as_slice()).unwrap().mutations,
            [output(1, 16)]
        );
    }

    #[test]
    fn sync_error_is_retryable_and_never_advances_synced_sequence() {
        let mut failing = storage();
        failing.fail_syncs = 1;
        let mut journal = MutationJournal::new(failing, Duration::ZERO);
        journal.append(&output(1, 16), Duration::ZERO).unwrap();

        assert!(journal.force_sync(Duration::from_millis(1)).is_err());
        assert_eq!(journal.admission().journal_admitted, 1);
        assert_eq!(journal.admission().journal_synced, 0);
        assert!(journal.admission().storage_degraded);
        assert!(journal.pending_bytes() > 0);

        let recovered = journal.force_sync(Duration::from_millis(2)).unwrap();
        assert_eq!(recovered.journal_synced, 1);
        assert!(!recovered.storage_degraded);
        assert_eq!(journal.pending_bytes(), 0);
    }

    #[test]
    fn automatic_group_sync_failure_does_not_reject_an_admitted_record() {
        let mut failing = storage();
        failing.fail_syncs = 1;
        let mut journal = MutationJournal::new(failing, Duration::ZERO);

        let admission = journal
            .append(&output(1, JOURNAL_GROUP_SYNC_BYTES - 10), Duration::ZERO)
            .unwrap();
        assert_eq!(admission.journal_admitted, 1);
        assert_eq!(admission.journal_synced, 0);
        assert!(admission.storage_degraded);
        assert!(journal.pending_bytes() >= JOURNAL_GROUP_SYNC_BYTES);

        let recovered = journal.force_sync(Duration::from_millis(1)).unwrap();
        assert_eq!(recovered.journal_synced, 1);
        assert!(!recovered.storage_degraded);
    }

    #[test]
    fn failed_write_rollback_poisoning_fails_closed() {
        let mut broken = storage();
        broken.fail_write_after = Some(2);
        broken.fail_rollback = true;
        let mut journal = MutationJournal::new(broken, Duration::ZERO);

        assert!(matches!(
            journal.append(&output(1, 16), Duration::ZERO),
            Err(JournalError::StorageRollback { .. })
        ));
        assert_eq!(journal.admission().journal_admitted, 0);
        assert!(matches!(
            journal.append(&output(1, 16), Duration::ZERO),
            Err(JournalError::StorageUnavailable)
        ));
    }

    #[test]
    fn compaction_requires_a_checkpoint_through_every_synced_admission() {
        let mut journal = MutationJournal::new(storage(), Duration::ZERO);
        journal.append(&output(1, 16), Duration::ZERO).unwrap();
        assert!(matches!(
            journal.replace_with_compacted_storage(storage(), 1, Duration::from_millis(1)),
            Err(JournalError::CompactionUnsafe)
        ));

        journal.force_sync(Duration::from_millis(2)).unwrap();
        let admission = journal
            .replace_with_compacted_storage(storage(), 1, Duration::from_millis(3))
            .unwrap();
        assert_eq!(admission.journal_admitted, 1);
        assert_eq!(admission.journal_synced, 1);
        assert_eq!(journal.storage_len().unwrap(), 0);
        assert_eq!(
            journal
                .append(&output(2, 16), Duration::from_millis(4))
                .unwrap()
                .journal_admitted,
            2
        );
    }

    #[test]
    fn compacted_journal_continues_and_recovers_after_checkpoint_sequence() {
        let mut journal =
            MutationJournal::new_after_checkpoint(storage(), 40, Duration::from_millis(1));
        journal
            .append(&output(41, 8), Duration::from_millis(2))
            .unwrap();
        journal
            .append(&output(42, 8), Duration::from_millis(3))
            .unwrap();
        let bytes = journal.into_storage().bytes.into_inner();
        let recovered = recover_journal_after(bytes.as_slice(), 40).unwrap();
        assert_eq!(recovered.last_complete_sequence, 42);
        assert_eq!(recovered.mutations, [output(41, 8), output(42, 8)]);
        assert_eq!(
            recover_journal_after([].as_slice(), 40)
                .unwrap()
                .last_complete_sequence,
            40
        );
    }

    #[test]
    fn recovery_reports_only_the_incomplete_group_commit_tail() {
        let mutations = [
            output(1, 16),
            TerminalMutation::Resize {
                sequence: 2,
                cols: 100,
                rows: 30,
            },
        ];
        let mut journal = MutationJournal::new(storage(), Duration::ZERO);
        for mutation in &mutations {
            journal.append(mutation, Duration::ZERO).unwrap();
        }
        let bytes = journal.into_storage().bytes.into_inner();
        assert_eq!(
            recover_journal(bytes.as_slice()).unwrap().mutations,
            mutations
        );

        let truncated = recover_journal(&bytes[..bytes.len() - 2]).unwrap();
        assert_eq!(truncated.last_complete_sequence, 1);
        assert!(truncated.truncated_tail);
        assert_eq!(truncated.mutations, mutations[..1]);
    }

    #[test]
    fn recovery_rejects_checksum_corruption() {
        let mut journal = MutationJournal::new(storage(), Duration::ZERO);
        journal.append(&output(1, 16), Duration::ZERO).unwrap();
        let mut bytes = journal.into_storage().bytes.into_inner();
        bytes[12] ^= 0xff;
        assert!(matches!(
            recover_journal(bytes.as_slice()),
            Err(JournalError::CorruptRecord("checksum mismatch"))
        ));
    }

    #[test]
    fn recovery_rejects_an_unknown_record_version() {
        let mut payload = encode_mutation(&output(1, 16)).unwrap();
        payload[0] = JOURNAL_RECORD_VERSION + 1;
        assert!(matches!(
            decode_mutation(&payload),
            Err(JournalError::CorruptRecord(
                "unsupported journal record version"
            ))
        ));
    }

    #[test]
    fn recovery_fails_closed_at_its_mutation_bound() {
        let mut journal = MutationJournal::new(storage(), Duration::ZERO);
        journal.append(&output(1, 16), Duration::ZERO).unwrap();
        journal.append(&output(2, 16), Duration::ZERO).unwrap();
        let bytes = journal.into_storage().bytes.into_inner();
        assert!(matches!(
            recover_journal_with_limits(bytes.as_slice(), 0, bytes.len(), 1),
            Err(JournalError::RecoveryLimit)
        ));
    }
}
