export type WorkEntryLink = { label: string; href: string };
const on = (name: string) => process.env[name] === 'true';
/**
 * In-product entry points to the work pages, shown only while the feature's own read flag is on, so a disabled
 * feature never advertises a page that would only say it is unavailable. Pure configuration; no authority.
 */
export function workEntryLinks(): WorkEntryLink[] {
  return [
    ...(on('WORK_WORKSPACE_READS_ENABLED')
      ? [
          { label: 'My Raid', href: '/raider/work' },
          { label: 'Review and applicants', href: '/creator/work' },
        ]
      : []),
    ...(on('WORK_CREATION_READS_ENABLED')
      ? [{ label: 'Create a Raid (guided)', href: '/creator/work/new' }]
      : []),
    ...(on('NOTIFICATIONS_READS_ENABLED')
      ? [{ label: 'Notifications', href: '/notifications' }]
      : []),
  ];
}
/** Public main-navigation entries: visible to every visitor, but only while the feature's own flag is on. */
export function publicNavLinks(): WorkEntryLink[] {
  return on('WORK_FEED_READS_ENABLED') ? [{ label: 'Live Raids', href: '/raids' }] : [];
}
