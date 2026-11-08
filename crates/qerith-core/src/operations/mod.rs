//! Versioned, transport-independent product operations. No listener, storage or scheduler.
//!
//! REST and MCP are projections, not independent implementations. The integration
//! adapter implements [`OperationPort`] once against the catalogue/job authority.
//! See `README.md` in this directory for the atomicity and trust-boundary contract.

mod model;
mod projection;
mod registry;

pub use model::*;
pub use projection::*;
pub use registry::*;

/// The single integration seam. All methods fail closed; there are no permissive defaults.
///
/// Authorization must resolve *every* reference, generation, destination, transfer
/// and job in the authenticated scope before disclosing existence or state. A
/// foreign handle and an absent handle must have the same observable failure.
/// Admission includes tenant/global quotas, moderation, current revocation and
/// resource budgets, including read/status traffic. `execute` MUST atomically
/// recheck authorization, preconditions and admission with the effect, bind the
/// full validated request to its reconciliation identity, and persist result/job
/// and outbox obligation together. Earlier hooks are not transaction fences.
///
/// Cursor lookup must verify scope, operation, query, snapshot and expiry against
/// the existing authority (or an independently reviewed authenticated encoding).
/// This module deliberately supplies neither a cursor MAC nor a second store.
pub trait OperationPort {
    fn authorize(&mut self, scope: &Scope, request: &Request) -> Result<(), Failure>;
    fn preconditions(&mut self, scope: &Scope, request: &Request) -> Result<(), Failure>;
    fn admit(&mut self, scope: &Scope, request: &Request) -> Result<(), Failure>;
    fn resolve_cursor(
        &mut self,
        scope: &Scope,
        request: &Request,
        cursor: &Opaque,
    ) -> Result<Opaque, Failure>;
    fn execute(
        &mut self,
        scope: &Scope,
        request: &Request,
        position: Option<&Opaque>,
    ) -> Result<Output, Failure>;
}

pub fn dispatch(
    port: &mut impl OperationPort,
    scope: Option<&Scope>,
    version: u16,
    operation: Operation,
    fields: Fields,
) -> Result<Output, Failure> {
    let scope = scope.ok_or(Failure::new(ErrorCode::Unauthenticated))?;
    if version != VERSION {
        return Err(Failure::new(ErrorCode::Unsupported));
    }
    let definition = operation.definition();
    let request = definition.validate(fields)?;
    port.authorize(scope, &request)?;
    if !definition.implemented {
        return Err(Failure::new(ErrorCode::Unsupported));
    }
    port.preconditions(scope, &request)?;
    port.admit(scope, &request)?;
    let position = match request.opaque("cursor") {
        Some(cursor) => Some(port.resolve_cursor(scope, &request, cursor)?),
        None => None,
    };
    if operation == Operation::Capabilities {
        return Ok(Output::Capabilities {
            version: VERSION,
            operations: REGISTRY
                .iter()
                .filter(|d| d.implemented)
                .map(|d| d.operation)
                .collect(),
            experimental_tasks: false,
        });
    }
    let output = port.execute(scope, &request, position.as_ref())?;
    if !definition.output.accepts(&output) || !output.within_bounds(&request) {
        // An invalid response may follow a committed effect. Do not suggest a
        // blind retry or manufacture a successful/rolled-back outcome.
        return Err(Failure {
            code: ErrorCode::Internal,
            effects: Effects::Unknown,
        });
    }
    Ok(output)
}
