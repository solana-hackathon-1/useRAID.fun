import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import { readPublicGuildLabels } from '../guild-profiles/guild-storage';
import type { FeedGuild } from '../work-loop/feed-contracts';

/**
 * Adds the approved public Guild name and slug to feed cards or a brief. A card whose Guild has no active public
 * page stays exactly as it was: no Guild fact and no link. Callers decide whether public Guild reads are on.
 */
export async function attachPublicGuilds<T extends { guildId: string }>(
  tx: Tx,
  cards: readonly T[],
): Promise<(T & { guild?: FeedGuild })[]> {
  const labels = await readPublicGuildLabels(
    tx,
    cards.map((card) => card.guildId),
  );
  return cards.map((card) => {
    const guild = labels.get(card.guildId);
    return guild ? { ...card, guild: { slug: guild.slug, name: guild.name } } : { ...card };
  });
}
