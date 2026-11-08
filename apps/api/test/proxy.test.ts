import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { parseTrustProxy, RENDER_TRUST_PROXY } from '../src/lib/proxy';

// a tiny app that just reports the IP Express decides the visitor has
async function visitorIp(forwardedFor: string) {
  const app = express();
  app.set('trust proxy', RENDER_TRUST_PROXY);
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip });
  });
  const res = await request(app).get('/ip').set('X-Forwarded-For', forwardedFor);
  return res.body.ip as string;
}

describe('trust proxy = render', () => {
  it('finds the visitor behind the web app proxy + Cloudflare + Render (real production chain)', async () => {
    expect(await visitorIp('113.11.63.36, 162.158.88.33, 162.158.88.33, 10.24.77.5, 10.24.209.5')).toBe('113.11.63.36');
    expect(await visitorIp('113.11.63.36, 172.71.152.96, 172.71.152.96, 10.24.13.133, 10.28.148.81')).toBe('113.11.63.36');
  });

  it('finds the visitor on a shorter chain (a request straight to the API)', async () => {
    expect(await visitorIp('113.11.63.36, 162.158.88.33, 10.24.209.5')).toBe('113.11.63.36');
  });

  it('works for IPv6 visitors', async () => {
    expect(await visitorIp('2001:db8::1, 162.158.88.33, 10.24.209.5')).toBe('2001:db8::1');
  });

  it('ignores an address the visitor invents in the header', async () => {
    expect(await visitorIp('9.9.9.9, 113.11.63.36, 172.71.152.96, 10.24.13.133')).toBe('113.11.63.36');
    expect(await visitorIp('9.9.9.9, 8.8.8.8, 113.11.63.36, 162.158.88.33, 10.24.77.5')).toBe('113.11.63.36');
  });
});

describe('parseTrustProxy', () => {
  it('accepts hop counts 0 to 5 and the word render', () => {
    expect(parseTrustProxy('0')).toBe(0);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy(' RENDER ')).toBe(RENDER_TRUST_PROXY);
  });

  it('rejects everything else', () => {
    expect(parseTrustProxy('6')).toBeUndefined();
    expect(parseTrustProxy('9')).toBeUndefined();
    expect(parseTrustProxy('-1')).toBeUndefined();
    expect(parseTrustProxy('cloudflare')).toBeUndefined();
    expect(parseTrustProxy('')).toBeUndefined();
  });
});
