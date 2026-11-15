use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

const BUFFER_SIZE: usize = 256 * 1024;

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHashes {
    pub content_hash: Option<String>,
    pub audio_hash: Option<String>,
    pub audio_payload_size: u64,
}

/// Match file-fingerprints.js, including falling back to all remaining bytes
/// when an ID3/FLAC header is malformed. Failed or changing files have no hashes.
pub fn compute_file_hashes(path: &Path) -> FileHashes {
    compute(path, || {}).unwrap_or_default()
}

fn compute(path: &Path, after_read: impl FnOnce()) -> io::Result<FileHashes> {
    let mut options = OpenOptions::new();
    options.read(true);
    // A malicious or accidentally named FIFO/device must not stall a worker.
    #[cfg(unix)]
    options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    let mut file = options.open(path)?;
    let before = file.metadata()?;
    let size = before.len();
    if !before.is_file() || size == 0 || size > crate::MAX_SAFE_INTEGER {
        return Ok(FileHashes::default());
    }
    let (start, end) = audio_range(&mut file, size)?;
    let audio_payload_size = end.saturating_sub(start);
    let separate_audio_hash = audio_payload_size > 0 && (start != 0 || end != size);
    file.seek(SeekFrom::Start(0))?;
    let mut content = Sha256::new();
    let mut audio = Sha256::new();
    let mut buffer = vec![0_u8; BUFFER_SIZE];
    let mut offset = 0;
    while offset < size {
        let wanted = (size - offset).min(BUFFER_SIZE as u64) as usize;
        let count = file.read(&mut buffer[..wanted])?;
        if count == 0 {
            return Err(changed());
        }
        content.update(&buffer[..count]);
        let from = start.max(offset);
        let to = end.min(offset + count as u64);
        if separate_audio_hash && to > from {
            audio.update(&buffer[(from - offset) as usize..(to - offset) as usize]);
        }
        offset += count as u64;
    }
    after_read();
    let after = file.metadata()?;
    let current = fs::metadata(path)?;
    if !same_snapshot(&before, &after) || !same_snapshot(&before, &current) {
        return Ok(FileHashes::default());
    }
    let content_hash = format!("{:x}", content.finalize());
    let audio_hash = if !separate_audio_hash {
        content_hash.clone()
    } else {
        format!("{:x}", audio.finalize())
    };
    Ok(FileHashes {
        content_hash: Some(content_hash),
        audio_hash: Some(audio_hash),
        audio_payload_size,
    })
}

fn audio_range(file: &mut File, size: u64) -> io::Result<(u64, u64)> {
    let mut start = 0;
    let mut end = size;
    let mut has_id3 = false;
    for _ in 0..32 {
        if start + 10 > end {
            break;
        }
        let header = read_at::<10>(file, start)?;
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
    if start + 8 <= end && ascii_equals(&read_at::<4>(file, start)?, b"fLaC") {
        let original_start = start;
        let mut cursor = start + 4;
        for block in 0..1024 {
            if cursor + 4 > end {
                break;
            }
            let header = read_at::<4>(file, cursor)?;
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
    if !flac && end - start >= 128 {
        let head = read_at::<2>(file, start)?;
        let mp3 = head[0] == 255 && head[1] & 224 == 224 && head[1] & 6 != 0;
        if (has_id3 || mp3) && ascii_equals(&read_at::<3>(file, end - 128)?, b"TAG") {
            end -= 128;
        }
    }
    Ok((start, end))
}

// Buffer.toString('ascii') masks the high bit rather than decoding UTF-8.
fn ascii_equals(actual: &[u8], expected: &[u8]) -> bool {
    actual.len() == expected.len() && actual.iter().zip(expected).all(|(a, b)| a & 127 == *b)
}

fn read_at<const N: usize>(file: &mut File, offset: u64) -> io::Result<[u8; N]> {
    let mut buffer = [0; N];
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(&mut buffer)?;
    Ok(buffer)
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
        for action in 0..4 {
            let mut file = NamedTempFile::new().unwrap();
            file.write_all(b"same-size-original").unwrap();
            let result = compute(file.path(), || match action {
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
