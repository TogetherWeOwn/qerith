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
    /// Written atomically with the immutable record after validated readback.
    Verified {
        record: a::ObjectRecord,
    },
}

fn validate(work: &Work, journal: &WriteJournal) -> std::result::Result<(), IoError> {
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
        WritePhase::EffectPending { session } if session.intent != *intent => {
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
    Ok(())
}

async fn save(
    cache: &mut impl ArchiveCache,
    work: &Work,
    journal: &mut WriteJournal,
    phase: WritePhase,
) -> std::result::Result<(), IoError> {
    let next = WriteJournal {
        intent: journal.intent.clone(),
        phase,
    };
    cache.save_archive_write(work, journal, &next).await?;
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
        work,
        journal,
        WritePhase::Verified {
            record: proof.record,
        },
    )
    .await
    .map_err(|_| IoError::Uncertain)
}

pub(super) async fn post(
    cache: &mut impl ArchiveCache,
    provider: &mut impl ArchiveProvider,
    control: &impl Control,
    work: &Work,
    mut journal: WriteJournal,
) -> std::result::Result<(), IoError> {
    validate(work, &journal)?;
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
        WritePhase::BeginPending => return Err(IoError::Uncertain),
        WritePhase::Verified { .. } => return Ok(()),
        WritePhase::Prepared => {
            save(cache, work, &mut journal, WritePhase::BeginPending).await?;
            let session = invoke(
                control,
                &journal.intent.target,
                a::Action::Write,
                provider.begin(&journal.intent, control),
            )
            .await
            .map_err(|_| IoError::Uncertain)?;
            if session.intent != journal.intent {
                return Err(IoError::Uncertain);
            }
            save(
                cache,
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
        let bytes = cache
            .archive_write_part(work, &journal.intent.parts[index])
            .await?;
        journal.intent.check_part(index, &bytes).map_err(io)?;
        control
            .check(&journal.intent.target, a::Action::Write)
            .map_err(io)?;
        save(
            cache,
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
