import { editProfile, readProfileState } from './guild-profile-host';
import { guildSessionHost } from './guild-http-session';
import { createGuildProfileHandlers } from '../guild-profiles/guild-profile-http';

export const guildProfileHandlers = createGuildProfileHandlers({
  ...guildSessionHost('guild-profile'),
  read: readProfileState,
  edit: editProfile,
});
