export async function issueOwnerInvite(metadata: { displayName: string | null; note: string | null }) {
  const response = await fetch('/api/owner/invitations', {
    method: 'POST', mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(metadata)
  });
  // The owner route uses 400 only for validation before the INSERT. Do not
  // infer non-issuance from a lost response, redirect, or upstream failure.
  if (response.status === 400) return { kind: 'not-issued' } as const;
  if (response.status !== 201 || response.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    throw new Error('Invite issuance unconfirmed');
  }
  const { id, token, expiresAt } = await response.json();
  if (typeof id !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(id) ||
      typeof token !== 'string' || token.length !== 43 || !/^[\w-]{43}$/.test(token) ||
      typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > 8.64e15) {
    throw new Error('Invite issuance unconfirmed');
  }
  return { token, expiresAt };
}
