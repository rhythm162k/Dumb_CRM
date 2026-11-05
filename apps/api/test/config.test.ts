import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const valid = { DATABASE_URL: 'postgresql://x', JWT_ACCESS_SECRET: 'x'.repeat(40) };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(valid);
    expect(c.PORT).toBe(4000);
    expect(c.WEB_ORIGIN).toBe('http://localhost:5173');
    expect(c.REQUIRE_EMAIL_VERIFICATION).toBe(false);
    expect(c.BCRYPT_COST).toBe(12);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ JWT_ACCESS_SECRET: valid.JWT_ACCESS_SECRET })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadConfig({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects the placeholder secret in production', () => {
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'change-me'.repeat(5) }),
    ).toThrow(/real secret/);
  });

  it('treats empty optional variables as unset', () => {
    const c = loadConfig({ ...valid, RESEND_API_KEY: '', GOOGLE_CLIENT_ID: '' });
    expect(c.RESEND_API_KEY).toBeUndefined();
    expect(c.GOOGLE_CLIENT_ID).toBeUndefined();
  });
});
