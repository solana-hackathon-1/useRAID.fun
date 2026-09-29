// Read the canonical origin at server runtime, including when a build moves between environments.
export const config = {
  demo: Reflect.get(process.env, 'DEMO_MODE') === 'true',
  appUrl:
    Reflect.get(process.env, 'NEXT_PUBLIC_APP_URL') ||
    process.env.APP_URL ||
    'http://localhost:3000',
  handle: process.env.X_OFFICIAL_HANDLE || 'useRAID',
  liveApproved: Reflect.get(process.env, 'LIVE_COLLECTION_APPROVED') === 'true',
  retentionDays: Math.max(1, Number(process.env.X_RETENTION_DAYS || 30)),
};
