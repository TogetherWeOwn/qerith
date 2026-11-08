use super::*;

/// Pure projection descriptors, not HTTP routing or MCP protocol conformance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestRoute {
    pub method: &'static str,
    pub path: String,
    pub definition: &'static Definition,
}

pub fn rest_routes() -> Vec<RestRoute> {
    REGISTRY
        .iter()
        .map(|definition| RestRoute {
            method: "POST",
            path: format!("/v{VERSION}/operations/{}", definition.name),
            definition,
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpTool {
    pub name: &'static str,
    pub definition: &'static Definition,
}

pub fn mcp_tools() -> Vec<McpTool> {
    REGISTRY
        .iter()
        .filter(|definition| definition.implemented)
        .map(|definition| McpTool {
            name: definition.name,
            definition,
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestResponse {
    pub status: u16,
    pub outcome: Result<Output, Failure>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpResponse {
    pub is_error: bool,
    pub outcome: Result<Output, Failure>,
}

fn http_error(code: ErrorCode) -> u16 {
    match code {
        ErrorCode::Unauthenticated => 401,
        ErrorCode::Denied | ErrorCode::NotAvailable => 403,
        ErrorCode::InvalidInput | ErrorCode::InvalidCursor => 400,
        ErrorCode::Unsupported => 501,
        ErrorCode::PreconditionFailed => 412,
        ErrorCode::Conflict | ErrorCode::NotReady | ErrorCode::Cancelled => 409,
        ErrorCode::QuotaExceeded => 429,
        ErrorCode::Unavailable => 503,
        ErrorCode::IntegrityFailed | ErrorCode::Internal => 500,
    }
}

pub fn rest_call(
    port: &mut impl OperationPort,
    scope: Option<&Scope>,
    method: &str,
    path: &str,
    fields: Fields,
) -> RestResponse {
    let operation = rest_routes()
        .into_iter()
        .find(|r| r.method == method && r.path == path)
        .map(|r| r.definition.operation);
    let outcome = if scope.is_none() {
        Err(Failure::new(ErrorCode::Unauthenticated))
    } else if let Some(operation) = operation {
        dispatch(port, scope, VERSION, operation, fields)
    } else {
        Err(Failure::new(ErrorCode::Unsupported))
    };
    rest_response(outcome)
}

pub(super) fn rest_response(outcome: Result<Output, Failure>) -> RestResponse {
    let status = match &outcome {
        Err(error) => http_error(error.code),
        Ok(Output::Job(job)) if !job.state.terminal() => 202,
        Ok(Output::Upload { .. }) => 201,
        Ok(_) => 200,
    };
    RestResponse { status, outcome }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct McpSession {
    pub experimental_tasks_negotiated: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TaskMode {
    #[default]
    Baseline,
    Experimental,
}

pub fn mcp_call(
    port: &mut impl OperationPort,
    scope: Option<&Scope>,
    session: McpSession,
    mode: TaskMode,
    tool: &str,
    fields: Fields,
) -> McpResponse {
    let outcome = if scope.is_none() {
        Err(Failure::new(ErrorCode::Unauthenticated))
    } else if mode == TaskMode::Experimental {
        // Negotiation is necessary, never sufficient to claim task support.
        // No tasks are implemented/advertised in v1, even for negotiated clients.
        let _negotiated = session.experimental_tasks_negotiated;
        Err(Failure::new(ErrorCode::Unsupported))
    } else if let Some(definition) = REGISTRY.iter().find(|d| d.name == tool) {
        dispatch(port, scope, VERSION, definition.operation, fields)
    } else {
        Err(Failure::new(ErrorCode::Unsupported))
    };
    mcp_response(outcome)
}

pub(super) fn mcp_response(outcome: Result<Output, Failure>) -> McpResponse {
    McpResponse {
        is_error: outcome.is_err(),
        outcome,
    }
}
