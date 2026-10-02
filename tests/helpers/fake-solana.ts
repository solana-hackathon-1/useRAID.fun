import {
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  type Connection,
} from '@solana/web3.js';

export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

type Account = { data: Buffer; lamports?: number; owner?: PublicKey; executable?: boolean };

export class FakeRpc {
  genesisHash = MAINNET_GENESIS_HASH;
  blockhash = '11111111111111111111111111111111';
  blockHeight = 1000;
  lastValidBlockHeight = 1150;
  feePerSignature = 5000;
  simulationError: unknown = null;
  balances = new Map<string, number>();
  accounts = new Map<string, Account>();
  tokenBalances = new Map<string, string>();
  statuses = new Map<string, { confirmationStatus: string; err: unknown } | null>();
  transactions = new Map<string, unknown>();
  signatures = new Map<string, { signature: string }[]>();
  simulated: Buffer[] = [];
  sent: Buffer[] = [];

  getGenesisHash = async () => this.genesisHash;
  getLatestBlockhash = async () => ({
    blockhash: this.blockhash,
    lastValidBlockHeight: this.lastValidBlockHeight,
  });
  getBlockHeight = async () => this.blockHeight;
  getFeeForMessage = async (message: { header: { numRequiredSignatures: number } }) => ({
    value: this.feePerSignature * message.header.numRequiredSignatures,
  });
  simulateTransaction = async (tx: { serialize(): Uint8Array }) => {
    this.simulated.push(Buffer.from(tx.serialize()));
    return { value: { err: this.simulationError, logs: [] as string[] } };
  };
  sendRawTransaction = async (raw: Buffer | Uint8Array) => {
    this.sent.push(Buffer.from(raw));
    return 'fake-signature';
  };
  getSignatureStatuses = async (signatures: string[]) => ({
    value: signatures.map((signature) => this.statuses.get(signature) ?? null),
  });
  getTransaction = async (signature: string) => this.transactions.get(signature) ?? null;
  getBalance = async (key: PublicKey) => this.balances.get(key.toBase58()) ?? 0;
  getMinimumBalanceForRentExemption = async (size: number) =>
    size === 0 ? 890_880 : size === 165 ? 2_039_280 : 890_880 + size * 6960;
  getAccountInfo = async (key: PublicKey) => this.accounts.get(key.toBase58()) ?? null;
  getMultipleAccountsInfo = async (keys: PublicKey[]) =>
    keys.map((key) => this.accounts.get(key.toBase58()) ?? null);
  getTokenAccountBalance = async (key: PublicKey) => ({
    value: { amount: this.tokenBalances.get(key.toBase58()) ?? '0' },
  });
  getSignaturesForAddress = async (key: PublicKey) => this.signatures.get(key.toBase58()) ?? [];

  asConnection() {
    return this as unknown as Connection;
  }
}

export function decodeTransfers(raw: Buffer | Uint8Array) {
  const tx = Transaction.from(raw);
  return {
    feePayer: tx.feePayer?.toBase58(),
    transfers: tx.instructions
      .filter((ix) => ix.programId.equals(SystemProgram.programId))
      .filter((ix) => SystemInstruction.decodeInstructionType(ix) === 'Transfer')
      .map((ix) => {
        const decoded = SystemInstruction.decodeTransfer(ix);
        return {
          from: decoded.fromPubkey.toBase58(),
          to: decoded.toPubkey.toBase58(),
          lamports: Number(decoded.lamports),
        };
      }),
  };
}
