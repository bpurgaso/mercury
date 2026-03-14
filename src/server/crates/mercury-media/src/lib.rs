pub mod room;
pub mod runtime;
pub mod types;

pub use runtime::{start_sfu, SfuHandle};
pub use types::*;

/// Detect the machine's primary non-loopback IP address by "connecting"
/// a UDP socket to an external address. No packet is actually sent —
/// the OS just resolves the local route, giving us the right interface IP.
pub(crate) fn detect_local_ip() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(socket.local_addr().ok()?.ip())
}
