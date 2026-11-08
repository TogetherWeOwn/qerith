//! Bounded, one-request loopback HTTP ingress behind the test-owned TLS relay.
//! Not a deployable HTTP stack: no keepalive, pipelining or transfer-encoding.
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub const MAX_BODY: usize = 1024 * 1024;
const MAX_HEADERS: usize = 32 * 1024;

pub struct Request {
    pub method: String,
    pub target: String,
    pub fields: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub async fn read(stream: &mut TcpStream) -> std::io::Result<Request> {
    let invalid =
        || std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid fixture request");
    let mut raw = Vec::new();
    let mut byte = [0u8; 1];
    // Byte-wise header reading deliberately avoids consuming an unbounded body
    // before a declared length is checked. Limits are fixture parameters only.
    while !raw.ends_with(b"\r\n\r\n") {
        if raw.len() >= MAX_HEADERS {
            return Err(invalid());
        }
        stream.read_exact(&mut byte).await?;
        raw.push(byte[0]);
    }
    let text = std::str::from_utf8(&raw).map_err(|_| invalid())?;
    let mut lines = text.split("\r\n");
    let first: Vec<_> = lines.next().ok_or_else(invalid)?.split(' ').collect();
    if first.len() != 3 || first[2] != "HTTP/1.1" {
        return Err(invalid());
    }
    let method = first[0].to_owned();
    let target = first[1].to_owned();
    let mut fields = Vec::new();
    let mut length = None;
    for line in lines.take_while(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or_else(invalid)?;
        let value = value.trim_matches([' ', '\t']);
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid());
            }
            length = Some(value.parse::<usize>().map_err(|_| invalid())?);
        }
        // Preserve the raw header order and target for independent S3 signing.
        fields.push((name.to_owned(), value.to_owned()));
        if fields.len() > 128 {
            return Err(invalid());
        }
    }
    if fields
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("transfer-encoding"))
    {
        return Err(invalid());
    }
    let length = length.unwrap_or(0);
    if length > MAX_BODY {
        return Err(invalid());
    }
    if fields
        .iter()
        .any(|(n, v)| n.eq_ignore_ascii_case("expect") && v.eq_ignore_ascii_case("100-continue"))
    {
        stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await?;
    }
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await?;
    Ok(Request {
        method,
        target,
        fields,
        body,
    })
}

#[tokio::test]
async fn transfer_encoding_is_rejected_before_body_or_continue() {
    for length in ["", "Content-Length: 4\r\n"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut server, _) = listener.accept().await.unwrap();
        client.write_all(format!(
            "POST /archive/key?uploads HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n{length}Expect: 100-continue\r\n\r\n"
        ).as_bytes()).await.unwrap();
        // No body is sent: rejection must precede reading it or sending Continue.
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), read(&mut server))
            .await
            .unwrap();
        assert!(matches!(result, Err(e) if e.kind() == std::io::ErrorKind::InvalidData));
        drop(server);
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        assert!(response.is_empty());
    }
}

pub async fn write(
    stream: &mut TcpStream,
    response: qerith_core::s3::Response,
    head: bool,
) -> std::io::Result<()> {
    let mut header = format!(
        "HTTP/1.1 {} Fixture\r\nConnection: close\r\n",
        response.status
    );
    if !response
        .headers
        .iter()
        .any(|(n, _)| n.eq_ignore_ascii_case("content-length"))
    {
        header.push_str(&format!("Content-Length: {}\r\n", response.body.len()));
    }
    for (name, value) in response.headers {
        if name.bytes().any(|b| b == b'\r' || b == b'\n')
            || value.bytes().any(|b| b == b'\r' || b == b'\n')
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid fixture response",
            ));
        }
        header.push_str(&format!("{name}: {value}\r\n"));
    }
    header.push_str("\r\n");
    stream.write_all(header.as_bytes()).await?;
    if !head {
        stream.write_all(&response.body).await?;
    }
    stream.shutdown().await
}
