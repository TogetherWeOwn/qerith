use super::*;
use serde::de::{self, Deserialize, DeserializeSeed, Deserializer, MapAccess, Visitor};
use std::fmt;

/// Maximum raw JSON argument bytes, including whitespace and escape sequences.
pub const MAX_MESSAGE_BYTES: usize = 65_536;

/// Decode one flat operation object; not an HTTP listener or response serializer.
/// Authentication and route selection remain trusted caller inputs.
pub fn rest_request(
    port: &mut impl OperationPort,
    scope: Option<&Scope>,
    method: &str,
    path: &str,
    bytes: &[u8],
) -> RestResponse {
    let route = rest_routes()
        .into_iter()
        .find(|route| route.method == method && route.path == path);
    // Preserve the projection's authentication/unsupported-route precedence,
    // without inspecting untrusted arguments or entering the port.
    if scope.is_none() {
        return rest_call(port, scope, method, path, vec![]);
    }
    let Some(route) = route else {
        return rest_call(port, scope, method, path, vec![]);
    };
    match decode(route.definition, bytes) {
        Ok(fields) => rest_call(port, scope, method, path, fields),
        Err(error) => projection::rest_response(Err(error)),
    }
}

/// Decode tool arguments only, not a JSON-RPC envelope or full MCP protocol.
/// Scope and negotiated session state never come from the argument object.
pub fn mcp_request(
    port: &mut impl OperationPort,
    scope: Option<&Scope>,
    session: McpSession,
    mode: TaskMode,
    tool: &str,
    bytes: &[u8],
) -> McpResponse {
    let definition = REGISTRY.iter().find(|definition| definition.name == tool);
    if scope.is_none() || mode == TaskMode::Experimental {
        return mcp_call(port, scope, session, mode, tool, vec![]);
    }
    let Some(definition) = definition else {
        return mcp_call(port, scope, session, mode, tool, vec![]);
    };
    match decode(definition, bytes) {
        Ok(fields) => mcp_call(port, scope, session, mode, tool, fields),
        Err(error) => projection::mcp_response(Err(error)),
    }
}

fn decode(definition: &Definition, bytes: &[u8]) -> Result<Fields, Failure> {
    let invalid = Failure::new(ErrorCode::InvalidInput);
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(invalid);
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let fields = Object(definition)
        .deserialize(&mut decoder)
        .map_err(|_| invalid)?;
    decoder.end().map_err(|_| invalid)?;
    Ok(fields)
}

struct Object<'a>(&'a Definition);

impl<'de> DeserializeSeed<'de> for Object<'_> {
    type Value = Fields;

    fn deserialize<D: Deserializer<'de>>(self, decoder: D) -> Result<Fields, D::Error> {
        decoder.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for Object<'_> {
    type Value = Fields;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a flat operation object")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Fields, M::Error> {
        let mut fields = Fields::new();
        while let Some(name) = map.next_key::<String>()? {
            if fields.len() == MAX_FIELDS
                || !self.0.input.iter().any(|field| field.name == name)
                || fields.iter().any(|(key, _)| key == &name)
            {
                return Err(de::Error::custom("invalid operation field"));
            }
            fields.push((name, map.next_value::<Scalar>()?.0));
        }
        Ok(fields)
    }
}

struct Scalar(Value);

impl<'de> Deserialize<'de> for Scalar {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        decoder.deserialize_any(ScalarVisitor)
    }
}

struct ScalarVisitor;

impl Visitor<'_> for ScalarVisitor {
    type Value = Scalar;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bounded string, unsigned integer or boolean")
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Scalar, E> {
        if value.len() > MAX_TOKEN_BYTES {
            return Err(E::custom("operation string too long"));
        }
        Ok(Scalar(Value::Text(value.into())))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Scalar, E> {
        Ok(Scalar(Value::Number(value)))
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Scalar, E> {
        Ok(Scalar(Value::Flag(value)))
    }
}
