import type { Server } from 'node:http';

/**
 * Node closes a kept-alive connection after 5 seconds of silence by default. The proxies in front of
 * the API (Render's, Cloudflare's) keep such connections around for about a minute, so now and then
 * they reuse one that Node has just closed and the visitor gets a 502 for a request that was fine.
 * Keeping our timeout longer than theirs removes that race.
 */
export function applyServerTimeouts(server: Server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000; // must be larger than keepAliveTimeout
  return server;
}
