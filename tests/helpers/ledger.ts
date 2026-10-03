import type { PrismaClient } from '@prisma/client';

// A deposit credit backed by the paid transfer the ledger requires for every non-sandbox DEPOSIT.
export function creditUsdc(
  db: Pick<PrismaClient, '$transaction'>,
  userId: string,
  key: string,
  amount: bigint,
  network = 'mainnet',
) {
  return db.$transaction(async (tx) => {
    const transfer = await tx.usdcTransfer.create({
      data: {
        userId,
        kind: 'DEPOSIT',
        status: 'PAID',
        amount,
        walletAddress: 'fixture-wallet',
        recipient: 'fixture-recipient',
        network,
        mint: 'fixture-mint',
        paidAt: new Date(),
      },
    });
    return tx.balanceEntry.create({
      data: {
        userId,
        key,
        kind: 'DEPOSIT',
        network,
        transferId: transfer.id,
        availableDelta: amount,
        reservedDelta: 0n,
      },
    });
  });
}
