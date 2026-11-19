// For a trusted deployer client on the configured RP origin. This helper
// neither fetches options nor submits the response to a network endpoint.
export async function createOwnerEnrollment(options: PublicKeyCredentialCreationOptionsJSON) {
  const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options);
  const credential = await navigator.credentials.create({ publicKey });
  if (!(credential instanceof PublicKeyCredential)) throw new Error('Registration unavailable');
  return { operation: 'enroll' as const, challenge: options.challenge, response: credential.toJSON() };
}
