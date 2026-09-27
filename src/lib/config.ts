export const config = {
  demo: process.env.DEMO_MODE === 'true',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  handle: process.env.X_OFFICIAL_HANDLE || 'useRAID',
  liveApproved: process.env.LIVE_COLLECTION_APPROVED === 'true',
  retentionDays: Math.max(1, Number(process.env.X_RETENTION_DAYS || 30)),
};
