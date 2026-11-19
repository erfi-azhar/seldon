// Marriott Bonvoy's tiers and what each gets you at a hotel, shared by the server (a stay's perks) and the web
// (the Bonvoy panel on a trip). Tiers come from elite nights in a calendar year.

export const BONVOY_TIERS = [
  { tier: 'Silver Elite', at: 10 },
  { tier: 'Gold Elite', at: 25 },
  { tier: 'Platinum Elite', at: 50 },
  { tier: 'Titanium Elite', at: 75 },
  { tier: 'Ambassador Elite', at: 100 },
] as const;

export const BONVOY_ORDER: string[] = ['Member', ...BONVOY_TIERS.map((t) => t.tier)];

/** The tier in force at a stay: the card's, or a higher one the year's nights before the stay have already reached. */
export function bonvoyTierAt(cardTier: string, nightsBefore: number | null): string {
  const card = BONVOY_ORDER.find((t) => t.toLowerCase() === cardTier.trim().toLowerCase()) ?? (BONVOY_ORDER.find((t) => cardTier.toLowerCase().includes(t.split(' ')[0]!.toLowerCase())) || 'Member');
  const byNights = nightsBefore === null ? 'Member' : ([...BONVOY_TIERS].reverse().find((t) => nightsBefore >= t.at)?.tier ?? 'Member');
  return BONVOY_ORDER.indexOf(byNights) > BONVOY_ORDER.indexOf(card) ? byNights : card;
}

/** What a tier gets you on a stay, most useful first. */
export function bonvoyPerks(tier: string): string[] {
  const t = tier.toLowerCase();
  if (/ambassador/.test(t)) return ['Executive lounge and breakfast', 'Ambassador service and 24-hour check-in', '4pm late checkout', 'Best-available upgrade'];
  if (/titanium|platinum/.test(t)) return ['Executive lounge and breakfast', '4pm late checkout', 'Upgrade, suites included when available'];
  if (/gold/.test(t)) return ['2pm late checkout', 'Enhanced room upgrade', 'Welcome points'];
  if (/silver/.test(t)) return ['Priority late checkout'];
  return [];
}
