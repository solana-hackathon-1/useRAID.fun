import { activateGuildAsOperator } from './guild-activation-host';
import { guildSessionHost } from './guild-http-session';
import { createGuildActivationHandlers } from '../guild-profiles/guild-activation-http';

export const guildActivationHandlers = createGuildActivationHandlers({
  ...guildSessionHost('guild-activation'),
  activate: activateGuildAsOperator,
});
