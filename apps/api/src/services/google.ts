import type { Config } from '../config';

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export interface GoogleClient {
  authUrl(state: string): string;
  profile(code: string): Promise<GoogleProfile>;
}

export function createGoogleClient(config: Config): GoogleClient | undefined {
  const id = config.GOOGLE_CLIENT_ID;
  const secret = config.GOOGLE_CLIENT_SECRET;
  const redirect = config.GOOGLE_REDIRECT_URI;
  if (!id || !secret || !redirect) return undefined;

  return {
    authUrl(state) {
      const params = new URLSearchParams({
        client_id: id,
        redirect_uri: redirect,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    },

    async profile(code) {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: id,
          client_secret: secret,
          redirect_uri: redirect,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) throw new Error('Google token exchange failed');
      const { access_token } = (await tokenRes.json()) as { access_token: string };

      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!infoRes.ok) throw new Error('Google userinfo failed');
      const info = (await infoRes.json()) as {
        sub: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
      };
      if (!info.email) throw new Error('Google account has no email');
      return {
        sub: info.sub,
        email: info.email.toLowerCase(),
        emailVerified: info.email_verified === true,
        name: info.name ?? info.email,
      };
    },
  };
}
