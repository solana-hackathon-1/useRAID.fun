import { z } from 'zod';

export const NOTIFICATION_KINDS = [
  'ENGAGEMENT_ACCEPTED',
  'RAID_ACCEPTED',
  'SUBMISSION_RECEIVED',
  'REVIEW_DECIDED',
  'WORK_CLOSED',
  'RAID_CLOSED',
  'AMENDMENT_PROPOSED',
  'AMENDMENT_DECIDED',
  'AMENDMENT_WITHDRAWN',
  'DEADLINE_APPROACHING',
  'REVIEW_DEADLINE_APPROACHING',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationCategory = 'TRANSACTIONAL' | 'PROMOTIONAL';
/**
 * Fixed text and an in-product path per kind. Nothing about the work (title, scope, criteria, reasons, artifacts)
 * and no link with a token is ever put in a notification, so a lock-screen or email preview stays safe.
 */
const TEXT: Record<NotificationKind, { message: string; link: '/raider/work' | '/creator/work' }> =
  {
    ENGAGEMENT_ACCEPTED: {
      message: 'Your Raid was accepted. Open My Raid for the next steps.',
      link: '/raider/work',
    },
    RAID_ACCEPTED: { message: 'Someone accepted your Raid.', link: '/creator/work' },
    SUBMISSION_RECEIVED: {
      message: 'A submission is waiting for your review.',
      link: '/creator/work',
    },
    REVIEW_DECIDED: { message: 'Your submission has a review decision.', link: '/raider/work' },
    WORK_CLOSED: {
      message: 'Your Raid was closed. Open My Raid for the outcome.',
      link: '/raider/work',
    },
    RAID_CLOSED: { message: 'A Raid you manage was closed.', link: '/creator/work' },
    AMENDMENT_PROPOSED: {
      message: 'A change to your Raid terms needs your decision.',
      link: '/raider/work',
    },
    AMENDMENT_DECIDED: {
      message: 'A proposed change to a Raid was answered.',
      link: '/creator/work',
    },
    AMENDMENT_WITHDRAWN: {
      message: 'A proposed change to your Raid was withdrawn.',
      link: '/raider/work',
    },
    DEADLINE_APPROACHING: {
      message: 'A deadline on your Raid is approaching.',
      link: '/raider/work',
    },
    REVIEW_DEADLINE_APPROACHING: {
      message: 'A review you owe is due soon.',
      link: '/creator/work',
    },
  };
export const describeNotification = (kind: NotificationKind) => TEXT[kind];
/** Optional discovery/promotional messages need the person's opt-in; work notifications are not preferences. */
export function categoryAllowed(
  category: NotificationCategory,
  preferences: { promotional: boolean },
): boolean {
  return category === 'TRANSACTIONAL' || preferences.promotional === true;
}
export const NotificationViewSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(NOTIFICATION_KINDS),
  message: z.string().max(200),
  link: z.enum(['/raider/work', '/creator/work']),
  createdAt: z.iso.datetime(),
  read: z.boolean(),
});
export const NotificationListSchema = z.strictObject({
  version: z.literal('v1'),
  items: z.array(NotificationViewSchema).max(50),
  unread: z.number().int().min(0),
});
export const PreferencesSchema = z.strictObject({ promotional: z.boolean() });
export type NotificationList = z.infer<typeof NotificationListSchema>;
export const NotificationStateSchema = NotificationListSchema.extend({
  preferences: PreferencesSchema,
});
export type NotificationState = z.infer<typeof NotificationStateSchema>;
