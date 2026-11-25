use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read};
use std::path::Path;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

#[cfg(not(unix))]
use std::io::{Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};

/// 1 MiB sequential read buffer minimizes syscall overhead and maximizes
/// platter throughput on spinning HDDs.
pub const BUFFER_SIZE: usize = 1024 * 1024;
const KEEP_HEADER_CACHE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHashes {
    pub content_hash: Option<String>,
    pub audio_hash: Option<String>,
    pub audio_payload_size: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct AudioBounds {
    pub size: u64,
    pub start: u64,
    pub check_id3v1: bool,
}

pub enum StreamFrame {
    Chunk { buf: Vec<u8>, len: usize },
    Finish { valid_snapshot: bool },
}

/// Match file-fingerprints.js, including falling back to all remaining bytes
/// when an ID3/FLAC header is malformed. Failed or changing files have no hashes.
pub fn compute_file_hashes(path: &Path) -> FileHashes {
    let mut buffer = vec![0_u8; BUFFER_SIZE];
    compute(path, &mut buffer, || {}).unwrap_or_default()
}

/// Producer side (runs on the single HDD I/O thread): reads `path` sequentially
/// using recycled 1 MiB buffers from `buf_pool_rx` and streams chunks to a CPU hasher.
pub fn stream_file_for_hashing(
    path: &Path,
    buf_pool_rx: &Receiver<Vec<u8>>,
    buf_pool_tx: &SyncSender<Vec<u8>>,
    job_tx: &SyncSender<(AudioBounds, Receiver<StreamFrame>, SyncSender<FileHashes>)>,
    result_tx: SyncSender<FileHashes>,
) {
    let outcome = (|| -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
        let mut file = options.open(path)?;
        let before = file.metadata()?;
        let size = before.len();
        if !before.is_file() || size == 0 || size > crate::MAX_SAFE_INTEGER {
            let _ = result_tx.send(FileHashes::default());
            return Ok(());
        }

        #[cfg(target_os = "linux")]
        let _ = rustix::fs::fadvise(&file, 0, None, rustix::fs::Advice::Sequential);

        let mut first_buf = buf_pool_rx
            .recv()
            .unwrap_or_else(|_| vec![0_u8; BUFFER_SIZE]);
        let first_wanted = (size as usize).min(first_buf.len());
        let first_count = fill_chunk(&mut file, &mut first_buf[..first_wanted])?;
        if first_count == 0 {
            let _ = buf_pool_tx.send(first_buf);
            let _ = result_tx.send(FileHashes::default());
            return Ok(());
        }

        let bounds = match inspect_leading_headers(&mut file, &first_buf[..first_count], size) {
            Ok(b) => b,
            Err(_) => {
                let _ = buf_pool_tx.send(first_buf);
                let _ = result_tx.send(FileHashes::default());
                return Ok(());
            }
        };

        let (frame_tx, frame_rx) = sync_channel::<StreamFrame>(3);
        if job_tx.send((bounds, frame_rx, result_tx.clone())).is_err() {
            let _ = buf_pool_tx.send(first_buf);
            return Ok(());
        }

        let mut offset = first_count as u64;
        if frame_tx
            .send(StreamFrame::Chunk {
                buf: first_buf,
                len: first_count,
            })
            .is_err()
        {
            return Ok(());
        }

        let mut read_failed = false;
        while offset < size {
            let mut buf = buf_pool_rx
                .recv()
                .unwrap_or_else(|_| vec![0_u8; BUFFER_SIZE]);
            let wanted = (size - offset).min(buf.len() as u64) as usize;
            match file.read(&mut buf[..wanted]) {
                Ok(0) | Err(_) => {
                    let _ = buf_pool_tx.send(buf);
                    read_failed = true;
                    break;
                }
                Ok(n) => {
                    offset += n as u64;
                    if frame_tx.send(StreamFrame::Chunk { buf, len: n }).is_err() {
                        return Ok(());
                    }
                }
            }
        }

        #[cfg(target_os = "linux")]
        if size > KEEP_HEADER_CACHE_BYTES {
            let drop_len = std::num::NonZeroU64::new(size - KEEP_HEADER_CACHE_BYTES);
            let _ = rustix::fs::fadvise(
                &file,
                KEEP_HEADER_CACHE_BYTES,
                drop_len,
                rustix::fs::Advice::DontNeed,
            );
        }

        let valid_snapshot = !read_failed
            && file
                .metadata()
                .ok()
                .zip(fs::metadata(path).ok())
                .is_some_and(|(after, current)| {
                    same_snapshot(&before, &after) && same_snapshot(&before, &current)
                });
        let _ = frame_tx.send(StreamFrame::Finish { valid_snapshot });
        Ok(())
    })();

    if outcome.is_err() {
        let _ = result_tx.send(FileHashes::default());
    }
}

/// Consumer side (runs on CPU worker pool): digests streamed chunks and returns
/// recycled buffers to `buf_pool_tx`.
pub fn hash_streamed_frames(
    bounds: AudioBounds,
    frame_rx: Receiver<StreamFrame>,
    buf_pool_tx: &SyncSender<Vec<u8>>,
) -> FileHashes {
    let mut state = DigestState::new(bounds);
    let mut valid = false;
    while let Ok(frame) = frame_rx.recv() {
        match frame {
            StreamFrame::Chunk { buf, len } => {
                state.update(&buf[..len]);
                let _ = buf_pool_tx.send(buf);
            }
            StreamFrame::Finish { valid_snapshot } => {
                valid = valid_snapshot && state.offset == bounds.size;
                break;
            }
        }
    }
    if valid {
        state.finalize()
    } else {
        FileHashes::default()
    }
}

struct DigestState {
    bounds: AudioBounds,
    tail_start: u64,
    content: Sha256,
    audio: Option<Sha256>,
    tail: [u8; 128],
    offset: u64,
}

impl DigestState {
    fn new(bounds: AudioBounds) -> Self {
        let tail_start = if bounds.check_id3v1 {
            bounds.size - 128
        } else {
            bounds.size
        };
        Self {
            bounds,
            tail_start,
            content: Sha256::new(),
            audio: (bounds.start > 0).then(Sha256::new),
            tail: [0_u8; 128],
            offset: 0,
        }
    }

    fn update(&mut self, chunk: &[u8]) {
        let chunk_end = self.offset + chunk.len() as u64;
        if self.bounds.start == 0 {
            if self.offset < self.tail_start && chunk_end > self.tail_start {
                let split = (self.tail_start - self.offset) as usize;
                self.content.update(&chunk[..split]);
                self.audio = Some(self.content.clone());
                self.content.update(&chunk[split..]);
            } else {
                self.content.update(chunk);
                if self.offset == self.tail_start && self.audio.is_none() && self.bounds.check_id3v1
                {
                    self.audio = Some(self.content.clone());
                }
            }
        } else {
            self.content.update(chunk);
            let from = self.bounds.start.max(self.offset);
            let to = self.tail_start.min(chunk_end);
            if to > from
                && let Some(audio_hasher) = self.audio.as_mut()
            {
                audio_hasher
                    .update(&chunk[(from - self.offset) as usize..(to - self.offset) as usize]);
            }
        }

        if self.bounds.check_id3v1 && chunk_end > self.tail_start {
            let t_from = self.tail_start.max(self.offset);
            let t_to = self.bounds.size.min(chunk_end);
            if t_to > t_from {
                let dst_start = (t_from - self.tail_start) as usize;
                let dst_end = (t_to - self.tail_start) as usize;
                let src_start = (t_from - self.offset) as usize;
                let src_end = (t_to - self.offset) as usize;
                self.tail[dst_start..dst_end].copy_from_slice(&chunk[src_start..src_end]);
            }
        }
        self.offset = chunk_end;
    }

    fn finalize(self) -> FileHashes {
        let stripped_id3v1 = self.bounds.check_id3v1 && ascii_equals(&self.tail[..3], b"TAG");
        let end = if stripped_id3v1 {
            self.bounds.size - 128
        } else {
            self.bounds.size
        };
        let audio_payload_size = end.saturating_sub(self.bounds.start);
        let content_hash = format!("{:x}", self.content.finalize());
        let audio_hash =
            if audio_payload_size == 0 || (self.bounds.start == 0 && end == self.bounds.size) {
                content_hash.clone()
            } else {
                let mut audio_hasher = self.audio.unwrap_or_default();
                if self.bounds.check_id3v1 && !stripped_id3v1 {
                    audio_hasher.update(self.tail);
                }
                format!("{:x}", audio_hasher.finalize())
            };
        FileHashes {
            content_hash: Some(content_hash),
            audio_hash: Some(audio_hash),
            audio_payload_size,
        }
    }
}

fn read_exact_at<const N: usize>(
    file: &mut File,
    first_chunk: &[u8],
    offset: u64,
) -> io::Result<[u8; N]> {
    let mut out = [0_u8; N];
    let end = offset.saturating_add(N as u64);
    if end <= first_chunk.len() as u64 {
        let start = offset as usize;
        out.copy_from_slice(&first_chunk[start..start + N]);
        return Ok(out);
    }
    #[cfg(unix)]
    {
        file.read_exact_at(&mut out, offset)?;
        Ok(out)
    }
    #[cfg(not(unix))]
    {
        let saved = file.stream_position()?;
        file.seek(SeekFrom::Start(offset))?;
        let res = file.read_exact(&mut out);
        let _ = file.seek(SeekFrom::Start(saved));
        res?;
        Ok(out)
    }
}

fn fill_chunk(file: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    let mut total = 0;
    while total < buf.len() {
        match file.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(total)
}

fn inspect_leading_headers(
    file: &mut File,
    first_chunk: &[u8],
    size: u64,
) -> io::Result<AudioBounds> {
    let mut start = 0_u64;
    let end = size;
    let mut has_id3 = false;

    for _ in 0..32 {
        if start + 10 > end {
            break;
        }
        let header = read_exact_at::<10>(file, first_chunk, start)?;
        if !ascii_equals(&header[..3], b"ID3")
            || !(2..=4).contains(&header[3])
            || header[6..10].iter().any(|&value| value >= 128)
        {
            break;
        }
        let length = (u64::from(header[6]) << 21)
            | (u64::from(header[7]) << 14)
            | (u64::from(header[8]) << 7)
            | u64::from(header[9]);
        let footer = u64::from(header[3] == 4 && header[5] & 16 != 0) * 10;
        let next = start + 10 + length + footer;
        if next > end || next <= start {
            break;
        }
        start = next;
        has_id3 = true;
    }

    let mut flac = false;
    if start + 8 <= end && ascii_equals(&read_exact_at::<4>(file, first_chunk, start)?, b"fLaC") {
        let original_start = start;
        let mut cursor = start + 4;
        for block in 0..1024 {
            if cursor + 4 > end {
                break;
            }
            let header = read_exact_at::<4>(file, first_chunk, cursor)?;
            let block_type = header[0] & 127;
            let length =
                (u64::from(header[1]) << 16) | (u64::from(header[2]) << 8) | u64::from(header[3]);
            if block_type == 127
                || (block == 0 && (block_type != 0 || length != 34))
                || cursor + 4 + length > end
            {
                break;
            }
            cursor += 4 + length;
            if header[0] & 128 != 0 {
                start = cursor;
                flac = true;
                break;
            }
        }
        if !flac {
            start = original_start;
        }
    }

    let mut check_id3v1 = false;
    if !flac && end - start >= 128 {
        let head = read_exact_at::<2>(file, first_chunk, start)?;
        let mp3 = head[0] == 255 && head[1] & 224 == 224 && head[1] & 6 != 0;
        check_id3v1 = has_id3 || mp3;
    }

    Ok(AudioBounds {
        size,
        start,
        check_id3v1,
    })
}

fn compute(path: &Path, buffer: &mut [u8], after_read: impl FnOnce()) -> io::Result<FileHashes> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    let mut file = options.open(path)?;
    let before = file.metadata()?;
    let size = before.len();
    if !before.is_file() || size == 0 || size > crate::MAX_SAFE_INTEGER {
        return Ok(FileHashes::default());
    }

    #[cfg(target_os = "linux")]
    let _ = rustix::fs::fadvise(&file, 0, None, rustix::fs::Advice::Sequential);

    let first_wanted = (size as usize).min(buffer.len());
    let first_count = fill_chunk(&mut file, &mut buffer[..first_wanted])?;
    if first_count == 0 {
        return Err(changed());
    }

    let bounds = inspect_leading_headers(&mut file, &buffer[..first_count], size)?;
    let mut state = DigestState::new(bounds);
    state.update(&buffer[..first_count]);

    while state.offset < size {
        let wanted = (size - state.offset).min(buffer.len() as u64) as usize;
        let count = file.read(&mut buffer[..wanted])?;
        if count == 0 {
            return Err(changed());
        }
        state.update(&buffer[..count]);
    }

    #[cfg(target_os = "linux")]
    if size > KEEP_HEADER_CACHE_BYTES {
        let drop_len = std::num::NonZeroU64::new(size - KEEP_HEADER_CACHE_BYTES);
        let _ = rustix::fs::fadvise(
            &file,
            KEEP_HEADER_CACHE_BYTES,
            drop_len,
            rustix::fs::Advice::DontNeed,
        );
    }

    after_read();
    let after = file.metadata()?;
    let current = fs::metadata(path)?;
    if !same_snapshot(&before, &after) || !same_snapshot(&before, &current) {
        return Ok(FileHashes::default());
    }

    Ok(state.finalize())
}

// Buffer.toString('ascii') masks the high bit rather than decoding UTF-8.
fn ascii_equals(actual: &[u8], expected: &[u8]) -> bool {
    actual.len() == expected.len() && actual.iter().zip(expected).all(|(a, b)| a & 127 == *b)
}

fn changed() -> io::Error {
    io::Error::other("File changed while fingerprinting")
}

/// Compare nanoseconds and identity rather than rounded JavaScript dates.
pub(crate) fn same_snapshot(a: &Metadata, b: &Metadata) -> bool {
    if a.len() != b.len() || a.file_type() != b.file_type() {
        return false;
    }
    #[cfg(unix)]
    {
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        a.modified().ok() == b.modified().ok() && a.created().ok() == b.created().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn hashes(bytes: &[u8]) -> FileHashes {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(bytes).unwrap();
        compute_file_hashes(file.path())
    }

    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn id3(version: u8, flags: u8, bytes: &[u8]) -> Vec<u8> {
        let len = bytes.len();
        let mut result = vec![b'I', b'D', b'3', version, 0, flags];
        result.extend((0..4).rev().map(|i| ((len >> (i * 7)) & 127) as u8));
        result.extend(bytes);
        if version == 4 && flags & 16 != 0 {
            result.extend([0; 10]);
        }
        result
    }

    #[test]
    fn whole_file_crosses_buffer_boundary_and_hashes_last_byte() {
        let mut bytes = vec![42; BUFFER_SIZE * 2 + 13];
        let before = hashes(&bytes);
        assert_eq!(
            before.content_hash.as_deref(),
            Some(digest(&bytes).as_str())
        );
        assert_eq!(before.content_hash, before.audio_hash);
        assert_eq!(before.audio_payload_size, bytes.len() as u64);
        *bytes.last_mut().unwrap() = 43;
        assert_ne!(hashes(&bytes).content_hash, before.content_hash);
    }

    #[test]
    fn stacked_id3_footer_and_v1_are_removed() {
        let audio = vec![63; 200];
        let mut bytes = id3(2, 0, b"one");
        bytes.extend(id3(4, 16, b"two"));
        bytes.extend(&audio);
        bytes.extend(b"TAG");
        bytes.extend([0; 125]);
        let result = hashes(&bytes);
        assert_eq!(result.content_hash, Some(digest(&bytes)));
        assert_eq!(result.audio_hash, Some(digest(&audio)));
        assert_eq!(result.audio_payload_size, 200);
    }

    #[test]
    fn id3_limit_and_zero_audio_match_javascript() {
        let mut bytes = Vec::new();
        for _ in 0..33 {
            bytes.extend(id3(3, 0, b""));
        }
        assert_eq!(hashes(&bytes).audio_payload_size, 10);
        let only_tag = hashes(&id3(3, 0, b"metadata"));
        assert_eq!(only_tag.audio_payload_size, 0);
        assert_eq!(only_tag.content_hash, only_tag.audio_hash);
    }

    #[test]
    fn invalid_id3_sizes_versions_and_footer_leave_prefix_in_audio() {
        for mut bytes in [id3(3, 0, b"test"), id3(1, 0, b"test"), id3(4, 16, b"test")] {
            bytes[6] = 128;
            assert_eq!(hashes(&bytes).audio_hash, Some(digest(&bytes)));
        }
        let invalid_version = id3(5, 0, b"test");
        assert_eq!(
            hashes(&invalid_version).audio_payload_size,
            invalid_version.len() as u64
        );
        let truncated_footer = &id3(4, 16, b"test")[..14];
        assert_eq!(
            hashes(truncated_footer).audio_hash,
            Some(digest(truncated_footer))
        );
    }

    #[test]
    fn ascii_high_bits_match_node_buffer_ascii() {
        let mut bytes = id3(3, 0, b"metadata");
        for byte in &mut bytes[..3] {
            *byte |= 128;
        }
        bytes.extend(b"payload");
        assert_eq!(hashes(&bytes).audio_hash, Some(digest(b"payload")));
    }

    #[test]
    fn id3v1_needs_mp3_frame_or_id3v2_and_valid_frame_layer() {
        for (head, stripped) in [([255, 251], true), ([255, 249], false), ([1, 2], false)] {
            let mut bytes = head.to_vec();
            bytes.extend([1; 140]);
            bytes.extend(b"TAG");
            bytes.extend([0; 125]);
            assert_eq!(
                hashes(&bytes).audio_payload_size,
                bytes.len() as u64 - if stripped { 128 } else { 0 }
            );
        }
    }

    #[test]
    fn flac_strips_only_valid_metadata_chain_and_preserves_trailing_tag() {
        let mut bytes = b"fLaC".to_vec();
        bytes.extend([0, 0, 0, 34]);
        bytes.extend([0; 34]);
        bytes.extend([132, 0, 0, 3]);
        bytes.extend(b"tag");
        let mut audio = vec![255, 248];
        audio.extend([1; 140]);
        audio.extend(b"TAG");
        audio.extend([0; 125]);
        bytes.extend(&audio);
        assert_eq!(hashes(&bytes).audio_hash, Some(digest(&audio)));
        for change in [0_usize, 4, 7, 42] {
            let mut invalid = bytes.clone();
            invalid[change] = 127;
            assert_eq!(hashes(&invalid).audio_hash, Some(digest(&invalid)));
        }
    }

    #[test]
    fn flac_requires_streaminfo_and_last_marker_with_at_most_1024_blocks() {
        let mut prefix = b"fLaC".to_vec();
        prefix.extend([0, 0, 0, 34]);
        prefix.extend([0; 34]);
        for blocks in [1024, 1025] {
            let mut bytes = prefix.clone();
            for _ in 1..blocks - 1 {
                bytes.extend([1, 0, 0, 0]);
            }
            bytes.extend([129, 0, 0, 0]);
            bytes.extend(b"frames");
            let expected = if blocks == 1024 {
                b"frames".as_slice()
            } else {
                &bytes
            };
            assert_eq!(hashes(&bytes).audio_hash, Some(digest(expected)));
        }
        for bytes in [
            b"fLaC\x80\0\0\x22short".to_vec(),
            b"fLaC\x84\0\0\0frames".to_vec(),
            prefix,
        ] {
            assert_eq!(hashes(&bytes).audio_hash, Some(digest(&bytes)));
        }
    }

    #[test]
    fn audio_slice_is_correct_when_metadata_ends_across_read_boundary() {
        let audio = vec![67; BUFFER_SIZE + 17];
        let mut bytes = id3(3, 0, &vec![9; BUFFER_SIZE - 15]);
        bytes.extend(&audio);
        assert_eq!(hashes(&bytes).audio_hash, Some(digest(&audio)));
        assert_eq!(hashes(&bytes).audio_payload_size, audio.len() as u64);
    }

    #[test]
    fn absent_empty_and_directory_have_no_hashes() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(compute_file_hashes(directory.path()), FileHashes::default());
        assert_eq!(
            compute_file_hashes(&directory.path().join("missing")),
            FileHashes::default()
        );
        assert_eq!(hashes(b""), FileHashes::default());
    }

    #[test]
    fn mutation_truncation_replacement_and_removal_discard_all_hashes() {
        let mut buf = vec![0_u8; BUFFER_SIZE];
        for action in 0..4 {
            let mut file = NamedTempFile::new().unwrap();
            file.write_all(b"same-size-original").unwrap();
            let result = compute(file.path(), &mut buf, || match action {
                0 => fs::write(file.path(), b"same-size-replaced").unwrap(),
                1 => fs::write(file.path(), b"short").unwrap(),
                2 => {
                    let mut replacement =
                        NamedTempFile::new_in(file.path().parent().unwrap()).unwrap();
                    replacement.write_all(b"same-size-original").unwrap();
                    replacement.persist(file.path()).unwrap();
                }
                _ => fs::remove_file(file.path()).unwrap(),
            })
            .unwrap_or_default();
            assert_eq!(result, FileHashes::default());
        }
    }

    #[cfg(unix)]
    #[test]
    fn named_pipe_is_rejected_without_blocking() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pipe.mp3");
        rustix::fs::mknodat(
            rustix::fs::CWD,
            &path,
            rustix::fs::FileType::Fifo,
            rustix::fs::Mode::RWXU,
            0,
        )
        .unwrap();
        assert_eq!(compute_file_hashes(&path), FileHashes::default());
    }
}
