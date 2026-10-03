import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
import { clientIp, clientKey } from '../src/lib/auth';
import { hash } from '../src/lib/auth-primitives';

const request = (headers: Record<string, string>) =>
  new Request('http://localhost/api/x', { headers });
afterEach(() => vi.unstubAllEnvs());
describe('client IP derivation', () => {
  it('has no client identity unless a trusted header is configured', () => {
    expect(clientIp(request({ 'x-real-ip': '203.0.113.9' }))).toBeNull();
    expect(clientKey(request({ 'x-real-ip': '203.0.113.9' }))).toBeNull();
  });
  it('reads a single-value trusted header', () => {
    vi.stubEnv('TRUSTED_IP_HEADER', 'x-real-ip');
    expect(clientIp(request({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientKey(request({ 'x-real-ip': '203.0.113.9' }))).toBe(hash('203.0.113.9'));
  });
  it('uses the last hop of a forwarding list, not the client-forgeable first entry', () => {
    vi.stubEnv('TRUSTED_IP_HEADER', 'x-forwarded-for');
    expect(clientIp(request({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(request({ 'x-forwarded-for': '6.6.6.6,2001:db8::1' }))).toBe('2001:db8::1');
  });
  it('rejects missing or malformed values', () => {
    vi.stubEnv('TRUSTED_IP_HEADER', 'x-real-ip');
    expect(clientIp(request({ 'x-real-ip': 'not-an-ip' }))).toBeNull();
    expect(clientIp(request({}))).toBeNull();
  });
});
