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
    // Compare numerically: the same address has many spellings (the URL parser turns
    // [::ffff:127.0.0.1] into [::ffff:7f00:1]), so string prefixes are not enough.
    const h = hextets(ip);
    const v4 = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    if (h.slice(0, 4).every((x) => x === 0)) {
      // ::/64 holds the unspecified and loopback addresses and the forms that carry an
      // IPv4 address (mapped ::ffff:a.b.c.d, translated ::ffff:0:a.b.c.d, compatible ::a.b.c.d).
      const embedsV4 = (h[4] === 0 && (h[5] === 0 || h[5] === 0xffff)) || (h[4] === 0xffff && h[5] === 0);
      return embedsV4 && isPublicAddress(v4(h[6]!, h[7]!));
    }
    const [a, b] = h as [number, number];
    if (a === 0x2002) return isPublicAddress(v4(b, h[2]!)); // 6to4 carries an IPv4 address
    if (a === 0x64 && b === 0xff9b) return false; // NAT64 can reach IPv4 networks behind it
    if (a === 0x100 && h.slice(1, 4).every((x) => x === 0)) return false; // discard-only
    if (a === 0x2001 && (b < 0x200 || b === 0xdb8)) return false; // Teredo and other special use, documentation
    if ((a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0 || (a & 0xff00) === 0xff00) return false;
    return true;
  }
  return false;
}

/** A valid IPv6 address as its eight 16-bit groups. */
function hextets(ip: string): number[] {
  let s = ip.toLowerCase();
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [, a, b, c, d] = dotted.map(Number) as [number, number, number, number, number];
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.map((g) => parseInt(g, 16));
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
  // One deadline for the whole fetch, redirects included: a socket timeout alone only
  // notices silence, and a page that drips a byte at a time would never trip it.
  const deadline = Date.now() + (opts.timeoutMs ?? 12_000);
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
    const res = await once(url, maxBytes, deadline, opts.accept);
    if (res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, url);
      continue;
    }
    return { url: url.toString(), status: res.status, contentType: res.contentType, body: res.body };
  }
  throw new FetchError('Too many redirects');
}

function once(url: URL, maxBytes: number, deadline: number, accept?: string): Promise<{ status: number; contentType: string; location?: string; body: Buffer }> {
  return new Promise((done, fail) => {
    const timeoutMs = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => {
      reject(new FetchError('The site took too long to answer'));
      req.destroy();
    }, timeoutMs);
    const resolve: typeof done = (v) => (clearTimeout(timer), done(v));
    const reject = (err: unknown): void => (clearTimeout(timer), fail(err));
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        lookup: allowPrivate ? undefined : guardedLookup,
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
    req.on('error', (err) => reject(err instanceof FetchError ? err : new FetchError(`Could not fetch that link: ${err.message}`)));
    req.end();
  });
}
