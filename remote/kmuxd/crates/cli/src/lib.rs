#![forbid(unsafe_code)]

use std::path::Path;

use kmux_hook::{HookError, authorize_session_control_endpoint};
use kmux_keeper::{
    KeeperCaptureRequest, KeeperOperationInputRequest, KeeperRpcResponse, KeeperRuntimeError,
    SessionDescriptorState, invoke_keeper_capture, invoke_keeper_rpc, load_session_descriptor,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCapabilities {
    pub process_role: &'static str,
    pub available: bool,
    pub structured_acknowledgement: bool,
}

#[must_use]
pub fn capabilities() -> CliCapabilities {
    CliCapabilities {
        process_role: "cli",
        available: true,
        structured_acknowledgement: true,
    }
}

#[derive(Debug, Error)]
pub enum CliError {
    #[error("remote CLI authorization failed: {0}")]
    Hook(#[from] HookError),
    #[error("remote CLI keeper failed: {0}")]
    Keeper(#[from] KeeperRuntimeError),
    #[error("remote CLI request is invalid: {0}")]
    Invalid(&'static str),
    #[error("remote CLI request was fenced: {0}")]
    Fenced(String),
}

#[derive(Clone, Debug)]
pub enum CliSurfaceCommand {
    SendText {
        operation_id: Option<String>,
        text: String,
    },
    SendKey {
        operation_id: Option<String>,
        key: String,
    },
    Capture {
        capture_id: Option<String>,
        line_limit: usize,
        max_bytes: usize,
    },
    Status,
}

#[derive(Clone, Debug, Default)]
pub struct CliScope {
    pub expected_target_id: Option<String>,
    pub expected_workspace_id: Option<String>,
    pub expected_session_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum CliResult {
    InputAcknowledged {
        #[serde(rename = "operationId")]
        operation_id: String,
        #[serde(rename = "targetId")]
        target_id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "keeperGeneration")]
        keeper_generation: String,
        #[serde(rename = "writerLeaseId")]
        writer_lease_id: String,
        #[serde(rename = "byteLength")]
        byte_length: usize,
        boundary: String,
    },
    SurfaceCaptured {
        #[serde(rename = "captureId")]
        capture_id: String,
        #[serde(rename = "targetId")]
        target_id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "keeperGeneration")]
        keeper_generation: String,
        #[serde(rename = "mutationSequence")]
        mutation_sequence: String,
        cols: u16,
        rows: u16,
        text: String,
        #[serde(rename = "lineCount")]
        line_count: usize,
        #[serde(rename = "byteLength")]
        byte_length: usize,
        #[serde(rename = "linesTruncated")]
        lines_truncated: bool,
        #[serde(rename = "bytesTruncated")]
        bytes_truncated: bool,
        #[serde(rename = "retainedRangeTruncated")]
        retained_range_truncated: bool,
    },
    SessionStatus {
        #[serde(rename = "targetId")]
        target_id: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "keeperGeneration")]
        keeper_generation: String,
        state: String,
    },
}

pub fn execute_surface_command(
    endpoint_path: &Path,
    token: &str,
    scope: &CliScope,
    command: CliSurfaceCommand,
) -> Result<CliResult, CliError> {
    let endpoint = authorize_session_control_endpoint(endpoint_path, token)?;
    let descriptor = load_session_descriptor(Path::new(&endpoint.descriptor_path))?;
    if descriptor.resource_key != endpoint.resource_key
        || descriptor.keeper_generation != endpoint.keeper_generation
    {
        return Err(CliError::Fenced(
            "session control endpoint generation changed".to_owned(),
        ));
    }
    validate_scope(scope, &endpoint.resource_key)?;
    if descriptor.state != SessionDescriptorState::Running {
        return Err(CliError::Fenced("remote session is not running".to_owned()));
    }
    let session_id = endpoint
        .resource_key
        .session_id
        .as_ref()
        .ok_or(CliError::Invalid("session control endpoint has no session"))?
        .clone();
    match command {
        CliSurfaceCommand::SendText { operation_id, text } => inject(
            &descriptor,
            operation_id,
            text,
            &endpoint.resource_key.target_id,
            &endpoint.resource_key.workspace_id,
            &session_id,
        ),
        CliSurfaceCommand::SendKey { operation_id, key } => inject(
            &descriptor,
            operation_id,
            encode_key(&key)?,
            &endpoint.resource_key.target_id,
            &endpoint.resource_key.workspace_id,
            &session_id,
        ),
        CliSurfaceCommand::Capture {
            capture_id,
            line_limit,
            max_bytes,
        } => {
            let capture_id =
                capture_id.unwrap_or_else(|| format!("surface-capture_{}", Uuid::new_v4()));
            let capture = invoke_keeper_capture(
                &descriptor,
                &KeeperCaptureRequest {
                    message_type: "keeper.capture",
                    resource_key: &descriptor.resource_key,
                    keeper_generation: &descriptor.keeper_generation,
                    capture_id: &capture_id,
                    line_limit,
                    max_bytes,
                },
            )?;
            Ok(CliResult::SurfaceCaptured {
                capture_id,
                target_id: endpoint.resource_key.target_id,
                workspace_id: endpoint.resource_key.workspace_id,
                session_id,
                keeper_generation: capture.keeper_generation,
                mutation_sequence: capture.mutation_sequence.to_string(),
                cols: capture.cols,
                rows: capture.rows,
                byte_length: capture.text.len(),
                text: capture.text,
                line_count: capture.line_count,
                lines_truncated: capture.lines_truncated,
                bytes_truncated: capture.bytes_truncated,
                retained_range_truncated: capture.retained_range_truncated,
            })
        }
        CliSurfaceCommand::Status => Ok(CliResult::SessionStatus {
            target_id: endpoint.resource_key.target_id,
            workspace_id: endpoint.resource_key.workspace_id,
            session_id,
            keeper_generation: descriptor.keeper_generation,
            state: "running".to_owned(),
        }),
    }
}

fn inject(
    descriptor: &kmux_keeper::SessionDescriptor,
    operation_id: Option<String>,
    input: String,
    target_id: &str,
    workspace_id: &str,
    session_id: &str,
) -> Result<CliResult, CliError> {
    if input.len() > kmux_compat::REMOTE_TERMINAL_INPUT_HARD_MAX_BYTES {
        return Err(CliError::Invalid("terminal input exceeds 64 KiB"));
    }
    let operation_id = operation_id.unwrap_or_else(|| format!("terminal-input_{}", Uuid::new_v4()));
    let payload_hash = format!("{:x}", Sha256::digest(input.as_bytes()));
    let response = invoke_keeper_rpc(
        descriptor,
        &KeeperOperationInputRequest {
            message_type: "keeper.operation-input",
            resource_key: &descriptor.resource_key,
            keeper_generation: &descriptor.keeper_generation,
            operation_id: &operation_id,
            payload_hash: &payload_hash,
            input: &input,
        },
    )?;
    match response {
        KeeperRpcResponse::InputAck {
            operation_id: acknowledged_operation_id,
            keeper_generation,
            writer_lease_id,
            byte_length,
            boundary,
        } if acknowledged_operation_id == operation_id
            && keeper_generation == descriptor.keeper_generation
            && byte_length == input.len()
            && boundary == "pty-write" =>
        {
            Ok(CliResult::InputAcknowledged {
                operation_id,
                target_id: target_id.to_owned(),
                workspace_id: workspace_id.to_owned(),
                session_id: session_id.to_owned(),
                keeper_generation,
                writer_lease_id,
                byte_length,
                boundary,
            })
        }
        KeeperRpcResponse::Error { code, message, .. } => {
            Err(CliError::Fenced(format!("{code}: {message}")))
        }
        _ => Err(CliError::Invalid(
            "keeper returned an invalid input acknowledgement",
        )),
    }
}

fn validate_scope(
    scope: &CliScope,
    resource_key: &kmux_compat::RemoteResourceKey,
) -> Result<(), CliError> {
    if scope
        .expected_target_id
        .as_ref()
        .is_some_and(|value| value != &resource_key.target_id)
        || scope
            .expected_workspace_id
            .as_ref()
            .is_some_and(|value| value != &resource_key.workspace_id)
        || scope.expected_session_id.as_ref().is_some_and(|value| {
            resource_key
                .session_id
                .as_ref()
                .is_none_or(|actual| actual != value)
        })
    {
        return Err(CliError::Fenced(
            "CLI scope does not match this remote resource".to_owned(),
        ));
    }
    Ok(())
}

fn encode_key(key: &str) -> Result<String, CliError> {
    let encoded = match key {
        "Enter" | "Return" => "\r",
        "Tab" => "\t",
        "Escape" | "Esc" => "\u{1b}",
        "Backspace" => "\u{7f}",
        "ArrowUp" => "\u{1b}[A",
        "ArrowDown" => "\u{1b}[B",
        "ArrowRight" => "\u{1b}[C",
        "ArrowLeft" => "\u{1b}[D",
        "Delete" => "\u{1b}[3~",
        "Home" => "\u{1b}[H",
        "End" => "\u{1b}[F",
        value if value.chars().count() == 1 && !value.chars().any(char::is_control) => value,
        _ => return Err(CliError::Invalid("unsupported terminal key")),
    };
    Ok(encoded.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_encoding_is_bounded_and_terminal_compatible() {
        assert_eq!(encode_key("Enter").unwrap(), "\r");
        assert_eq!(encode_key("ArrowUp").unwrap(), "\u{1b}[A");
        assert_eq!(encode_key("x").unwrap(), "x");
        assert!(encode_key("unknown-key").is_err());
    }

    #[test]
    fn target_scope_rejects_cross_target_routing() {
        let key = kmux_compat::RemoteResourceKey {
            desktop_installation_id: "desktop_1".to_owned(),
            target_id: "target_1".to_owned(),
            workspace_id: "workspace_1".to_owned(),
            session_id: Some("session_1".to_owned()),
        };
        assert!(
            validate_scope(
                &CliScope {
                    expected_target_id: Some("target_2".to_owned()),
                    ..CliScope::default()
                },
                &key,
            )
            .is_err()
        );
    }
}
