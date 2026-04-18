//! Incremental NDJSON line framer.
//!
//! The parser accepts bytes in arbitrary chunks, yields one parsed line at a
//! time, and never crashes on malformed input — malformed lines are surfaced
//! to the caller as `ParseOutcome::Malformed` and the parser continues with
//! the remainder of the buffer.

use serde_json::Value;

#[derive(Default)]
pub struct LineFramer {
    buf: Vec<u8>,
}

pub enum ParseOutcome {
    /// A well-formed JSON value parsed from a complete line.
    Value(Value),
    /// A non-empty line that failed to parse as JSON.
    Malformed { line: String, error: String },
}

impl LineFramer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Push a byte chunk. Returns all complete lines found, in order.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<ParseOutcome> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            let Some(pos) = self.buf.iter().position(|b| *b == b'\n') else {
                break;
            };
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            // Strip trailing \n (and \r if present).
            let mut end = line.len().saturating_sub(1);
            if end > 0 && line[end - 1] == b'\r' {
                end -= 1;
            }
            let slice = &line[..end];
            if slice.iter().all(|b| b.is_ascii_whitespace()) {
                continue; // skip blank lines
            }
            match serde_json::from_slice::<Value>(slice) {
                Ok(v) => out.push(ParseOutcome::Value(v)),
                Err(e) => out.push(ParseOutcome::Malformed {
                    line: String::from_utf8_lossy(slice).into_owned(),
                    error: e.to_string(),
                }),
            }
        }
        out
    }

    /// Flush a trailing line without a newline — called when the child closes
    /// its stdout. Empty buffers produce no output.
    pub fn flush(&mut self) -> Vec<ParseOutcome> {
        if self.buf.is_empty() {
            return Vec::new();
        }
        let rest = std::mem::take(&mut self.buf);
        if rest.iter().all(|b| b.is_ascii_whitespace()) {
            return Vec::new();
        }
        match serde_json::from_slice::<Value>(&rest) {
            Ok(v) => vec![ParseOutcome::Value(v)],
            Err(e) => vec![ParseOutcome::Malformed {
                line: String::from_utf8_lossy(&rest).into_owned(),
                error: e.to_string(),
            }],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_multiple_lines() {
        let mut f = LineFramer::new();
        let out = f.push(b"{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn partial_chunks_recombine() {
        let mut f = LineFramer::new();
        assert!(f.push(b"{\"a\":").is_empty());
        let out = f.push(b"1}\n");
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn malformed_line_surfaces() {
        let mut f = LineFramer::new();
        let out = f.push(b"not-json\n{\"a\":1}\n");
        assert_eq!(out.len(), 2);
        match &out[0] {
            ParseOutcome::Malformed { .. } => {}
            _ => panic!("expected malformed outcome"),
        }
        match &out[1] {
            ParseOutcome::Value(_) => {}
            _ => panic!("expected value after recovery"),
        }
    }

    #[test]
    fn blank_lines_skipped() {
        let mut f = LineFramer::new();
        let out = f.push(b"\n\n{\"x\":1}\n");
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn flush_captures_trailing() {
        let mut f = LineFramer::new();
        assert!(f.push(b"{\"x\":1}").is_empty());
        let out = f.flush();
        assert_eq!(out.len(), 1);
    }
}
