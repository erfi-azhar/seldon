// Which lounge a flight gets you into, from the cabin and your status. These are the
// published KrisFlyer, Star Alliance and Marriott Bonvoy rules in broad strokes; the
// desk has the final word, and Seldon's notes add the specific lounge at each airport.

import { bonvoyPerks, bonvoyTierAt } from '../../../shared/bonvoy.ts';
import type { LoungeAccess, LoyaltyAccount, Segment } from '../../../shared/types.ts';

export const STAR_ALLIANCE = new Set(['SQ', 'A3', 'AC', 'AI', 'NH', 'OZ', 'OS', 'AV', 'SN', 'CA', 'CM', 'OU', 'MS', 'ET', 'BR', 'LO', 'LH', 'LX', 'NZ', 'ZH', 'SA', 'TP', 'TG', 'TK', 'UA']);

const krisflyer = (accounts: LoyaltyAccount[]) => accounts.find((a) => /kris ?flyer|pps|singapore airlines/i.test(a.program));
const bonvoy = (accounts: LoyaltyAccount[]) => accounts.find((a) => /bonvoy|marriott/i.test(a.program));

export function loungeAccess(seg: Segment, accounts: LoyaltyAccount[]): LoungeAccess[] {
  if (seg.kind !== 'flight') return [];
  const out: LoungeAccess[] = [];
  const airline = seg.carrier.trim().toUpperCase().slice(0, 2);
  const cabin = seg.cabin.toLowerCase();
  const home = seg.fromCode.toUpperCase() === 'SIN';
  const sq = airline === 'SQ';
  const star = STAR_ALLIANCE.has(airline);
  const cabinName = /suite/.test(cabin) ? 'Suites' : /first/.test(cabin) ? 'First' : /business/.test(cabin) ? 'Business' : /premium/.test(cabin) ? 'Premium Economy' : 'Economy';
  const onFare = `${cabinName} on ${airline}`;

  if (cabinName === 'Suites' || cabinName === 'First') {
    if (sq && home) out.push({ access: 'The Private Room, SilverKris Lounge (Changi T3)', basis: onFare });
    else if (sq) out.push({ access: 'SilverKris Lounge, First Class section (or SQ’s designated First lounge here)', basis: onFare });
    else out.push({ access: star ? `${airline} First lounge or a Star Alliance First lounge` : `${airline}’s First Class lounge`, basis: onFare });
  } else if (cabinName === 'Business') {
    if (sq) out.push({ access: home ? 'SilverKris Lounge, Business Class (Changi)' : 'SilverKris Lounge, or SQ’s designated Business lounge here', basis: onFare });
    else out.push({ access: star ? `${airline}’s Business lounge or a Star Alliance Business lounge` : `${airline}’s Business lounge`, basis: onFare });
  }

  const kf = krisflyer(accounts);
  const tier = kf?.tier.toLowerCase() ?? '';
  if (kf && star) {
    if (/solitaire/.test(tier)) {
      if (sq) out.push({ access: home ? 'SilverKris Lounge, First Class section (Changi)' : 'SilverKris Lounge, any cabin', basis: 'Solitaire PPS Club, flying SQ' });
      out.push({ access: 'Star Alliance Gold lounges, plus one guest', basis: 'Solitaire PPS Club (Star Alliance Gold)' });
    } else if (/pps/.test(tier)) {
      if (sq) out.push({ access: home ? 'SilverKris Lounge, Business Class (Changi)' : 'SilverKris Lounge, any cabin', basis: 'PPS Club, flying SQ' });
      out.push({ access: 'Star Alliance Gold lounges, plus one guest', basis: 'PPS Club (Star Alliance Gold)' });
    } else if (/gold/.test(tier)) {
      out.push({ access: sq && home ? 'KrisFlyer Gold Lounge (Changi T2/T3), plus one guest' : 'Star Alliance Gold lounges, plus one guest', basis: 'KrisFlyer Elite Gold (Star Alliance Gold)' });
    }
  }

  for (const a of accounts.filter((x) => x.kind === 'lounge')) {
    if (/revolut/i.test(a.program)) out.push({ access: 'LoungeKey lounges, free for you (guests pay)', basis: a.program });
    else if (/lounge ?key/i.test(a.program)) out.push({ access: 'LoungeKey lounges in your terminal', basis: a.program });
    else out.push({ access: `${a.program} lounges in your terminal`, basis: a.program });
  }

  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.access) ? false : (seen.add(x.access), true)));
}

export const isMarriott = (title: string, brand = '') => MARRIOTT_BRANDS.test(`${title} ${brand}`);

/** Bonvoy tiers by elite nights in a calendar year (Ambassador also needs qualifying spend). */
export const BONVOY_TIERS: { tier: string; at: number }[] = [
  { tier: 'Silver Elite', at: 10 },
  { tier: 'Gold Elite', at: 25 },
  { tier: 'Platinum Elite', at: 50 },
  { tier: 'Titanium Elite', at: 75 },
  { tier: 'Ambassador Elite', at: 100 },
];

const MARRIOTT_BRANDS = /marriott|ritz[- ]carlton|st\.? regis|\bw (hotel|singapore|[a-z]+)|westin|sheraton|le m[eé]ridien|\bjw\b|edition|luxury collection|renaissance|courtyard|four points|aloft|moxy|autograph collection|tribute portfolio|delta hotels|fairfield|element|\bac hotel|gaylord|design hotels|protea|bulgari/i;

/** What your Bonvoy tier gets you at a Marriott-family hotel. */
/** What your Bonvoy tier gets you at a Marriott stay: the tier in force then, counting the year's nights before it. */
export function stayPerks(seg: Segment, accounts: LoyaltyAccount[], nightsBefore: number | null = null): string[] {
  if (seg.kind !== 'stay' || !MARRIOTT_BRANDS.test(`${seg.title} ${seg.carrier}`)) return [];
  return bonvoyPerks(bonvoyTierAt(bonvoy(accounts)?.tier ?? '', nightsBefore));
}
