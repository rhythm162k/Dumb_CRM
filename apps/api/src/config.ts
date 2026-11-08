import { z } from 'zod';
import { parseTrustProxy } from './lib/proxy';

// dotenv gives '' for empty variables, treat that as "not set"
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    WEB_ORIGIN: z.url().default('http://localhost:5173'),
    // Supabase and most hosted databases need TLS: 'require' (encrypted) or 'verify' (also checks the certificate)
    DATABASE_SSL: z.enum(['off', 'require', 'verify']).default('off'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    // how many reverse proxies sit in front of the API; decides which client IP rate limits use
    // a number of proxies (0 to 5), or `render` to trust Render's network and Cloudflare by address
    TRUST_PROXY: z
      .string()
      .default('1')
      .transform((value, ctx) => {
        const parsed = parseTrustProxy(value);
        if (parsed === undefined) {
          ctx.addIssue({ code: 'custom', message: "Use a number from 0 to 5, or 'render'" });
          return z.NEVER;
        }
        return parsed;
      }),
    // temporary: logs req.ip and X-Forwarded-For per /api request, to verify TRUST_PROXY after deploying
    DEBUG_CLIENT_IP: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
    REQUIRE_EMAIL_VERIFICATION: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    RESEND_API_KEY: optional,
    EMAIL_FROM: z.string().default('Crm <onboarding@resend.dev>'),

    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    GOOGLE_REDIRECT_URI: optional,
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production') {
      if (c.JWT_ACCESS_SECRET.includes('change-me')) {
        ctx.addIssue({
          code: 'custom',
          path: ['JWT_ACCESS_SECRET'],
          message: 'Set a real secret in production',
        });
      }
      if (c.BCRYPT_COST < 10) {
        ctx.addIssue({
          code: 'custom',
          path: ['BCRYPT_COST'],
          message: 'Use a cost of at least 10 in production',
        });
      }
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
