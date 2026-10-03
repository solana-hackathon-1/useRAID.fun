import { Keypair } from '@solana/web3.js';
import { db } from './db';
import { decryptFeeSecret, decryptSecret, encryptSecret, sealSecret } from './launch-crypto';

export async function rotateLaunchKeys({ apply }: { apply: boolean }) {
  const counts = { total: 0, rotated: 0, unchanged: 0, failed: 0 };
  for (const launch of await db.tokenLaunch.findMany({
    select: { id: true, mint: true, feeAddress: true, feeSecret: true, mintSecret: true },
  })) {
    counts.total++;
    try {
      const feeContext = `fee:${launch.mint}`,
        mintContext = `mint:${launch.mint}`;
      const feeKey = decryptFeeSecret(launch.feeSecret, feeContext);
      const mintKey = decryptSecret(launch.mintSecret, mintContext);
      if (Keypair.fromSecretKey(feeKey).publicKey.toBase58() !== launch.feeAddress)
        throw new Error('Fee key does not match fee address');
      if (Keypair.fromSecretKey(mintKey).publicKey.toBase58() !== launch.mint)
        throw new Error('Mint key does not match mint');
      const feeSecret = sealSecret(feeKey, feeContext);
      const mintSecret = encryptSecret(mintKey, mintContext);
      if (
        Buffer.compare(Buffer.from(decryptFeeSecret(feeSecret, feeContext)), feeKey) !== 0 ||
        Buffer.compare(Buffer.from(decryptSecret(mintSecret, mintContext)), mintKey) !== 0
      )
        throw new Error('Round trip failed');
      const version = (value: string) => value.split(':')[0];
      if (
        version(feeSecret) === version(launch.feeSecret) &&
        version(mintSecret) === version(launch.mintSecret)
      ) {
        counts.unchanged++;
        continue;
      }
      if (apply)
        await db.$transaction(async (tx) => {
          const updated = await tx.tokenLaunch.updateMany({
            where: { id: launch.id, feeSecret: launch.feeSecret, mintSecret: launch.mintSecret },
            data: { feeSecret, mintSecret },
          });
          if (updated.count !== 1) throw new Error('Launch changed during rotation');
        });
      counts.rotated++;
    } catch {
      counts.failed++;
    }
  }
  return counts;
}
