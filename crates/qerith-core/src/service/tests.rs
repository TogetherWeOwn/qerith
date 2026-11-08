use super::*;
use std::cell::Cell;

struct ReadAccess(Cell<bool>);
impl Access for ReadAccess {
    fn tenant(&self, _: &o::Scope) -> Option<c::TenantId> {
        Some(c::TenantId(1))
    }
    fn permits(&self, _: &o::Scope, _: &str, action: c::Action) -> bool {
        action == c::Action::Read && self.0.get()
    }
    fn container(&self, _: &o::Scope, _: &str) -> bool {
        false
    }
    fn admit(&self, _: &o::Scope) -> bool {
        true
    }
    fn key_envelope(&self, _: &o::Scope, _: &n::Opaque, _: &n::Opaque) -> bool {
        false
    }
}

#[test]
fn terminal_cancel_bookkeeping_retains_only_committed_restore_value() {
    let scope = o::Scope {
        tenant: token("tenant", 1),
        principal: token("principal", 1),
    };
    let mut service = Service::new(
        ReadAccess(Cell::new(true)),
        Limits {
            bytes: 100,
            job_seconds: 100,
            transfer_seconds: 100,
            attempts: 1,
            records: 100,
        },
        n::Policy {
            profiles: vec![],
            limits: n::Limits {
                object_bytes: 100,
                transfer_bytes: 100,
                page_entries: 10,
                job_seconds: 100,
            },
        },
        10,
    )
    .unwrap();
    for (restore, state, effects) in [
        (true, o::JobState::Succeeded, o::Effects::Committed),
        (false, o::JobState::Succeeded, o::Effects::Committed),
        (true, o::JobState::Failed, o::Effects::Accepted),
    ] {
        let mut original = service
            .new_job(
                &scope,
                o::LogicalReference {
                    reference: token("object", 1),
                    generation: token("generation", 1),
                },
                1,
                Some(10),
            )
            .unwrap();
        original.restore = restore.then_some((c::JobId(1), c::OperationId(2)));
        original.value.effects = o::Effects::Accepted;
        service
            .model
            .jobs
            .insert(original.value.handle.clone(), original.clone());
        // Exercise the bookkeeping with the projected value supplied by apply;
        // composition tests cover the fresh authorization/publication boundary.
        let mut projected = original.clone();
        projected.value.state = state;
        projected.value.effects = effects;
        projected.value.progress.advance(10).unwrap();
        service.cancel(&scope, projected.clone()).unwrap();
        let stored = &service.model.jobs[&original.value.handle];
        assert_eq!(
            stored.value,
            if restore && effects == o::Effects::Committed {
                projected.value.clone()
            } else {
                original.value.clone()
            }
        );
        assert_eq!(stored.scope, original.scope);
        assert_eq!(stored.deadline, original.deadline);
        assert_eq!(stored.restore, original.restore);
        assert_eq!(stored.native_upload, original.native_upload);
        assert_eq!(stored.requires_live_target, original.requires_live_target);
        assert!(stored.copy.is_none());

        let value = stored.value.clone();
        let fields = vec![
            ("job".into(), o::Value::Text(value.handle.as_str().into())),
            ("identity".into(), o::Value::Text("rejected_cancel".into())),
        ];
        service.access.0.set(false);
        assert_eq!(
            o::dispatch(
                &mut service,
                Some(&scope),
                o::VERSION,
                o::Operation::Cancel,
                fields,
            )
            .unwrap_err(),
            denied()
        );
        assert_eq!(service.model.jobs[&value.handle].value, value);
        assert_eq!(service.model.jobs.len(), 1);
        assert!(service.model.replay.is_empty());
        assert_eq!(service.model.sequence, 0);
        assert!(service.model.catalogue.outbox(c::TenantId(1)).is_empty());
        service.access.0.set(true);
    }
}
