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
    // Deterministic ordering also makes parity checks independent of filesystem
    // directory enumeration order. Paths retain the caller's lexical root.
    files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(AudioFiles { files })
}

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            ["mp3", "flac", "ogg", "wav", "m4a", "aac", "wma", "opus"]
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

fn audio_file(path: &Path, physical_root: &Path) -> io::Result<Option<(AudioFile, Metadata)>> {
    let physical = fs::canonicalize(path)?;
    if !physical.starts_with(physical_root) {
        return Ok(None);
    }
    let metadata = fs::metadata(&physical)?;
    if !metadata.is_file() {
        return Ok(None);
    }
    let path = path
        .to_str()
        .ok_or_else(|| io::Error::other("Music path is not valid UTF-8"))?
        .to_owned();
    let size = metadata.len();
    if size > crate::MAX_SAFE_INTEGER {
        return Err(io::Error::other("Music file is too large"));
    }
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
    if nlink > crate::MAX_SAFE_INTEGER || !mtime_ms.is_finite() || mtime_ms.abs() > MAX_DATE_MS {
        return Err(io::Error::other("Music file metadata is not representable"));
    }
    let birthtime_ms = birthtime_millis(&physical, &metadata)?.and_then(|millis| {
        // Math.round(x) is floor(x + 0.5); birthtime is omitted unless > 0.
        (millis.is_finite() && millis > 0.0 && millis <= MAX_DATE_MS)
            .then(|| format!("{:.0}", node_round_millis(millis)))
    });
    Ok(Some((
        AudioFile {
            path,
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

    // Rust's musl Metadata::created() does not expose Linux birthtime. Query the
    // same statx data libuv uses, independently of the libc or Rust target.
    match statx(
        CWD,
        path,
        AtFlags::empty(),
        StatxFlags::BASIC_STATS | StatxFlags::BTIME,
    ) {
        Ok(raw) => birthtime_from_statx(&raw, metadata),
        // Match libuv's stat fallback on older kernels, seccomp policies and
        // filesystems which reject statx: these use ctime as birthtime. A
        // successful statx without BTIME instead has no birthtime (zero in UV).
        Err(Errno::NOSYS | Errno::INVAL | Errno::PERM | Errno::OPNOTSUPP) => Ok(Some(
            metadata.ctime() as f64 * 1000.0 + metadata.ctime_nsec() as f64 / 1e6,
        )),
        Err(error) => Err(error.into()),
    }
}

#[cfg(target_os = "linux")]
fn birthtime_from_statx(raw: &rustix::fs::Statx, metadata: &Metadata) -> io::Result<Option<f64>> {
    use rustix::fs::{StatxFlags, major, minor};

    // Never attach the birthtime of a replacement encountered between stat
    // and statx. The later dirfd checks independently validate the final path.
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
    // Node's fs Stats dateFromMs explicitly Math.round()s before constructing
    // Date, including negative times. See node/lib/internal/fs/utils.js.
    node_round_millis(seconds as f64 * 1000.0 + nanoseconds as f64 / 1e6)
}

fn node_round_millis(millis: f64) -> f64 {
    // floor(x + 0.5) can round up twice immediately below a half-integer.
    // Compare the fractional part to match JavaScript Math.round exactly.
    let floor = millis.floor();
    if millis - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

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
    use std::ffi::OsStr;
    use std::fs::File;
    use std::os::unix::ffi::OsStrExt;

    struct Frame {
        file: File,
        entries: Dir,
        lexical: PathBuf,
        before: Metadata,
    }

    fn frame(file: File, lexical: PathBuf) -> io::Result<Frame> {
        let before = file.metadata()?;
        let entries = Dir::read_from(&file)?;
        Ok(Frame {
            file,
            entries,
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
    verify_directory(root, physical_root, &root_frame.before)?;
    let mut seen = HashSet::from([(root_frame.before.dev(), root_frame.before.ino())]);
    let mut stack = vec![root_frame];
    let mut files = Vec::new();
    while let Some(current) = stack.last_mut() {
        let Some(entry) = current.entries.next() else {
            if !same_snapshot(&current.before, &current.file.metadata()?) {
                return Err(io::Error::other("Music directory changed during listing"));
            }
            verify_directory(&current.lexical, physical_root, &current.before)?;
            stack.pop();
            continue;
        };
        let entry = entry?;
        let name = entry.file_name();
        // This also excludes . and ..; glob's default dot option is false.
        if name.to_bytes().first() == Some(&b'.') {
            continue;
        }
        let lexical = current.lexical.join(OsStr::from_bytes(name.to_bytes()));
        let raw = statat(&current.file, name, AtFlags::SYMLINK_NOFOLLOW)?;
        let kind = FileType::from_raw_mode(raw.st_mode);
        if kind == FileType::Directory {
            // Open relative to the already-open parent and atomically refuse
            // symlinks. A concurrent rename cannot redirect the directory walk.
            let child = File::from(openat(&current.file, name, directory_flags, Mode::empty())?);
            let next = frame(child, lexical)?;
            if !raw_matches(&raw, &next.before)
                || !seen.insert((next.before.dev(), next.before.ino()))
            {
                return Err(io::Error::other(
                    "Music directory changed or contains a cycle",
                ));
            }
            verify_directory(&next.lexical, physical_root, &next.before)?;
            stack.push(next);
        } else if (kind == FileType::RegularFile || kind == FileType::Symlink)
            && is_audio_file(&lexical)
        {
            // Outside symlinks are intentionally omitted. Broken/cyclic audio
            // symlinks fail the listing, as do all traversal/stat errors, rather
            // than returning a partial list which could mark tracks missing.
            if let Some((item, metadata)) = audio_file(&lexical, physical_root)? {
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
    // In particular catch replacing the root symlink while listing its target.
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
                if let Some((item, _)) = audio_file(&path, physical_root)? {
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
        // Root can bypass mode bits; test the error whenever the host enforces
        // access restrictions (as it does for the normal server user).
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
