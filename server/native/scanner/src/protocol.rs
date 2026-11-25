use crate::fingerprints::{
    AudioBounds, BUFFER_SIZE, FileHashes, StreamFrame, hash_streamed_frames,
    stream_file_for_hashing,
};
use crate::listing;
use serde::Serialize;
use serde_json::{Number, Value};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread;

pub const DEFAULT_WORKERS: usize = 4;
pub const MAX_WORKERS: usize = 32;
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct Options {
    pub workers: usize,
}

pub fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Options, &'static str> {
    let mut args = args.into_iter();
    let mut stdio = false;
    let mut workers = None;
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--stdio" if !stdio => stdio = true,
            "--workers" if workers.is_none() => {
                let count = args
                    .next()
                    .and_then(|value| value.parse::<usize>().ok())
                    .filter(|&value| (1..=MAX_WORKERS).contains(&value))
                    .ok_or("--workers must be an integer between 1 and 32")?;
                workers = Some(count);
            }
            _ => return Err("Expected --stdio and optional --workers N"),
        }
    }
    if !stdio {
        return Err("--stdio is required");
    }
    Ok(Options {
        workers: workers.unwrap_or(DEFAULT_WORKERS),
    })
}

#[derive(Debug)]
struct BatchItem {
    index: usize,
    path: PathBuf,
    dev: u64,
    ino: u64,
}

#[derive(Debug)]
enum Operation {
    Hash(PathBuf),
    HashBatch(Vec<BatchItem>),
    List(PathBuf),
}

#[derive(Debug)]
struct Request {
    id: Number,
    operation: Operation,
}

#[derive(Debug, Serialize)]
struct Failure {
    id: Option<Number>,
    error: &'static str,
}

#[derive(Serialize)]
struct Success<T> {
    id: Number,
    result: T,
}

#[derive(Serialize)]
struct BatchHashesResult {
    items: Vec<FileHashes>,
}

#[derive(Serialize)]
struct Ready {
    ready: bool,
    protocol: u8,
}

type CpuJob = (AudioBounds, Receiver<StreamFrame>, SyncSender<FileHashes>);

fn parse_valid_path(value: Option<&Value>) -> Option<PathBuf> {
    value
        .and_then(Value::as_str)
        .filter(|path| !path.contains('\0'))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn parse_u64_opt(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::String(s)) => s.parse::<u64>().unwrap_or(u64::MAX),
        Some(Value::Number(n)) => n.as_u64().unwrap_or(u64::MAX),
        _ => u64::MAX,
    }
}

fn parse_request(line: &[u8]) -> Result<Request, Failure> {
    let invalid = |id, error| Failure { id, error };
    let value: Value =
        serde_json::from_slice(line).map_err(|_| invalid(None, "Request must be a JSON object"))?;
    let id = value.get("id").and_then(|id| match id {
        Value::Number(number) => {
            let safe = number
                .as_u64()
                .is_some_and(|value| value <= crate::MAX_SAFE_INTEGER)
                || number
                    .as_i64()
                    .is_some_and(|value| value.unsigned_abs() <= crate::MAX_SAFE_INTEGER);
            safe.then(|| number.clone())
        }
        _ => None,
    });
    let id = id.ok_or_else(|| invalid(None, "Request id must be a safe integer"))?;
    let operation = match value.get("op").and_then(Value::as_str) {
        Some("hash") => {
            let path = parse_valid_path(value.get("path"))
                .ok_or_else(|| invalid(Some(id.clone()), "Path must be absolute"))?;
            Operation::Hash(path)
        }
        Some("hash_batch") => {
            let arr = value
                .get("files")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid(Some(id.clone()), "files must be an array"))?;
            let mut items = Vec::with_capacity(arr.len());
            for (index, entry) in arr.iter().enumerate() {
                let path = parse_valid_path(entry.get("path"))
                    .ok_or_else(|| invalid(Some(id.clone()), "Path must be absolute"))?;
                let dev = parse_u64_opt(entry.get("dev"));
                let ino = parse_u64_opt(entry.get("ino"));
                items.push(BatchItem {
                    index,
                    path,
                    dev,
                    ino,
                });
            }
            Operation::HashBatch(items)
        }
        Some("list") => {
            let path = parse_valid_path(value.get("path"))
                .ok_or_else(|| invalid(Some(id.clone()), "Path must be absolute"))?;
            Operation::List(path)
        }
        _ => return Err(invalid(Some(id), "Unsupported operation")),
    };
    Ok(Request { id, operation })
}

enum InputLine {
    Data(Vec<u8>),
    TooLong,
    Eof,
}

fn read_line_limited(reader: &mut impl BufRead) -> io::Result<InputLine> {
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(if oversized {
                InputLine::TooLong
            } else if line.is_empty() {
                InputLine::Eof
            } else {
                InputLine::Data(line)
            });
        }
        let newline = buffer.iter().position(|&byte| byte == b'\n');
        let count = newline.map_or(buffer.len(), |position| position + 1);
        if !oversized {
            if line.len() + count > MAX_REQUEST_BYTES {
                oversized = true;
                line.clear();
            } else {
                line.extend_from_slice(&buffer[..count]);
            }
        }
        reader.consume(count);
        if newline.is_some() {
            return Ok(if oversized {
                InputLine::TooLong
            } else {
                InputLine::Data(line)
            });
        }
    }
}

fn write_message(writer: &Mutex<impl Write>, message: &impl Serialize) -> io::Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("Protocol writer unavailable"))?;
    serde_json::to_writer(&mut *writer, message)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

/// HDD-aware Producer-Consumer pipeline:
/// - Exactly ONE disk-reader thread (`scanner-hdd-io`) touches the filesystem,
///   eliminating cross-thread platter head thrashing even when `workers > 1`.
/// - A bounded pool of recycled 1 MiB buffers feeds `options.workers` CPU threads
///   (`scanner-cpu-*`) so SHA-256 hashing overlaps with the next sequential disk read.
/// - Single `hash` replies are flushed immediately as each file completes via a
///   dedicated reply thread so long-lived idle stdin streams never stall a response.
pub fn run_stdio<R: BufRead, W: Write + Send + 'static>(
    mut reader: R,
    writer: W,
    options: Options,
) -> io::Result<()> {
    if !(1..=MAX_WORKERS).contains(&options.workers) {
        return Err(io::Error::other("Invalid worker count"));
    }
    let writer = Arc::new(Mutex::new(writer));
    write_message(
        &writer,
        &Ready {
            ready: true,
            protocol: 1,
        },
    )?;

    let pool_buffers = (options.workers * 2).max(4);
    let (buf_pool_tx, buf_pool_rx) = sync_channel::<Vec<u8>>(pool_buffers);
    for _ in 0..pool_buffers {
        let _ = buf_pool_tx.send(vec![0_u8; BUFFER_SIZE]);
    }

    let (cpu_tx, cpu_rx) = sync_channel::<CpuJob>(options.workers * 2);
    let cpu_rx = Arc::new(Mutex::new(cpu_rx));
    let mut cpu_workers = Vec::with_capacity(options.workers);
    for index in 0..options.workers {
        let cpu_rx = Arc::clone(&cpu_rx);
        let buf_pool_tx = buf_pool_tx.clone();
        cpu_workers.push(
            thread::Builder::new()
                .name(format!("scanner-cpu-{index}"))
                .spawn(move || {
                    loop {
                        let job = cpu_rx.lock().ok().and_then(|rx| rx.recv().ok());
                        let Some((bounds, frame_rx, result_tx)) = job else {
                            return;
                        };
                        let hashes = hash_streamed_frames(bounds, frame_rx, &buf_pool_tx);
                        let _ = result_tx.send(hashes);
                    }
                })?,
        );
    }
    drop(cpu_rx);

    let (reply_tx, reply_rx) = sync_channel::<(Number, Receiver<FileHashes>)>(options.workers * 2);
    let writer_reply = Arc::clone(&writer);
    let reply_thread =
        thread::Builder::new()
            .name("scanner-reply".into())
            .spawn(move || -> io::Result<()> {
                while let Ok((id, rx)) = reply_rx.recv() {
                    let result = rx.recv().unwrap_or_default();
                    write_message(&writer_reply, &Success { id, result })?;
                }
                Ok(())
            })?;

    let (io_tx, io_rx) = sync_channel::<Request>(options.workers * 2);
    let writer_io = Arc::clone(&writer);
    let io_thread =
        thread::Builder::new()
            .name("scanner-hdd-io".into())
            .spawn(move || -> io::Result<()> {
                while let Ok(request) = io_rx.recv() {
                    match request.operation {
                        Operation::Hash(path) => {
                            let (res_tx, res_rx) = sync_channel(1);
                            stream_file_for_hashing(
                                &path,
                                &buf_pool_rx,
                                &buf_pool_tx,
                                &cpu_tx,
                                res_tx,
                            );
                            reply_tx.send((request.id, res_rx)).map_err(|_| {
                                io::Error::other("Protocol reply worker unavailable")
                            })?;
                        }
                        Operation::HashBatch(mut batch) => {
                            batch.sort_unstable_by_key(|item| (item.dev, item.ino));
                            let mut items = vec![FileHashes::default(); batch.len()];
                            let mut in_flight: Vec<(usize, Receiver<FileHashes>)> =
                                Vec::with_capacity(options.workers * 2);
                            for item in batch {
                                let (res_tx, res_rx) = sync_channel(1);
                                stream_file_for_hashing(
                                    &item.path,
                                    &buf_pool_rx,
                                    &buf_pool_tx,
                                    &cpu_tx,
                                    res_tx,
                                );
                                in_flight.push((item.index, res_rx));
                                if in_flight.len() >= options.workers * 2 {
                                    let (index, rx) = in_flight.remove(0);
                                    items[index] = rx.recv().unwrap_or_default();
                                }
                            }
                            for (index, rx) in in_flight {
                                items[index] = rx.recv().unwrap_or_default();
                            }
                            write_message(
                                &writer_io,
                                &Success {
                                    id: request.id,
                                    result: BatchHashesResult { items },
                                },
                            )?;
                        }
                        Operation::List(path) => match listing::list_audio_files(&path) {
                            Ok(result) => write_message(
                                &writer_io,
                                &Success {
                                    id: request.id,
                                    result,
                                },
                            )?,
                            Err(_) => write_message(
                                &writer_io,
                                &Failure {
                                    id: Some(request.id),
                                    error: "Unable to list music directory safely",
                                },
                            )?,
                        },
                    }
                }
                drop(reply_tx);
                drop(cpu_tx);
                Ok(())
            })?;

    let input_result = (|| {
        loop {
            match read_line_limited(&mut reader)? {
                InputLine::Eof => return Ok(()),
                InputLine::TooLong => write_message(
                    &writer,
                    &Failure {
                        id: None,
                        error: "Request exceeds 64 KiB limit",
                    },
                )?,
                InputLine::Data(line) => {
                    if line.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    match parse_request(&line) {
                        Ok(request) => io_tx
                            .send(request)
                            .map_err(|_| io::Error::other("Protocol workers unavailable"))?,
                        Err(error) => write_message(&writer, &error)?,
                    }
                }
            }
        }
    })();

    drop(io_tx);
    let io_result = io_thread
        .join()
        .unwrap_or_else(|_| Err(io::Error::other("Protocol I/O worker failed")));
    let reply_result = reply_thread
        .join()
        .unwrap_or_else(|_| Err(io::Error::other("Protocol reply worker failed")));
    for worker in cpu_workers {
        let _ = worker.join();
    }
    input_result.and(io_result).and(reply_result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fingerprints;
    use std::io::Cursor;

    #[derive(Clone)]
    struct Output(Arc<Mutex<Vec<u8>>>);

    impl Write for Output {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn exchange(input: &[u8], workers: usize) -> Vec<Value> {
        let output = Output(Arc::new(Mutex::new(Vec::new())));
        run_stdio(Cursor::new(input), output.clone(), Options { workers }).unwrap();
        let bytes = output.0.lock().unwrap();
        bytes
            .split(|&byte| byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect()
    }

    #[test]
    fn arguments_require_stdio_and_bound_worker_count() {
        assert_eq!(parse_args(["--stdio".into()]).unwrap().workers, 4);
        for workers in ["1", "32"] {
            assert!(parse_args(["--workers".into(), workers.into(), "--stdio".into()]).is_ok());
        }
        for workers in ["0", "33", "-1", "NaN", ""] {
            assert!(parse_args(["--stdio".into(), "--workers".into(), workers.into()]).is_err());
        }
        assert!(parse_args(Vec::<String>::new()).is_err());
        assert!(parse_args(["--stdio".into(), "--stdio".into()]).is_err());
    }

    #[test]
    fn invalid_requests_are_safe_and_correlated_when_possible() {
        let lines = exchange(
            b"not JSON\n{\"id\":1,\"op\":\"unknown\",\"path\":\"/tmp\"}\n{\"id\":2,\"op\":\"hash\",\"path\":\"relative\"}\n{\"id\":1.5,\"op\":\"hash\",\"path\":\"/tmp\"}\n",
            2,
        );
        assert_eq!(lines[0], serde_json::json!({"ready":true,"protocol":1}));
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[1]["id"], Value::Null);
        assert_eq!(lines[2]["id"], 1);
        assert_eq!(lines[3]["id"], 2);
        assert_eq!(lines[4]["id"], Value::Null);
        assert!(lines[1..].iter().all(|line| line["error"].is_string()));
    }

    #[test]
    fn oversized_lines_are_drained_then_next_request_is_processed() {
        let mut bytes = vec![b'x'; MAX_REQUEST_BYTES + 1];
        bytes.extend(b"\n{\"id\":3,\"op\":\"hash\",\"path\":\"/definitely-absent\"}");
        let lines = exchange(&bytes, 1);
        assert_eq!(lines.len(), 3);
        assert!(lines[1]["error"].as_str().unwrap().contains("64 KiB"));
        assert_eq!(lines[2]["id"], 3);
        assert_eq!(lines[2]["result"]["contentHash"], Value::Null);
    }

    #[test]
    fn eof_waits_for_every_queued_request_and_stdout_records_never_interleave() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("audio.mp3");
        std::fs::write(&path, vec![1; 400_000]).unwrap();
        let mut input = Vec::new();
        for id in 0..50 {
            serde_json::to_writer(
                &mut input,
                &serde_json::json!({"id":id,"op":"hash","path":path}),
            )
            .unwrap();
            input.push(b'\n');
        }
        let lines = exchange(&input, 4);
        assert_eq!(lines.len(), 51);
        let ids: std::collections::HashSet<_> = lines[1..]
            .iter()
            .map(|line| line["id"].as_u64().unwrap())
            .collect();
        assert_eq!(ids.len(), 50);
        assert!(
            lines[1..]
                .iter()
                .all(|line| line["result"]["contentHash"].as_str().unwrap().len() == 64)
        );
    }

    #[test]
    fn batch_hashing_sorts_by_inode_and_preserves_caller_order() {
        let temp = tempfile::tempdir().unwrap();
        let p1 = temp.path().join("one.mp3");
        let p2 = temp.path().join("two.mp3");
        std::fs::write(&p1, b"first-payload").unwrap();
        std::fs::write(&p2, b"second-payload").unwrap();
        let req = serde_json::json!({
            "id": 7,
            "op": "hash_batch",
            "files": [
                { "path": p1, "dev": "1", "ino": "999" },
                { "path": p2, "dev": "1", "ino": "100" }
            ]
        });
        let mut input = serde_json::to_vec(&req).unwrap();
        input.push(b'\n');
        let lines = exchange(&input, 2);
        assert_eq!(lines.len(), 2);
        let items = lines[1]["result"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0]["contentHash"].as_str(),
            fingerprints::compute_file_hashes(&p1)
                .content_hash
                .as_deref()
        );
        assert_eq!(
            items[1]["contentHash"].as_str(),
            fingerprints::compute_file_hashes(&p2)
                .content_hash
                .as_deref()
        );
    }

    #[test]
    fn missing_list_root_is_an_error_instead_of_an_empty_result() {
        let lines = exchange(
            b"{\"id\":4,\"op\":\"list\",\"path\":\"/definitely-absent\"}\n",
            1,
        );
        assert_eq!(lines[1]["id"], 4);
        assert!(lines[1].get("error").is_some());
        assert!(lines[1].get("result").is_none());
    }
}
