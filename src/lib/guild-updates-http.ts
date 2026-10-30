import { draftUpdate, listUpdatesState, publishUpdate, withdrawUpdate } from './guild-updates-host';
import { guildSessionHost } from './guild-http-session';
import { createGuildUpdatesHandlers } from '../guild-profiles/guild-updates-http';

export const guildUpdatesHandlers = createGuildUpdatesHandlers({
  ...guildSessionHost('guild-updates'),
  list: listUpdatesState,
  draft: draftUpdate,
  publish: publishUpdate,
  withdraw: withdrawUpdate,
});
