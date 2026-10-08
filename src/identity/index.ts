/** T006 preflight shell. No persistence or authentication is performed. */
export function identitySubjectKey(_subject: unknown): string {
  throw new Error('Identity subject key is not implemented.');
}
export function inspectVerifiedLink(_input: unknown, _policy: unknown, _now: unknown) {
  return { stage: 'BLOCKED', code: 'SERVICE_UNAVAILABLE' };
}
export function inspectAccountRemoval(_input: unknown) {
  return { stage: 'BLOCKED', code: 'SERVICE_UNAVAILABLE' };
}
