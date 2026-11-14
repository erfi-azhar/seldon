// Fetch a public web page or file on the person's behalf, safely.
//
// Links come from outside, so a fetch must never reach this machine or its network:
// every address a hostname resolves to is checked on the actual connection (not in a
// separate lookup that could change), on every redirect. Bodies are size-capped.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchError';
  }
}

/** Private, loopback, link-local, carrier-grade NAT, multicast and other non-public ranges. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && ip.startsWith('192.0.0.')) || ip.startsWith('192.0.2.'))) return false;
    if (a === 198 && (b === 18 || b === 19 || ip.startsWith('198.51.100.'))) return false;
    if (ip.startsWith('203.0.113.')) return false;
    if (a >= 224) return false;
    return true;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return false;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || x.startsWith('2001:db8') || x.startsWith('64:ff9b')) return false;
    return true;
  }
  return false;
}

const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || list.length === 0) return callback(new FetchError(`${hostname} is not a public address`) as NodeJS.ErrnoException, '', 4);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface Fetched {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
}

/** Tests can allow local servers. */
let allowPrivate = false;
export function allowPrivateAddressesForTests(on: boolean): void {
  allowPrivate = on;
}

export async function safeFetch(raw: string, opts: { maxBytes?: number; timeoutMs?: number; accept?: string } = {}): Promise<Fetched> {
  const maxBytes = opts.maxBytes ?? 3_000_000;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError('That is not a valid link');
  }
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('Only http and https links can be fetched');
    if (url.username || url.password) throw new FetchError('Links with credentials are not fetched');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && isIP(host) && !isPublicAddress(host)) throw new FetchError(`${host} is not a public address`);
    const res = await once(url, maxBytes, opts.timeoutMs ?? 12_000, opts.accept);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, url);
      continue;
    }
    return { url: url.toString(), status: res.status, contentType: res.contentType, body: res.body };
  }
  throw new FetchError('Too many redirects');
}

function once(url: URL, maxBytes: number, timeoutMs: number, accept?: string): Promise<{ status: number; contentType: string; location?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        lookup: allowPrivate ? undefined : guardedLookup,
        timeout: timeoutMs,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; Terminus/0.2; personal link reader)',
          accept: accept ?? 'text/html,application/xhtml+xml,application/json,image/*;q=0.9,*/*;q=0.5',
          'accept-language': 'en',
          'accept-encoding': 'identity',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, contentType: '', location: res.headers.location, body: Buffer.alloc(0) });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new FetchError('That page is too large to read'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, contentType: String(res.headers['content-type'] ?? '').toLowerCase(), body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new FetchError('The site took too long to answer')));
    req.on('error', (err) => reject(err instanceof FetchError ? err : new FetchError(`Could not fetch that link: ${err.message}`)));
    req.end();
  });
}
