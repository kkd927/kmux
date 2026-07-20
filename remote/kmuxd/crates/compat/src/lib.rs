#![forbid(unsafe_code)]

use serde::Serialize;
use thiserror::Error;

mod remote;

pub use remote::*;

pub const REMOTE_PROTOCOL_MIN: u16 = 1;
pub const REMOTE_PROTOCOL_MAX: u16 = 1;
#[cfg(not(feature = "fixture-keeper-local-protocol-2"))]
pub const KEEPER_LOCAL_PROTOCOL_MAJOR: u16 = 1;
#[cfg(feature = "fixture-keeper-local-protocol-2")]
pub const KEEPER_LOCAL_PROTOCOL_MAJOR: u16 = 2;
pub const TERMINAL_WIRE_VERSION: u16 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolCapabilities {
    pub remote_protocol_min: u16,
    pub remote_protocol_max: u16,
    pub keeper_local_protocol_major: u16,
    pub terminal_wire_version: u16,
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("no compatible remote protocol in peer range {peer_min}..={peer_max}")]
pub struct ProtocolMismatch {
    pub peer_min: u16,
    pub peer_max: u16,
}

#[must_use]
pub fn capabilities() -> ProtocolCapabilities {
    ProtocolCapabilities {
        remote_protocol_min: REMOTE_PROTOCOL_MIN,
        remote_protocol_max: REMOTE_PROTOCOL_MAX,
        keeper_local_protocol_major: KEEPER_LOCAL_PROTOCOL_MAJOR,
        terminal_wire_version: TERMINAL_WIRE_VERSION,
    }
}

pub fn negotiate(peer_min: u16, peer_max: u16) -> Result<u16, ProtocolMismatch> {
    let minimum = peer_min.max(REMOTE_PROTOCOL_MIN);
    let maximum = peer_max.min(REMOTE_PROTOCOL_MAX);
    if minimum > maximum {
        return Err(ProtocolMismatch { peer_min, peer_max });
    }
    Ok(maximum)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation_fails_closed_outside_the_supported_range() {
        assert_eq!(negotiate(1, 1), Ok(1));
        assert_eq!(
            negotiate(2, 3),
            Err(ProtocolMismatch {
                peer_min: 2,
                peer_max: 3
            })
        );
    }
}
