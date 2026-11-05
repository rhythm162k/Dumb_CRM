import type { Config } from '../config';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailService {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Dev fallback: prints the email (including links) to the API console. With `redact` (production)
 * it logs only the subject, so password-reset and verification links never end up in the logs.
 */
export class ConsoleEmailService implements EmailService {
  constructor(private readonly redact = false) {}

  async send(m: EmailMessage) {
    if (this.redact) {
      console.log(`Email not sent (no mail provider configured): "${m.subject}"`);
      return;
    }
    console.log(`\n--- email to ${m.to}: ${m.subject}\n${m.text}\n---\n`);
  }
}

export class ResendEmailService implements EmailService {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(m: EmailMessage) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.from,
        to: [m.to],
        subject: m.subject,
        text: m.text,
        html: m.html,
      }),
    });
    if (!res.ok) throw new Error(`Resend responded with ${res.status}`);
  }
}

/** Used in tests: keeps messages in memory. */
export class MemoryEmailService implements EmailService {
  sent: EmailMessage[] = [];
  async send(m: EmailMessage) {
    this.sent.push(m);
  }
  /** Extracts the ?token= value from the most recent message. */
  lastToken(): string | undefined {
    const last = this.sent[this.sent.length - 1];
    return last?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
  }
}

export function createEmailService(config: Config): EmailService {
  return config.RESEND_API_KEY
    ? new ResendEmailService(config.RESEND_API_KEY, config.EMAIL_FROM)
    : new ConsoleEmailService(config.NODE_ENV === 'production');
}

const wrapHtml = (body: string) =>
  `<div style="font-family:system-ui,sans-serif;max-width:480px;line-height:1.5">${body}</div>`;

export function verifyEmailMessage(link: string): Omit<EmailMessage, 'to'> {
  return {
    subject: 'Confirm your email',
    text: `Confirm your email address to finish setting up Dumb:\n${link}\n\nThe link works for 24 hours.`,
    html: wrapHtml(
      `<p>Confirm your email address to finish setting up Dumb.</p><p><a href="${link}">Confirm email</a></p><p>The link works for 24 hours.</p>`,
    ),
  };
}

export function resetPasswordMessage(link: string): Omit<EmailMessage, 'to'> {
  return {
    subject: 'Reset your password',
    text: `Choose a new password for your Dumb account:\n${link}\n\nThe link works for 1 hour. If you didn't ask for this, you can ignore this email.`,
    html: wrapHtml(
      `<p>Choose a new password for your Dumb account.</p><p><a href="${link}">Reset password</a></p><p>The link works for 1 hour. If you didn't ask for this, you can ignore this email.</p>`,
    ),
  };
}
