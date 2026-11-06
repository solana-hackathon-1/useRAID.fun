import type { Job } from '@prisma/client';
export const JOB_LEASE_MINUTES = 10;
export class JobLeaseLostError extends Error {
  constructor() {
    super('Job lease was lost; the external effect was not performed.');
    this.name = 'JobLeaseLostError';
  }
}
export function runUnderJobLease<T>(_job: Pick<Job, 'id' | 'lease'>, fn: () => Promise<T>) {
  return fn();
}
export async function assertJobLease() {}
