/*
 * This file is part of paged (https://paged.media): paged-ml-host, the local
 * generative-image host.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! A minimal HTTP/1.1 server side: one request per connection
//! (`Connection: close`), `Content-Length` or chunked request bodies, plain
//! responses and a streaming (server-sent events) writer.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;

/// The request body cap (the API's `too_large`).
pub const MAX_BODY: usize = 64 * 1024 * 1024;
/// The cap on the request line plus headers.
const MAX_HEAD: usize = 64 * 1024;

pub struct Request {
    pub method: String,
    /// The path without the query string.
    pub path: String,
    /// Lower-cased names, in arrival order.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Why a request could not be read.
pub enum ReadError {
    /// The peer closed or timed out before a request arrived: nothing to answer.
    Gone,
    /// Malformed request: answer 400.
    Malformed(String),
    /// Body over [`MAX_BODY`]: answer 413.
    TooLarge,
}

impl From<io::Error> for ReadError {
    fn from(_: io::Error) -> Self {
        ReadError::Gone
    }
}

fn read_line(r: &mut impl BufRead, budget: &mut usize) -> Result<String, ReadError> {
    let mut buf = Vec::new();
    let n = r
        .by_ref()
        .take(*budget as u64 + 1)
        .read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Err(ReadError::Gone);
    }
    if n > *budget {
        return Err(ReadError::Malformed("request head too large".into()));
    }
    *budget -= n;
    if buf.last() != Some(&b'\n') {
        return Err(ReadError::Gone);
    }
    buf.pop();
    if buf.last() == Some(&b'\r') {
        buf.pop();
    }
    String::from_utf8(buf).map_err(|_| ReadError::Malformed("request head is not UTF-8".into()))
}

pub fn read_request(stream: &TcpStream) -> Result<Request, ReadError> {
    let mut r = BufReader::new(stream);
    let mut budget = MAX_HEAD;
    let line = read_line(&mut r, &mut budget)?;
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(ReadError::Malformed("bad request line".into()));
    };
    if !version.starts_with("HTTP/1.") {
        return Err(ReadError::Malformed("unsupported HTTP version".into()));
    }
    let path = target.split(['?', '#']).next().unwrap_or("").to_string();
    let mut headers = Vec::new();
    loop {
        let line = read_line(&mut r, &mut budget)?;
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(ReadError::Malformed("bad header line".into()));
        };
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    let mut req = Request {
        method: method.to_string(),
        path,
        headers,
        body: Vec::new(),
    };
    let chunked = req
        .header("transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    if chunked {
        req.body = read_chunked(&mut r)?;
    } else if let Some(len) = req.header("content-length") {
        let len: usize = len
            .parse()
            .map_err(|_| ReadError::Malformed("bad Content-Length".into()))?;
        if len > MAX_BODY {
            return Err(ReadError::TooLarge);
        }
        let mut body = vec![0; len];
        r.read_exact(&mut body)?;
        req.body = body;
    }
    Ok(req)
}

fn read_chunked(r: &mut impl BufRead) -> Result<Vec<u8>, ReadError> {
    let mut body = Vec::new();
    loop {
        let mut budget = MAX_HEAD;
        let line = read_line(r, &mut budget)?;
        let size = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size, 16)
            .map_err(|_| ReadError::Malformed("bad chunk size".into()))?;
        if size == 0 {
            // Trailers, up to the empty line.
            while !read_line(r, &mut budget)?.is_empty() {}
            return Ok(body);
        }
        if body.len() + size > MAX_BODY {
            return Err(ReadError::TooLarge);
        }
        let start = body.len();
        body.resize(start + size, 0);
        r.read_exact(&mut body[start..])?;
        let mut crlf = [0; 2];
        r.read_exact(&mut crlf)?;
        if crlf != *b"\r\n" {
            return Err(ReadError::Malformed("bad chunk terminator".into()));
        }
    }
}

pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn json(status: u16, value: &serde_json::Value) -> Self {
        Response {
            status,
            content_type: "application/json",
            headers: Vec::new(),
            body: serde_json::to_vec(value).unwrap_or_default(),
        }
    }

    pub fn error(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self::json(
            status,
            &serde_json::json!({ "error": code, "message": message.into() }),
        )
    }
}

pub fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "",
    }
}

fn head(
    status: u16,
    content_type: &str,
    len: Option<usize>,
    extra: &[(&'static str, String)],
) -> String {
    let mut h = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: {content_type}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n",
        reason(status)
    );
    if let Some(len) = len {
        h.push_str(&format!("Content-Length: {len}\r\n"));
    }
    for (k, v) in extra {
        h.push_str(&format!("{k}: {v}\r\n"));
    }
    h.push_str("\r\n");
    h
}

pub fn write_response(mut stream: &TcpStream, res: &Response) -> io::Result<()> {
    let h = head(
        res.status,
        res.content_type,
        Some(res.body.len()),
        &res.headers,
    );
    stream.write_all(h.as_bytes())?;
    stream.write_all(&res.body)?;
    stream.flush()
}

/// Starts a `text/event-stream` response; events follow with [`write_event`].
pub fn start_event_stream(
    mut stream: &TcpStream,
    extra: &[(&'static str, String)],
) -> io::Result<()> {
    let h = head(200, "text/event-stream", None, extra);
    stream.write_all(h.as_bytes())?;
    stream.flush()
}

pub fn write_event(
    mut stream: &TcpStream,
    event: &str,
    data: &serde_json::Value,
) -> io::Result<()> {
    let s = format!("event: {event}\ndata: {data}\n\n");
    stream.write_all(s.as_bytes())?;
    stream.flush()
}

/// An SSE comment line: keeps proxies from timing the stream out and finds a
/// closed peer.
pub fn write_keepalive(mut stream: &TcpStream) -> io::Result<()> {
    stream.write_all(b": keep-alive\n\n")?;
    stream.flush()
}
