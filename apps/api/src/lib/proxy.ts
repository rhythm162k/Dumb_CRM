/**
 * Which proxies in front of the API may be believed about the visitor's IP (X-Forwarded-For).
 *
 * Counting hops (TRUST_PROXY=2, 5 ...) breaks here: a request that comes through the web app's
 * /api rewrite passes more proxies than one sent straight to the API, and a hop count that is too
 * high lets a visitor fake their own IP. Trusting by ADDRESS works for every path: walk the
 * X-Forwarded-For list from the right, skip addresses that belong to Render's private network or
 * to Cloudflare (Render's front door), and the first address that is neither is the visitor.
 * Anything a visitor writes into the header sits further left and is ignored.
 *
 * Cloudflare ranges: https://www.cloudflare.com/ips/ (last changed Sep 2023). If that page
 * changes, update the two lists below.
 */
const CLOUDFLARE_IPV4 = [
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '108.162.192.0/18',
  '131.0.72.0/22',
  '141.101.64.0/18',
  '162.158.0.0/15',
  '172.64.0.0/13',
  '173.245.48.0/20',
  '188.114.96.0/20',
  '190.93.240.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
];

const CLOUDFLARE_IPV6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

export const RENDER_TRUST_PROXY: string[] = [
  'loopback',
  'linklocal',
  'uniquelocal', // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7: Render's internal network
  ...CLOUDFLARE_IPV4,
  ...CLOUDFLARE_IPV6,
];

/** TRUST_PROXY accepts a hop count from 0 to 5, or the word `render`. Anything else is invalid. */
export function parseTrustProxy(value: string): number | string[] | undefined {
  const v = value.trim().toLowerCase();
  if (v === 'render') return RENDER_TRUST_PROXY;
  if (/^[0-5]$/.test(v)) return Number(v);
  return undefined;
}
