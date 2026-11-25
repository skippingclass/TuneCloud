use crate::fingerprints::same_snapshot;
use serde::Serialize;
use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "linux"))]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

const MAX_DATE_MS: f64 = 8_640_000_000_000_000.0;

#[derive(Debug, Serialize)]
pub struct AudioFiles {
    pub files: Vec<AudioFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFile {
    pub path: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub dev: Option<String>,
    pub ino: Option<String>,
    pub nlink: u64,
    pub birthtime_ms: Option<String>,
}

pub fn list_audio_files(root: &Path) -> io::Result<AudioFiles> {
    if !root.is_absolute() {
        return Err(io::Error::other("Music directory must be absolute"));
    }
    let physical_root = fs::canonicalize(root)?;
    let mut files = walk(root, &physical_root)?;
    // Deterministic ordering makes parity checks independent of inode/readdir order.
    files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(AudioFiles { files })
}

fn has_audio_extension_bytes(name: &[u8]) -> bool {
    let Some(dot) = name.iter().rposition(|&b| b == b'.') else {
        return false;
    };
    let ext = &name[dot + 1..];
    matches!(ext.len(), 3 | 4)
        && [
            b"mp3".as_slice(),
            b"flac".as_slice(),
            b"ogg".as_slice(),
            b"wav".as_slice(),
            b"m4a".as_slice(),
            b"aac".as_slice(),
            b"wma".as_slice(),
            b"opus".as_slice(),
        ]
        .iter()
        .any(|allowed| ext.eq_ignore_ascii_case(allowed))
}

#[cfg(not(unix))]
fn is_audio_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| has_audio_extension_bytes(n.as_bytes()))
}

fn format_birthtime(millis: Option<f64>) -> Option<String> {
    millis.and_then(|ms| {
        (ms.is_finite() && ms > 0.0 && ms <= MAX_DATE_MS)
            .then(|| format!("{:.0}", node_round_millis(ms)))
    })
}

fn validate_file_fields(size: u64, nlink: u64, mtime_ms: f64) -> io::Result<()> {
    if size > crate::MAX_SAFE_INTEGER {
        return Err(io::Error::other("Music file is too large"));
    }
    if nlink > crate::MAX_SAFE_INTEGER || !mtime_ms.is_finite() || mtime_ms.abs() > MAX_DATE_MS {
        return Err(io::Error::other("Music file metadata is not representable"));
    }
    Ok(())
}

/// Slow-path resolver used only for symlinks (or non-Linux platforms), preserving
/// confinement checks against `physical_root`.
fn audio_file_slow(path: &Path, physical_root: &Path) -> io::Result<Option<(AudioFile, Metadata)>> {
    let physical = fs::canonicalize(path)?;
    if !physical.starts_with(physical_root) {
        return Ok(None);
    }
    let metadata = fs::metadata(&physical)?;
    if !metadata.is_file() {
        return Ok(None);
    }
    let path_str = path
        .to_str()
        .ok_or_else(|| io::Error::other("Music path is not valid UTF-8"))?
        .to_owned();
    let size = metadata.len();
    #[cfg(unix)]
    let (dev, ino, nlink, mtime_ms) = (
        Some(metadata.dev().to_string()),
        Some(metadata.ino().to_string()),
        metadata.nlink(),
        node_date_millis(metadata.mtime(), metadata.mtime_nsec()),
    );
    #[cfg(not(unix))]
    let (dev, ino, nlink, mtime_ms) = (
        None,
        None,
        1,
        node_round_millis(signed_millis(metadata.modified()?)),
    );
    validate_file_fields(size, nlink, mtime_ms)?;
    let birthtime_ms = format_birthtime(birthtime_millis(&physical, &metadata)?);
    Ok(Some((
        AudioFile {
            path: path_str,
            size,
            mtime_ms,
            dev,
            ino,
            nlink,
            birthtime_ms,
        },
        metadata,
    )))
}

#[cfg(target_os = "linux")]
fn regular_audio_file_statx(
    dirfd: &std::fs::File,
    name: &std::ffi::CStr,
    lexical: &Path,
) -> io::Result<Option<AudioFile>> {
    use rustix::fs::{AtFlags, FileType, StatxFlags, makedev, statat, statx};
    use rustix::io::Errno;

    let path_str = lexical
        .to_str()
        .ok_or_else(|| io::Error::other("Music path is not valid UTF-8"))?
        .to_owned();

    match statx(
        dirfd,
        name,
        AtFlags::SYMLINK_NOFOLLOW,
        StatxFlags::BASIC_STATS | StatxFlags::BTIME,
    ) {
        Ok(raw) => {
            let kind = FileType::from_raw_mode(raw.stx_mode.into());
            if kind != FileType::RegularFile {
                return Ok(None);
            }
            let size = raw.stx_size;
            let nlink = u64::from(raw.stx_nlink);
            let mtime_ms = node_date_millis(raw.stx_mtime.tv_sec, i64::from(raw.stx_mtime.tv_nsec));
            validate_file_fields(size, nlink, mtime_ms)?;
            let dev = makedev(raw.stx_dev_major, raw.stx_dev_minor);
            let btime = (raw.stx_mask & StatxFlags::BTIME.bits() != 0).then(|| {
                raw.stx_btime.tv_sec as f64 * 1000.0 + f64::from(raw.stx_btime.tv_nsec) / 1e6
            });
            Ok(Some(AudioFile {
                path: path_str,
                size,
                mtime_ms,
                dev: Some(dev.to_string()),
                ino: Some(raw.stx_ino.to_string()),
                nlink,
                birthtime_ms: format_birthtime(btime),
            }))
        }
        Err(Errno::NOSYS | Errno::INVAL | Errno::PERM | Errno::OPNOTSUPP) => {
            let raw = statat(dirfd, name, AtFlags::SYMLINK_NOFOLLOW)?;
            if FileType::from_raw_mode(raw.st_mode) != FileType::RegularFile {
                return Ok(None);
            }
            let size = raw.st_size as u64;
            let nlink = raw.st_nlink as u64;
            let mtime_ms = node_date_millis(raw.st_mtime as i64, raw.st_mtime_nsec as i64);
            validate_file_fields(size, nlink, mtime_ms)?;
            let ctime_btime = Some(raw.st_ctime as f64 * 1000.0 + raw.st_ctime_nsec as f64 / 1e6);
            Ok(Some(AudioFile {
                path: path_str,
                size,
                mtime_ms,
                dev: Some((raw.st_dev as u64).to_string()),
                ino: Some((raw.st_ino as u64).to_string()),
                nlink,
                birthtime_ms: format_birthtime(ctime_btime),
            }))
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(not(target_os = "linux"))]
fn signed_millis(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => {
            duration.as_secs() as f64 * 1000.0 + f64::from(duration.subsec_nanos()) / 1e6
        }
        Err(error) => {
            let duration = error.duration();
            -(duration.as_secs() as f64 * 1000.0 + f64::from(duration.subsec_nanos()) / 1e6)
        }
    }
}

#[cfg(target_os = "linux")]
fn birthtime_millis(path: &Path, metadata: &Metadata) -> io::Result<Option<f64>> {
    use rustix::fs::{AtFlags, CWD, StatxFlags, statx};
    use rustix::io::Errno;

    match statx(
        CWD,
        path,
        AtFlags::empty(),
        StatxFlags::BASIC_STATS | StatxFlags::BTIME,
    ) {
        Ok(raw) => birthtime_from_statx(&raw, metadata),
        Err(Errno::NOSYS | Errno::INVAL | Errno::PERM | Errno::OPNOTSUPP) => Ok(Some(
            metadata.ctime() as f64 * 1000.0 + metadata.ctime_nsec() as f64 / 1e6,
        )),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "linux")]
fn birthtime_from_statx(raw: &rustix::fs::Statx, metadata: &Metadata) -> io::Result<Option<f64>> {
    use rustix::fs::{StatxFlags, major, minor};

    if raw.stx_dev_major != major(metadata.dev())
        || raw.stx_dev_minor != minor(metadata.dev())
        || raw.stx_ino != metadata.ino()
        || raw.stx_size != metadata.len()
        || raw.stx_mtime.tv_sec != metadata.mtime()
        || i64::from(raw.stx_mtime.tv_nsec) != metadata.mtime_nsec()
        || raw.stx_ctime.tv_sec != metadata.ctime()
        || i64::from(raw.stx_ctime.tv_nsec) != metadata.ctime_nsec()
    {
        return Err(io::Error::other("Music file changed during listing"));
    }
    Ok((raw.stx_mask & StatxFlags::BTIME.bits() != 0)
        .then(|| raw.stx_btime.tv_sec as f64 * 1000.0 + f64::from(raw.stx_btime.tv_nsec) / 1e6))
}

#[cfg(not(target_os = "linux"))]
fn birthtime_millis(_path: &Path, metadata: &Metadata) -> io::Result<Option<f64>> {
    Ok(metadata.created().ok().map(signed_millis))
}

#[cfg(unix)]
fn node_date_millis(seconds: i64, nanoseconds: i64) -> f64 {
    node_round_millis(seconds as f64 * 1000.0 + nanoseconds as f64 / 1e6)
}

fn node_round_millis(millis: f64) -> f64 {
    let floor = millis.floor();
    if millis - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

#[cfg(not(unix))]
fn verify_directory(path: &Path, physical_root: &Path, before: &Metadata) -> io::Result<()> {
    let physical = fs::canonicalize(path)?;
    let current = fs::metadata(path)?;
    if !physical.starts_with(physical_root) || !same_snapshot(before, &current) {
        return Err(io::Error::other("Music directory changed during listing"));
    }
    Ok(())
}

#[cfg(unix)]
fn walk(root: &Path, physical_root: &Path) -> io::Result<Vec<AudioFile>> {
    use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, Stat, open, openat, statat};
    use std::collections::HashSet;
    use std::ffi::{CString, OsStr};
    use std::fs::File;
    use std::os::unix::ffi::OsStrExt;

    struct PendingEntry {
        ino: u64,
        kind: FileType,
        name: CString,
    }

    struct Frame {
        file: File,
        entries: std::vec::IntoIter<PendingEntry>,
        lexical: PathBuf,
        before: Metadata,
    }

    fn frame(file: File, lexical: PathBuf) -> io::Result<Frame> {
        let before = file.metadata()?;
        let dir = Dir::read_from(&file)?;
        let mut pending = Vec::new();
        for entry in dir {
            let entry = entry?;
            let bytes = entry.file_name().to_bytes();
            if bytes.first() == Some(&b'.') {
                continue;
            }
            let kind = entry.file_type();
            // Zero-syscall pre-filter using getdents64 d_type: skip non-audio regular
            // files (.jpg, .lrc, .cue, .log) and special files (FIFO/socket/device)
            // without touching their inodes on HDD.
            match kind {
                FileType::RegularFile | FileType::Symlink => {
                    if !has_audio_extension_bytes(bytes) {
                        continue;
                    }
                }
                FileType::Directory | FileType::Unknown => {}
                _ => continue,
            }
            pending.push(PendingEntry {
                ino: entry.ino(),
                kind,
                name: entry.file_name().to_owned(),
            });
        }
        // Sort entries by inode number so subsequent statx/openat calls traverse
        // the filesystem's inode table monotonically on spinning HDDs.
        pending.sort_unstable_by_key(|e| e.ino);
        Ok(Frame {
            file,
            entries: pending.into_iter(),
            lexical,
            before,
        })
    }

    fn raw_matches(raw: &Stat, metadata: &Metadata) -> bool {
        i128::from(raw.st_dev) == i128::from(metadata.dev())
            && i128::from(raw.st_ino) == i128::from(metadata.ino())
            && i128::from(raw.st_size) == i128::from(metadata.len())
            && i128::from(raw.st_mtime) == i128::from(metadata.mtime())
            && i128::from(raw.st_mtime_nsec) == i128::from(metadata.mtime_nsec())
            && i128::from(raw.st_ctime) == i128::from(metadata.ctime())
            && i128::from(raw.st_ctime_nsec) == i128::from(metadata.ctime_nsec())
    }

    let directory_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let file = File::from(open(physical_root, directory_flags, Mode::empty())?);
    let root_frame = frame(file, root.to_owned())?;
    if fs::canonicalize(root)? != physical_root {
        return Err(io::Error::other("Music directory changed during listing"));
    }
    let mut seen = HashSet::from([(root_frame.before.dev(), root_frame.before.ino())]);
    let mut stack = vec![root_frame];
    let mut files = Vec::new();

    while let Some(current) = stack.last_mut() {
        let Some(entry) = current.entries.next() else {
            if !same_snapshot(&current.before, &current.file.metadata()?) {
                return Err(io::Error::other("Music directory changed during listing"));
            }
            stack.pop();
            continue;
        };
        let name = entry.name.as_c_str();
        let lexical = current.lexical.join(OsStr::from_bytes(name.to_bytes()));

        // Resolve Unknown d_type (rare filesystems like older XFS/NFS without ftype=1)
        let kind = if entry.kind == FileType::Unknown {
            FileType::from_raw_mode(statat(&current.file, name, AtFlags::SYMLINK_NOFOLLOW)?.st_mode)
        } else {
            entry.kind
        };

        if kind == FileType::Directory {
            let child = File::from(openat(&current.file, name, directory_flags, Mode::empty())?);
            let next = frame(child, lexical)?;
            if !seen.insert((next.before.dev(), next.before.ino())) {
                return Err(io::Error::other(
                    "Music directory changed or contains a cycle",
                ));
            }
            stack.push(next);
        } else if kind == FileType::RegularFile && has_audio_extension_bytes(name.to_bytes()) {
            #[cfg(target_os = "linux")]
            if let Some(item) = regular_audio_file_statx(&current.file, name, &lexical)? {
                files.push(item);
                continue;
            }
            // Fallback for non-Linux Unix or if replaced concurrently with a symlink
            if let Some((item, metadata)) = audio_file_slow(&lexical, physical_root)? {
                let target = statat(&current.file, name, AtFlags::empty())?;
                if !raw_matches(&target, &metadata) {
                    return Err(io::Error::other("Music file changed during listing"));
                }
                files.push(item);
            }
        } else if kind == FileType::Symlink && has_audio_extension_bytes(name.to_bytes()) {
            let raw = statat(&current.file, name, AtFlags::SYMLINK_NOFOLLOW)?;
            if let Some((item, metadata)) = audio_file_slow(&lexical, physical_root)? {
                let target = statat(&current.file, name, AtFlags::empty())?;
                let link_after = statat(&current.file, name, AtFlags::SYMLINK_NOFOLLOW)?;
                if !raw_matches(&target, &metadata)
                    || raw.st_dev != link_after.st_dev
                    || raw.st_ino != link_after.st_ino
                    || raw.st_mtime != link_after.st_mtime
                    || raw.st_mtime_nsec != link_after.st_mtime_nsec
                    || raw.st_ctime != link_after.st_ctime
                    || raw.st_ctime_nsec != link_after.st_ctime_nsec
                {
                    return Err(io::Error::other("Music file changed during listing"));
                }
                files.push(item);
            }
        }
    }

    if fs::canonicalize(root)? != physical_root {
        return Err(io::Error::other("Music directory changed during listing"));
    }
    Ok(files)
}

#[cfg(not(unix))]
fn walk(root: &Path, physical_root: &Path) -> io::Result<Vec<AudioFile>> {
    let mut pending = vec![root.to_owned()];
    let mut visited = std::collections::HashSet::new();
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        let physical = fs::canonicalize(&directory)?;
        if !physical.starts_with(physical_root) || !visited.insert(physical) {
            return Err(io::Error::other(
                "Music directory changed or contains a cycle",
            ));
        }
        let before = fs::metadata(&directory)?;
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            let kind = fs::symlink_metadata(&path)?.file_type();
            if kind.is_dir() {
                pending.push(path);
            } else if (kind.is_file() || kind.is_symlink()) && is_audio_file(&path) {
                if let Some((item, _)) = audio_file_slow(&path, physical_root)? {
                    files.push(item);
                }
            }
        }
        verify_directory(&directory, physical_root, &before)?;
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_extensions_literal_brackets_unicode_and_excludes_hidden_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("music [FLAC]");
        fs::create_dir_all(root.join("album")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        for file in [
            "a.MP3",
            "album/b.FLAC",
            "album/песня.opus",
            "c.ogg",
            "d.wav",
            "e.m4a",
            "f.aac",
            "g.wma",
            ".hidden/secret.mp3",
            "album/.hidden.mp3",
            "cover.jpg",
            "noextension",
        ] {
            fs::write(root.join(file), b"audio").unwrap();
        }
        fs::create_dir(root.join("folder.mp3")).unwrap();
        let result = list_audio_files(&root).unwrap();
        assert_eq!(result.files.len(), 8);
        for file in result.files {
            assert!(file.path.starts_with(root.to_str().unwrap()));
            assert_eq!(file.size, 5);
            assert!(file.mtime_ms.is_finite());
            assert_eq!(file.mtime_ms.fract(), 0.0);
            assert!(!file.path.contains("hidden"));
        }
    }

    #[test]
    fn missing_non_directory_and_relative_roots_fail() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("file");
        fs::write(&file, b"file").unwrap();
        assert!(list_audio_files(&file).is_err());
        assert!(list_audio_files(&temp.path().join("missing")).is_err());
        assert!(list_audio_files(Path::new("relative")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn date_milliseconds_match_node_stats_rounding() {
        assert_eq!(node_date_millis(10, 499_999), 10_000.0);
        assert_eq!(node_date_millis(10, 500_000), 10_001.0);
        assert_eq!(node_date_millis(10, 999_999_999), 11_000.0);
        assert_eq!(node_date_millis(-1, 500_000_001), -500.0);
        assert_eq!(node_date_millis(-1, 500_500_000), -499.0);
        assert_eq!(node_date_millis(-1, 499_500_000), -500.0);
        assert_eq!(node_date_millis(-1, 999_999_999), 0.0);
        assert_eq!(node_round_millis(0.49999999999999994), 0.0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_statx_birthtime_is_libc_independent_and_requires_matching_snapshot() {
        use rustix::fs::{AtFlags, CWD, StatxFlags, statx};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("track.mp3");
        fs::write(&path, b"audio").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let raw = statx(
            CWD,
            &path,
            AtFlags::empty(),
            StatxFlags::BASIC_STATS | StatxFlags::BTIME,
        )
        .unwrap();
        let millis = birthtime_from_statx(&raw, &metadata).unwrap();
        let expected = if raw.stx_mask & StatxFlags::BTIME.bits() != 0 {
            Some(raw.stx_btime.tv_sec as f64 * 1000.0 + f64::from(raw.stx_btime.tv_nsec) / 1e6)
        } else {
            None
        };
        assert_eq!(millis, expected);
        assert_eq!(birthtime_millis(&path, &metadata).unwrap(), expected);
        let listed = list_audio_files(temp.path()).unwrap();
        assert_eq!(
            listed.files[0].birthtime_ms,
            expected.map(|value| format!("{:.0}", node_round_millis(value)))
        );
        for change in 0..6 {
            let mut changed = raw;
            match change {
                0 => changed.stx_ino ^= 1,
                1 => changed.stx_dev_minor ^= 1,
                2 => changed.stx_size ^= 1,
                3 => changed.stx_mtime.tv_nsec ^= 1,
                4 => changed.stx_ctime.tv_nsec ^= 1,
                _ => changed.stx_dev_major ^= 1,
            }
            assert!(birthtime_from_statx(&changed, &metadata).is_err());
        }
        let mut no_birthtime = raw;
        no_birthtime.stx_mask &= !StatxFlags::BTIME.bits();
        assert_eq!(
            birthtime_from_statx(&no_birthtime, &metadata).unwrap(),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn file_symlinks_hardlinks_and_lexical_root_are_preserved_but_directory_links_are_not_followed()
    {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let physical_root = temp.path().join("physical");
        fs::create_dir_all(physical_root.join("album")).unwrap();
        let outside = temp.path().join("outside.mp3");
        fs::write(&outside, b"outside").unwrap();
        let original = physical_root.join("album/track.mp3");
        fs::write(&original, b"audio").unwrap();
        fs::hard_link(&original, physical_root.join("hard.MP3")).unwrap();
        symlink("album/track.mp3", physical_root.join("file-link.mp3")).unwrap();
        symlink(&outside, physical_root.join("outside.mp3")).unwrap();
        symlink("album", physical_root.join("directory-link.mp3")).unwrap();
        symlink(".", physical_root.join("cycle")).unwrap();
        symlink("no-such-file", physical_root.join("unrelated-broken.txt")).unwrap();
        let lexical_root = temp.path().join("lexical");
        symlink(&physical_root, &lexical_root).unwrap();
        let result = list_audio_files(&lexical_root).unwrap();
        assert_eq!(result.files.len(), 3);
        assert!(
            result
                .files
                .iter()
                .all(|file| file.path.starts_with(lexical_root.to_str().unwrap()))
        );
        assert!(result.files.iter().all(|file| file.nlink == 2));
        assert!(
            result
                .files
                .iter()
                .all(|file| file.ino == result.files[0].ino)
        );
        assert!(
            result
                .files
                .iter()
                .any(|file| file.path.ends_with("file-link.mp3"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn broken_and_cyclic_audio_symlinks_fail_the_entire_listing() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("valid.mp3"), b"audio").unwrap();
        let broken = temp.path().join("broken.mp3");
        symlink("missing", &broken).unwrap();
        assert!(list_audio_files(temp.path()).is_err());
        fs::remove_file(&broken).unwrap();
        symlink("broken.mp3", &broken).unwrap();
        assert!(list_audio_files(temp.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_subdirectory_fails_instead_of_returning_partial_listing() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let denied = temp.path().join("denied");
        fs::create_dir(&denied).unwrap();
        fs::write(temp.path().join("visible.mp3"), b"audio").unwrap();
        fs::write(denied.join("hidden-by-permissions.mp3"), b"audio").unwrap();
        fs::set_permissions(&denied, fs::Permissions::from_mode(0o0)).unwrap();
        let access_denied = fs::read_dir(&denied).is_err();
        let result = list_audio_files(temp.path());
        fs::set_permissions(&denied, fs::Permissions::from_mode(0o700)).unwrap();
        if access_denied {
            assert!(result.is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn fifo_with_audio_extension_is_not_an_audio_file() {
        let temp = tempfile::tempdir().unwrap();
        rustix::fs::mknodat(
            rustix::fs::CWD,
            temp.path().join("pipe.mp3"),
            rustix::fs::FileType::Fifo,
            rustix::fs::Mode::RWXU,
            0,
        )
        .unwrap();
        assert!(list_audio_files(temp.path()).unwrap().files.is_empty());
    }
}
