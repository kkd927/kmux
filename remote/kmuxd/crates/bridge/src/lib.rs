#![forbid(unsafe_code)]

use kmux_compat::ProtocolCapabilities;
use serde::Serialize;

mod runtime;

pub use runtime::*;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCapabilities {
    pub process_role: &'static str,
    pub available: bool,
    pub protocol: ProtocolCapabilities,
    pub terminal_stream_ownership: &'static str,
}

#[must_use]
pub fn capabilities() -> BridgeCapabilities {
    BridgeCapabilities {
        process_role: "bridge",
        available: true,
        protocol: kmux_compat::capabilities(),
        terminal_stream_ownership: "keeper-direct",
    }
}
