export const RAID_STATUS = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED'] as const;
export const TRACKING_PHASE = [
  'COLLECTING',
  'FINALIZING',
  'REVIEW',
  'APPROVED',
  'ALLOCATED',
  'HELD',
  'HELD_RESOLVED',
] as const;
export const FUNDING_STATUS = ['NOT_REQUIRED', 'PENDING', 'VERIFIED'] as const;
// LAUNCH: a Meteora campaign funded from a launch's own fee and reserve balances (LaunchBalanceEntry).
export const FUNDING_ASSET = ['SOL', 'USDC', 'LAUNCH'] as const;
export const HOLD_REASON = [
  'INSUFFICIENT_FUNDS',
  'NO_COLLECTED_FEES',
  'RELEASED_BY_ADMIN',
  'COVERAGE_EXPIRED',
] as const;

export const POST_QUALIFICATION = ['LEGACY', 'QUALIFIED', 'EXCLUDED', 'DATA_INCOMPLETE'] as const;
export const POST_AVAILABILITY = ['AVAILABLE', 'DATA_INCOMPLETE', 'UNAVAILABLE'] as const;
export const POST_REVIEW_STATUS = ['CLEAR', 'FLAGGED', 'CLEARED'] as const;
export const POST_REASON_CODE = [
  'NOT_ENROLLED',
  'OUTSIDE_RAID',
  'BEFORE_ENROLLMENT',
  'REPOST',
  'REPLY',
  'ATTRIBUTION',
  'TARGET_MISSING',
  'DUPLICATE_CONTENT',
  'ADMIN_EXCLUDED',
  'AUTHOR_MISMATCH',
  'OTHER_RAID',
  'METRICS_INCOMPLETE',
  'LOOKUP_INCOMPLETE',
  'POST_UNAVAILABLE',
  'POST_RESTRICTED',
  'INVALID_POST',
  'LOOKUP_FAILED',
] as const;

export const USDC_TRANSFER_KIND = ['DEPOSIT', 'WITHDRAWAL', 'REWARD', 'REWARD_CREDIT'] as const;
export const USDC_TRANSFER_STATUS = ['AWAITING_TRANSFER', 'REQUESTED', 'PAID', 'REJECTED'] as const;
export const BALANCE_ENTRY_KIND = [
  'DEPOSIT',
  'WITHDRAWAL',
  'WITHDRAWAL_RESERVED',
  'WITHDRAWAL_RELEASED',
  'RAID_RESERVED',
  'RAID_SETTLED',
  'RAID_RELEASED',
  'RAID_REWARD_CREDIT',
  'TEST_FUNDS',
] as const;
export const RAID_ALLOCATION_KIND = ['REWARD', 'REFUND'] as const;

export type RaidStatus = (typeof RAID_STATUS)[number];
export type TrackingPhase = (typeof TRACKING_PHASE)[number];
export type FundingStatus = (typeof FUNDING_STATUS)[number];
export type FundingAsset = (typeof FUNDING_ASSET)[number];
export type HoldReason = (typeof HOLD_REASON)[number];
export type PostQualification = (typeof POST_QUALIFICATION)[number];
export type PostAvailability = (typeof POST_AVAILABILITY)[number];
export type PostReviewStatus = (typeof POST_REVIEW_STATUS)[number];
export type PostReasonCode = (typeof POST_REASON_CODE)[number];
export type UsdcTransferKind = (typeof USDC_TRANSFER_KIND)[number];
export type UsdcTransferStatus = (typeof USDC_TRANSFER_STATUS)[number];
export type BalanceEntryKind = (typeof BALANCE_ENTRY_KIND)[number];
export type RaidAllocationKind = (typeof RAID_ALLOCATION_KIND)[number];

// One entry per CHECK constraint added by the ledger_integrity and state_checks migrations.
export const CHECKED_STATES = {
  BalanceEntry_kind_check: BALANCE_ENTRY_KIND,
  UsdcTransfer_kind_check: USDC_TRANSFER_KIND,
  UsdcTransfer_status_check: USDC_TRANSFER_STATUS,
  RaidAllocation_kind_check: RAID_ALLOCATION_KIND,
  Raid_status_check: RAID_STATUS,
  Raid_trackingPhase_check: TRACKING_PHASE,
  Raid_fundingStatus_check: FUNDING_STATUS,
  Raid_fundingAsset_check: FUNDING_ASSET,
  Post_qualification_check: POST_QUALIFICATION,
  Post_availability_check: POST_AVAILABILITY,
  Post_reviewStatus_check: POST_REVIEW_STATUS,
} as const satisfies Record<string, readonly string[]>;
