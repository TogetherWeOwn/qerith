use super::*;
use crate::s3::archive::QualifiedCache;
use sha2::{Digest, Sha256};

#[derive(PartialEq, Eq)]
struct CacheCopy {
    tenant: c::TenantId,
    generation: c::GenerationId,
    pin: c::PinId,
    identity: c::CiphertextIdentity,
    location: String,
}

impl<A: Access> Service<A> {
    fn download_copy(&self, scope: &o::Scope, handle: &o::Opaque) -> Result<CacheCopy, o::Failure> {
        let (generation, pin) = self.redeem(scope, handle)?;
        let transfer = &self.model.transfers.get(handle).ok_or_else(denied)?.value;
        let view = self.exact(scope, &transfer.target)?;
        let object = &self
            .bound_object(scope, &transfer.target.reference, &view)?
            .object;
        if !self.access.key_envelope(
            scope,
            &object.ciphertext.key_ref,
            &object.ciphertext.envelope_ref,
        ) {
            return Err(denied());
        }
        let tenant = self.tenant(scope)?;
        let stored = self
            .model
            .catalogue
            .generation(tenant, generation)
            .map_err(map)?;
        if stored.metadata != view.metadata {
            return Err(fail(o::ErrorCode::IntegrityFailed));
        }
        Ok(CacheCopy {
            tenant,
            generation,
            pin,
            identity: view.metadata.identity,
            location: stored
                .cache_location
                .ok_or(fail(o::ErrorCode::NotAvailable))?,
        })
    }

    /// Buffered full-ciphertext delivery for an authorized service transfer.
    /// Reuses the S3 adapter's qualified whole-generation cache, never an archive
    /// fallback or decryption path. Native ranges remain unsupported. The handle
    /// and its existing pin remain reusable only through their original expiry.
    pub fn read_download(
        &mut self,
        scope: &o::Scope,
        handle: &o::Opaque,
        cache: &mut impl QualifiedCache,
        clock: &impl flow::Clock,
    ) -> Result<Vec<u8>, o::Failure> {
        self.set_now(clock.now().map_err(|_| fail(o::ErrorCode::Unavailable))?)?;
        let copy = self.download_copy(scope, handle)?;
        let body = cache.read(
            copy.tenant,
            copy.generation,
            &copy.identity,
            &copy.location,
            copy.pin,
            None,
        );
        self.set_now(clock.now().map_err(|_| fail(o::ErrorCode::Unavailable))?)?;
        // Even a cache error must not disclose a revoked transfer's state. Check
        // current key grants, logical binding, immutable version and pin first.
        if self.download_copy(scope, handle)? != copy {
            return Err(denied());
        }
        let body = body.map_err(|_| fail(o::ErrorCode::Unavailable))?;
        if u64::try_from(body.len()).ok() != Some(copy.identity.length)
            || <[u8; 32]>::from(Sha256::digest(&body)) != copy.identity.sha256
        {
            return Err(fail(o::ErrorCode::IntegrityFailed));
        }
        Ok(body)
    }
}
