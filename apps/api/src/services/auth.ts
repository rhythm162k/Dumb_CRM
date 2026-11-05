import bcrypt from 'bcryptjs';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { emailTokens, refreshTokens, users, workspaceMembers, workspaces } from '../db/schema';
import { isUniqueViolation, one } from '../lib/db';
import { randomToken, sha256, signAccessToken } from '../lib/tokens';
import { AppError } from '../middleware/errors';
import type { EmailService } from './email';
import { resetPasswordMessage, verifyEmailMessage } from './email';
import type { GoogleProfile } from './google';

const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

export type UserRow = typeof users.$inferSelect;

export const toPublicUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  emailVerified: u.emailVerifiedAt !== null,
});

const unauthorized = (message = 'Sign in required') => new AppError(401, message, 'unauthorized');

export function createAuthService(deps: { db: Db; config: Config; email: EmailService }) {
  const { db, config, email } = deps;
  const hash = (password: string) => bcrypt.hash(password, config.BCRYPT_COST);
  // compared against when the account does not exist, so timing doesn't reveal it
  const dummyHash = bcrypt.hashSync('not-a-real-password', config.BCRYPT_COST);

  async function createAccount(input: {
    email: string;
    name: string;
    passwordHash?: string;
    googleId?: string;
    emailVerified?: boolean;
    workspaceName?: string;
  }) {
    try {
      return await db.transaction(async (tx) => {
        const user = one(
          await tx
            .insert(users)
            .values({
              email: input.email,
              name: input.name,
              passwordHash: input.passwordHash ?? null,
              googleId: input.googleId ?? null,
              emailVerifiedAt: input.emailVerified ? new Date() : null,
            })
            .returning(),
        );
        const workspace = one(
          await tx
            .insert(workspaces)
            .values({ name: input.workspaceName ?? `${input.name}'s workspace` })
            .returning(),
        );
        await tx
          .insert(workspaceMembers)
          .values({ workspaceId: workspace.id, userId: user.id, role: 'owner' });
        return { user, workspace };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(409, 'An account with this email already exists', 'email_taken');
      }
      throw err;
    }
  }

  async function startSession(userId: string, userAgent?: string) {
    const refreshToken = randomToken();
    await db.insert(refreshTokens).values({
      userId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * DAY_MS),
      userAgent: userAgent?.slice(0, 255) ?? null,
    });
    return { accessToken: signAccessToken(config, userId), refreshToken };
  }

  async function revokeAllSessions(userId: string) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }

  async function issueEmailToken(
    userId: string,
    type: 'verify_email' | 'reset_password',
    ttlMs: number,
  ) {
    const token = randomToken();
    await db.insert(emailTokens).values({
      userId,
      type,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return token;
  }

  /** Atomically marks a token as used, so every link works exactly once. */
  async function consumeEmailToken(type: 'verify_email' | 'reset_password', rawToken: string) {
    const rows = await db
      .update(emailTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(emailTokens.tokenHash, sha256(rawToken)),
          eq(emailTokens.type, type),
          isNull(emailTokens.usedAt),
          gt(emailTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: emailTokens.userId });
    const row = rows[0];
    if (!row) throw new AppError(400, 'This link is invalid or has expired', 'invalid_token');
    return row.userId;
  }

  async function sendVerificationEmail(user: UserRow) {
    try {
      const token = await issueEmailToken(user.id, 'verify_email', DAY_MS);
      await email.send({
        to: user.email,
        ...verifyEmailMessage(`${config.WEB_ORIGIN}/verify-email?token=${token}`),
      });
    } catch (err) {
      // a mail outage must not block sign-up
      console.error('Failed to send verification email', err);
    }
  }

  return {
    startSession,

    async register(input: {
      name: string;
      email: string;
      password: string;
      workspaceName?: string;
    }) {
      const passwordHash = await hash(input.password);
      const { user, workspace } = await createAccount({
        email: input.email,
        name: input.name,
        passwordHash,
        workspaceName: input.workspaceName,
      });
      await sendVerificationEmail(user);
      return { user, workspace };
    },

    async login(emailAddress: string, password: string) {
      const [user] = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${emailAddress}`)
        .limit(1);

      const now = new Date();
      if (user?.lockedUntil && user.lockedUntil > now) {
        throw new AppError(429, 'Too many failed attempts. Try again in a few minutes.', 'locked');
      }

      const ok = await bcrypt.compare(password, user?.passwordHash ?? dummyHash);
      if (!user || !user.passwordHash || !ok) {
        if (user) {
          const previous = user.lockedUntil && user.lockedUntil <= now ? 0 : user.failedLoginCount;
          const failed = previous + 1;
          await db
            .update(users)
            .set({
              failedLoginCount: failed,
              lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCK_MS) : null,
            })
            .where(eq(users.id, user.id));
        }
        throw new AppError(401, 'Invalid email or password', 'invalid_credentials');
      }

      if (config.REQUIRE_EMAIL_VERIFICATION && !user.emailVerifiedAt) {
        throw new AppError(
          403,
          'Confirm your email address before signing in',
          'email_not_verified',
        );
      }
      if (user.failedLoginCount > 0 || user.lockedUntil) {
        await db
          .update(users)
          .set({ failedLoginCount: 0, lockedUntil: null })
          .where(eq(users.id, user.id));
      }
      return user;
    },

    /** Rotates the refresh token. Reusing an already-rotated token revokes every session. */
    async refresh(rawToken: string, userAgent?: string) {
      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, sha256(rawToken)))
        .limit(1);
      if (!row) throw unauthorized('Session expired');

      if (row.revokedAt) {
        await revokeAllSessions(row.userId); // possible token theft
        throw unauthorized('Session expired');
      }
      if (row.expiresAt <= new Date()) throw unauthorized('Session expired');

      const revoked = await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      if (revoked.length === 0) throw unauthorized('Session expired');

      return startSession(row.userId, userAgent);
    },

    async logout(rawToken: string | undefined) {
      if (!rawToken) return;
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.tokenHash, sha256(rawToken)), isNull(refreshTokens.revokedAt)));
    },

    async getUser(userId: string) {
      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      return user;
    },

    async verifyEmail(token: string) {
      const userId = await consumeEmailToken('verify_email', token);
      await db
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
    },

    async resendVerification(userId: string) {
      const user = await this.getUser(userId);
      if (user && !user.emailVerifiedAt) await sendVerificationEmail(user);
    },

    /** Always resolves, so the response never reveals whether an account exists. */
    async requestPasswordReset(emailAddress: string) {
      const [user] = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${emailAddress}`)
        .limit(1);
      if (!user) return;
      try {
        const token = await issueEmailToken(user.id, 'reset_password', 60 * 60_000);
        await email.send({
          to: user.email,
          ...resetPasswordMessage(`${config.WEB_ORIGIN}/reset-password?token=${token}`),
        });
      } catch (err) {
        console.error('Failed to send reset email', err);
      }
    },

    async resetPassword(token: string, newPassword: string) {
      const userId = await consumeEmailToken('reset_password', token);
      const passwordHash = await hash(newPassword);
      await db
        .update(users)
        .set({
          passwordHash,
          failedLoginCount: 0,
          lockedUntil: null,
          updatedAt: new Date(),
          // they proved they own the mailbox
          emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
        })
        .where(eq(users.id, userId));
      await revokeAllSessions(userId);
    },

    async loginWithGoogle(profile: GoogleProfile) {
      if (!profile.emailVerified) {
        throw new AppError(403, 'Your Google email is not verified', 'email_not_verified');
      }
      const [byGoogleId] = await db
        .select()
        .from(users)
        .where(eq(users.googleId, profile.sub))
        .limit(1);
      if (byGoogleId) return byGoogleId;

      const [byEmail] = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${profile.email}`)
        .limit(1);
      if (byEmail) {
        // Google verified this address, so it is safe to link to the existing account
        return one(
          await db
            .update(users)
            .set({
              googleId: profile.sub,
              emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
              updatedAt: new Date(),
            })
            .where(eq(users.id, byEmail.id))
            .returning(),
        );
      }

      const { user } = await createAccount({
        email: profile.email,
        name: profile.name,
        googleId: profile.sub,
        emailVerified: true,
      });
      return user;
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
