use crate::{fingerprints, listing};
use serde::Serialize;
use serde_json::{Number, Value};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
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
enum Operation {
    Hash,
    List,
}

#[derive(Debug)]
struct Request {
    id: Number,
    operation: Operation,
    path: PathBuf,
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
struct Ready {
    ready: bool,
    protocol: u8,
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
        Some("hash") => Operation::Hash,
        Some("list") => Operation::List,
        _ => return Err(invalid(Some(id), "Unsupported operation")),
    };
    let path = value
        .get("path")
        .and_then(Value::as_str)
        .filter(|path| !path.contains('\0'))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| invalid(Some(id.clone()), "Path must be absolute"))?;
    Ok(Request {
        id,
        operation,
        path,
    })
}

enum InputLine {
    Data(Vec<u8>),
    TooLong,
    Eof,
}

/// read_line() can allocate unbounded memory before a newline is received.
/// Drain oversized input without retaining it, then resume at the next line.
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

/// Bounded queue plus a fixed number of workers applies backpressure to stdin.
/// A single writer lock protects whole NDJSON records, including large listings.
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
    let (sender, receiver) = mpsc::sync_channel::<Request>(options.workers * 2);
    let receiver = Arc::new(Mutex::new(receiver));
    let mut workers = Vec::with_capacity(options.workers);
    for index in 0..options.workers {
        let receiver = Arc::clone(&receiver);
        let writer = Arc::clone(&writer);
        workers.push(
            thread::Builder::new()
                .name(format!("scanner-{index}"))
                .spawn(move || -> io::Result<()> {
                    loop {
                        let request = receiver
                            .lock()
                            .map_err(|_| io::Error::other("Protocol queue unavailable"))?
                            .recv();
                        let Ok(request) = request else {
                            return Ok(());
                        };
                        match request.operation {
                            Operation::Hash => write_message(
                                &writer,
                                &Success {
                                    id: request.id,
                                    result: fingerprints::compute_file_hashes(&request.path),
                                },
                            )?,
                            Operation::List => match listing::list_audio_files(&request.path) {
                                Ok(result) => write_message(
                                    &writer,
                                    &Success {
                                        id: request.id,
                                        result,
                                    },
                                )?,
                                Err(_) => write_message(
                                    &writer,
                                    &Failure {
                                        id: Some(request.id),
                                        error: "Unable to list music directory safely",
                                    },
                                )?,
                            },
                        }
                    }
                })?,
        );
    }
    // This extra receiver must be dropped so a failed worker pool unblocks send.
    drop(receiver);
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
                        Ok(request) => sender
                            .send(request)
                            .map_err(|_| io::Error::other("Protocol workers unavailable"))?,
                        Err(error) => write_message(&writer, &error)?,
                    }
                }
            }
        }
    })();
    drop(sender);
    let mut worker_result = Ok(());
    for worker in workers {
        let result = worker
            .join()
            .unwrap_or_else(|_| Err(io::Error::other("Protocol worker failed")));
        if let Err(error) = result {
            worker_result = Err(error);
        }
    }
    input_result.and(worker_result)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let lines = exchange(b"not JSON\n{\"id\":1,\"op\":\"unknown\",\"path\":\"/tmp\"}\n{\"id\":2,\"op\":\"hash\",\"path\":\"relative\"}\n{\"id\":1.5,\"op\":\"hash\",\"path\":\"/tmp\"}\n", 2);
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
