//! Product-owned write-ahead state over the shared provider mechanism.
//! No journal value is a catalogue qualification or an eviction permit.

use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WriteJournal {
    pub intent: a::WriteIntent,
    pub phase: WritePhase,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum WritePhase {
    Prepared,
    /// Begin may have allocated remotely without returning its session. The v1
    /// provider cannot reconcile by intent alone: retain and request repair.
    BeginPending,
    Ready {
        session: a::WriteSession,
        receipts: Vec<a::PartReceipt>,
    },
    /// Persisted before every part/commit. A restarted invocation reconciles
    /// this exact session, never allocates another target or guesses rollback.
    EffectPending {
        session: a::WriteSession,
    },
    /// Stop writes while the original issued request is reconciled. Only settled
    /// absence permits the incomplete-session abort; a verified object is retained.
    AbortRequested {
        session: a::WriteSession,
    },
    /// An explicit incomplete-session abort may have taken effect. Never replay
    /// writes or infer multipart removal from object absence after this point.
    AbortPending {
        session: a::WriteSession,
    },
    /// No provider allocation was issued, or incomplete removal was acknowledged.
    /// Terminal for writes, not permission to delete the retained safety copy.
    Aborted {
        session: Option<a::WriteSession>,
    },
    /// Written atomically with the immutable record after validated readback.
    Verified {
        record: a::ObjectRecord,
    },
}

fn validate(
    cache: &impl ArchiveCache,
    work: &Work,
    journal: &WriteJournal,
) -> std::result::Result<(), IoError> {
    let intent = &journal.intent;
    intent.validate().map_err(io)?;
    if work.job.kind != JobKind::Archive
        || intent.target.tenant.as_str() != work.tenant.0.to_string()
        || intent.target.generation.as_str() != work.job.generation.0.to_string()
        || intent.bytes != work.metadata.identity.length
        || intent.sha256 != work.metadata.identity.sha256
        || intent.bytes > work.budget.max_bytes()
        || intent.parts.len() as u64 > u64::from(work.budget.max_units())
    {
        return Err(IoError::Integrity);
    }
    match &journal.phase {
        WritePhase::Ready { session, receipts } => {
            let binding = intent.binding().map_err(io)?;
            if session.intent != *intent
                || receipts.len() > intent.parts.len()
                || receipts
                    .iter()
                    .enumerate()
                    .any(|(i, r)| r.index != i || r.intent_binding != binding)
            {
                return Err(IoError::Integrity);
            }
        }
        WritePhase::EffectPending { session }
        | WritePhase::AbortRequested { session }
        | WritePhase::AbortPending { session }
        | WritePhase::Aborted {
            session: Some(session),
        } if session.intent != *intent => {
            return Err(IoError::Integrity);
        }
        WritePhase::Verified { record } => {
            record.validate().map_err(io)?;
            if record.intent() != *intent {
                return Err(IoError::Integrity);
            }
        }
        _ => {}
    }
    // Verified and its record are one inventory transaction. An unfinished
    // journal beside an existing object is not permission to begin/reconcile or
    // abort it. Check without Read authority: these are Write/Abort operations.
    match (&journal.phase, cache.archive_record(work)?) {
        (WritePhase::Verified { record }, Some(saved)) if *record == saved => {}
        (WritePhase::Verified { .. }, _) | (_, Some(_)) => return Err(IoError::Integrity),
        (_, None) => {}
    }
    Ok(())
}

async fn save(
    cache: &mut impl ArchiveCache,
    control: &impl Control,
    work: &Work,
    journal: &mut WriteJournal,
    phase: WritePhase,
) -> std::result::Result<(), IoError> {
    let action = match &phase {
        WritePhase::AbortRequested { .. }
        | WritePhase::AbortPending { .. }
        | WritePhase::Aborted { .. } => a::Action::AbortIncomplete,
        _ => a::Action::Write,
    };
    let next = WriteJournal {
        intent: journal.intent.clone(),
        phase,
    };
    // Dropping a pending CAS does not prove it failed: the runtime must reconcile
    // its exact original/next checkpoint before retrying any provider effect.
    interrupt(
        control,
        &journal.intent.target,
        action,
        cache.save_archive_write(work, journal, &next),
        |_| IoError::Uncertain,
    )
    .await?;
    control
        .check(&journal.intent.target, action)
        .map_err(|_| IoError::Uncertain)?;
    *journal = next;
    Ok(())
}

async fn verified(
    cache: &mut impl ArchiveCache,
    control: &impl Control,
    work: &Work,
    journal: &mut WriteJournal,
    proof: a::WriteProof,
) -> std::result::Result<(), IoError> {
    // A provider has already issued effects. Invalid proof, revoked Write or a
    // failed/uncertain local commit never means absence or cleanup permission.
    if !proof.acknowledged
        || !proof.full_ciphertext_readback
        || proof.backend != journal.intent.target.backend
        || proof.record.intent() != journal.intent
        || proof.record.validate().is_err()
    {
        return Err(IoError::Uncertain);
    }
    control
        .check(&journal.intent.target, a::Action::Write)
        .map_err(|_| IoError::Uncertain)?;
    save(
        cache,
        control,
        work,
        journal,
        WritePhase::Verified {
            record: proof.record,
        },
    )
    .await
    .map_err(|_| IoError::Uncertain)
}

pub(super) async fn abort(
    cache: &mut impl ArchiveCache,
    provider: &mut impl ArchiveProvider,
    control: &impl Control,
    work: &Work,
    mut journal: WriteJournal,
) -> std::result::Result<a::AbortOutcome, IoError> {
    validate(cache, work, &journal)?;
    control
        .check(&journal.intent.target, a::Action::AbortIncomplete)
        .map_err(io)?;
    let session = match journal.phase.clone() {
        WritePhase::Prepared => {
            save(
                cache,
                control,
                work,
                &mut journal,
                WritePhase::Aborted { session: None },
            )
            .await
            .map_err(|_| IoError::Uncertain)?;
            return Ok(a::AbortOutcome::IncompleteRemoved);
        }
        WritePhase::Aborted { .. } => return Ok(a::AbortOutcome::IncompleteRemoved),
        WritePhase::Verified { .. } => return Ok(a::AbortOutcome::Irreversible),
        WritePhase::BeginPending | WritePhase::AbortPending { .. } => {
            return Err(IoError::Uncertain);
        }
        WritePhase::Ready { session, .. } => session,
        WritePhase::EffectPending { session } | WritePhase::AbortRequested { session } => {
            if matches!(journal.phase, WritePhase::EffectPending { .. }) {
                save(
                    cache,
                    control,
                    work,
                    &mut journal,
                    WritePhase::AbortRequested {
                        session: session.clone(),
                    },
                )
                .await
                .map_err(|_| IoError::Uncertain)?;
            }
            // Reconcile the original request before touching its incomplete
            // session. Object absence after a lost abort cannot prove removal.
            let reconciled = invoke(
                control,
                &journal.intent.target,
                a::Action::AbortIncomplete,
                invoke(
                    control,
                    &journal.intent.target,
                    a::Action::Write,
                    provider.reconcile(&session, control),
                ),
            )
            .await;
            // Reconciliation requires Write, but belongs to this explicit abort
            // invocation. Abort-only revocation must interrupt it too, including
            // a policy change during a ready acknowledgement before local CAS.
            control
                .check(&journal.intent.target, a::Action::AbortIncomplete)
                .map_err(|_| IoError::Uncertain)?;
            match reconciled {
                Ok(a::Reconciled::Absent) => session,
                Ok(a::Reconciled::Verified(proof)) => {
                    verified(cache, control, work, &mut journal, *proof).await?;
                    return Ok(a::AbortOutcome::Irreversible);
                }
                _ => return Err(IoError::Uncertain),
            }
        }
    };
    control
        .check(&journal.intent.target, a::Action::AbortIncomplete)
        .map_err(io)?;
    save(
        cache,
        control,
        work,
        &mut journal,
        WritePhase::AbortPending {
            session: session.clone(),
        },
    )
    .await
    .map_err(|_| IoError::Uncertain)?;
    let outcome = invoke(
        control,
        &journal.intent.target,
        a::Action::AbortIncomplete,
        provider.abort(&session, control),
    )
    .await
    .map_err(|_| IoError::Uncertain)?;
    control
        .check(&journal.intent.target, a::Action::AbortIncomplete)
        .map_err(|_| IoError::Uncertain)?;
    match outcome {
        a::AbortOutcome::IncompleteRemoved => {
            save(
                cache,
                control,
                work,
                &mut journal,
                WritePhase::Aborted {
                    session: Some(session),
                },
            )
            .await
            .map_err(|_| IoError::Uncertain)?;
        }
        a::AbortOutcome::Irreversible => {}
        _ => return Err(IoError::Uncertain),
    }
    Ok(outcome)
}

pub(super) async fn post(
    cache: &mut impl ArchiveCache,
    provider: &mut impl ArchiveProvider,
    control: &impl Control,
    work: &Work,
    mut journal: WriteJournal,
) -> std::result::Result<(), IoError> {
    validate(cache, work, &journal)?;
    control
        .check(&journal.intent.target, a::Action::Write)
        .map_err(io)?;
    let caps = provider.capabilities();
    if !caps.write
        || !caps.reconcile
        || journal
            .intent
            .parts
            .iter()
            .any(|p| p.bytes as usize > caps.max_part_bytes)
    {
        return Err(IoError::RepairUnavailable);
    }
    match journal.phase.clone() {
        WritePhase::BeginPending
        | WritePhase::AbortRequested { .. }
        | WritePhase::AbortPending { .. } => return Err(IoError::Uncertain),
        WritePhase::Aborted { .. } => return Err(IoError::Cancelled),
        WritePhase::Verified { .. } => return Ok(()),
        WritePhase::Prepared => {
            save(cache, control, work, &mut journal, WritePhase::BeginPending).await?;
            let session = match invoke(
                control,
                &journal.intent.target,
                a::Action::Write,
                provider.begin(&journal.intent, control),
            )
            .await
            {
                Ok(session) => session,
                // Transient is the shared contract's definitive no-effect,
                // bounded-retry result. Restore the original intent to
                // Prepared under the same durable CAS so a later retry
                // re-enters begin; every other failure may have allocated
                // remotely and stays BeginPending/Uncertain.
                Err(a::Failure::Transient) => {
                    save(cache, control, work, &mut journal, WritePhase::Prepared)
                        .await
                        .map_err(|_| IoError::Uncertain)?;
                    return Err(IoError::Retryable);
                }
                Err(_) => return Err(IoError::Uncertain),
            };
            if session.intent != journal.intent {
                return Err(IoError::Uncertain);
            }
            save(
                cache,
                control,
                work,
                &mut journal,
                WritePhase::Ready {
                    session,
                    receipts: Vec::new(),
                },
            )
            .await
            .map_err(|_| IoError::Uncertain)?;
        }
        WritePhase::EffectPending { session } => {
            match invoke(
                control,
                &journal.intent.target,
                a::Action::Write,
                provider.reconcile(&session, control),
            )
            .await
            {
                Ok(a::Reconciled::Verified(proof)) => {
                    return verified(cache, control, work, &mut journal, *proof).await;
                }
                Ok(a::Reconciled::Absent) => {
                    // Absent requires all issued requests to be physically settled.
                    // Reuse the same session and exact parts, not begin/reallocation.
                    save(
                        cache,
                        control,
                        work,
                        &mut journal,
                        WritePhase::Ready {
                            session,
                            receipts: Vec::new(),
                        },
                    )
                    .await
                    .map_err(|_| IoError::Uncertain)?;
                }
                _ => return Err(IoError::Uncertain),
            }
        }
        WritePhase::Ready { .. } => {}
    }
    let WritePhase::Ready {
        session,
        mut receipts,
    } = journal.phase.clone()
    else {
        return Err(IoError::Integrity);
    };
    for index in receipts.len()..journal.intent.parts.len() {
        control
            .check(&journal.intent.target, a::Action::Write)
            .map_err(io)?;
        let bytes = interrupt(
            control,
            &journal.intent.target,
            a::Action::Write,
            cache.archive_write_part(work, &journal.intent.parts[index]),
            io,
        )
        .await?;
        journal.intent.check_part(index, &bytes).map_err(io)?;
        control
            .check(&journal.intent.target, a::Action::Write)
            .map_err(io)?;
        save(
            cache,
            control,
            work,
            &mut journal,
            WritePhase::EffectPending {
                session: session.clone(),
            },
        )
        .await?;
        let receipt = invoke(
            control,
            &journal.intent.target,
            a::Action::Write,
            provider.write_part(&session, index, &bytes, control),
        )
        .await
        .map_err(|_| IoError::Uncertain)?;
        if receipt.index != index
            || receipt.intent_binding != journal.intent.binding().map_err(io)?
        {
            return Err(IoError::Uncertain);
        }
        receipts.push(receipt);
        save(
            cache,
            control,
            work,
            &mut journal,
            WritePhase::Ready {
                session: session.clone(),
                receipts: receipts.clone(),
            },
        )
        .await
        .map_err(|_| IoError::Uncertain)?;
    }
    control
        .check(&journal.intent.target, a::Action::Write)
        .map_err(io)?;
    save(
        cache,
        control,
        work,
        &mut journal,
        WritePhase::EffectPending {
            session: session.clone(),
        },
    )
    .await?;
    let proof = invoke(
        control,
        &journal.intent.target,
        a::Action::Write,
        provider.commit(&session, &receipts, control),
    )
    .await
    .map_err(|_| IoError::Uncertain)?;
    verified(cache, control, work, &mut journal, proof).await
}
