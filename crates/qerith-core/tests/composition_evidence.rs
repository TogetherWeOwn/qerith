use qerith_core::composition::EVIDENCE_SCHEMA;
use serde_json::{json, Value};

#[test]
fn publication_schema_requires_full_success_and_ordered_failure_prefixes() {
    let schema: Value = serde_json::from_str(EVIDENCE_SCHEMA).unwrap();
    let order = &schema["properties"]["publication_order"];
    let expected = [
        "engine_retrieval",
        "whole_generation_verified",
        "cache_complete",
        "conditional_catalogue_publication",
        "scoped_serving_pin",
    ];
    // Pin the actual JSON Schema keywords; this is not a general schema validator.
    assert_eq!(order["type"], "array");
    assert_eq!(order["minItems"], 0);
    assert_eq!(order["maxItems"], 5);
    assert_eq!(
        order["prefixItems"],
        json!(expected.map(|step| json!({"const": step})))
    );
    let success = schema["allOf"]
        .as_array()
        .unwrap()
        .iter()
        .find(|rule| {
            rule["if"]["properties"]["conclusion"]["enum"]
                == json!(["software_invariants_only", "window_pass_not_launch"])
        })
        .expect("success must additionally require the complete ordered sequence");
    assert_eq!(
        success["then"]["properties"]["publication_order"]["minItems"],
        5
    );
    for conclusion in [
        "failed",
        "incomplete",
        "software_invariants_only",
        "window_pass_not_launch",
    ] {
        let minimum = if success["if"]["properties"]["conclusion"]["enum"]
            .as_array()
            .unwrap()
            .contains(&json!(conclusion))
        {
            success["then"]["properties"]["publication_order"]["minItems"]
                .as_u64()
                .unwrap()
        } else {
            order["minItems"].as_u64().unwrap()
        };
        let accepts = |steps: &[&str]| {
            steps.len() as u64 >= minimum
                && steps.len() as u64 <= order["maxItems"].as_u64().unwrap()
                && steps
                    .iter()
                    .zip(order["prefixItems"].as_array().unwrap())
                    .all(|(step, rule)| json!(step) == rule["const"])
        };
        for length in 0..=5 {
            assert_eq!(accepts(&expected[..length]), length as u64 >= minimum);
        }
        let mut reordered = expected;
        reordered.swap(0, 1);
        assert!(!accepts(&reordered[..2]));
        assert!(!accepts(&reordered));
        assert!(!accepts(&["cache_complete"]));
        assert!(!accepts(
            &[expected.as_slice(), &["scoped_serving_pin"]].concat()
        ));
    }
    // Failure records retain the same authority and qualification requirements.
    assert!(schema["required"]
        .as_array()
        .unwrap()
        .contains(&json!("authorization_ref")));
    assert!(schema["required"]
        .as_array()
        .unwrap()
        .contains(&json!("qualification_refs")));
    assert_eq!(schema["properties"]["authorization_ref"]["minLength"], 1);
    assert_eq!(
        schema["properties"]["qualification_refs"]["required"],
        json!([
            "independence",
            "readability",
            "reconstruction",
            "valid_until",
            "synthetic_only"
        ])
    );
}
