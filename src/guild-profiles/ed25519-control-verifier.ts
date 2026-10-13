import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type {
  ProjectControlSignatureVerifier,
  ProjectControlVerificationInput,
} from './control-attestation-contracts';
/** Local crypto adapter. Domain module never owns a signing key or calls a wallet/provider. */
export const ed25519ProjectControlVerifier: ProjectControlSignatureVerifier = Object.freeze({
  version: 'v1',
  algorithm: 'ED25519',
  verify({ message, signature, signer }: ProjectControlVerificationInput) {
    try {
      const publicKey = bs58.decode(signer);
      const bytes = bs58.decode(signature);
      return (
        publicKey.length === 32 &&
        bytes.length === 64 &&
        nacl.sign.detached.verify(new TextEncoder().encode(message), bytes, publicKey)
      );
    } catch {
      return false;
    }
  },
});
