use std::io::{self, BufReader, BufWriter};
use std::process::ExitCode;
use tunecloud_scanner::protocol::{parse_args, run_stdio};

fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("tunecloud-scanner: {error}");
            return ExitCode::from(2);
        }
    };
    match run_stdio(
        BufReader::new(io::stdin()),
        BufWriter::new(io::stdout()),
        options,
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("tunecloud-scanner: stdio protocol stopped");
            ExitCode::FAILURE
        }
    }
}
