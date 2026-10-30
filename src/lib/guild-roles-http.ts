import { grantRole, proposeTransfer, respondTransfer, revokeRole } from './guild-roles-host';
import { guildSessionHost } from './guild-http-session';
import { createGuildRolesHandlers } from '../guild-profiles/guild-roles-http';

export const guildRolesHandlers = createGuildRolesHandlers({
  ...guildSessionHost('guild-roles'),
  grant: grantRole,
  revoke: revokeRole,
  propose: proposeTransfer,
  respond: respondTransfer,
});
