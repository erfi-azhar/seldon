// Long layovers: whether there is time to leave the airport, and what to do if so.
//
// "Long" is about the time you would actually have outside, not the wait itself: take off getting
// out (passport control), the ride into the centre and back, and being back two hours before an
// international flight (75 minutes before a domestic one). Two and a half hours or more left
// over is worth going out for; an hour or more is possible but tight; less, stay airside.
//
// The guides below cover hubs a Singapore-based traveller is likely to change planes at. The
// facts are the broad, stable ones (how to get to the centre and roughly how long; sights that
// don't move); times and entry rules change, so the sheet says to check.

import type { Segment } from '../../shared/types.ts';

export interface Idea {
  title: string;
  note: string;
  /** Only worth mentioning in these months (1–12), with a day range for seasonal things. */
  season?: { from: [number, number]; to: [number, number] };
}

export interface Guide {
  city: string;
  /** Minutes from landing to being out of the airport (passport control, no bags to collect). */
  exit: number;
  toCity: { how: string; minutes: number; to: string };
  ideas: Idea[];
  dayRoom?: string;
  /** What to know about leaving the airport (entry rules). */
  entry: string;
}

const SCHENGEN = 'Leaving the airport means entering the Schengen area: fine on a passport that is visa-free for Schengen, and you clear passport control again on the way back.';

export const GUIDES: Record<string, Guide> = {
  FRA: {
    city: 'Frankfurt',
    exit: 45,
    toCity: { how: 'S-Bahn S8 or S9 from the regional station under Terminal 1', minutes: 15, to: 'Hauptwache, the centre' },
    ideas: [
      { title: 'Römerberg and the old town', note: 'The rebuilt half-timbered square and the cathedral, ten minutes’ walk from Hauptwache.' },
      { title: 'Christmas market', note: 'On the Römerberg and around Paulsplatz until just before Christmas; busy from mid-afternoon at weekends.', season: { from: [11, 20], to: [12, 23] } },
      { title: 'The Main and the Museumsufer', note: 'Cross the Eiserner Steg footbridge to the museum embankment; the Städel art museum is a short walk along it.' },
      { title: 'Halal food', note: 'Turkish and Middle Eastern places around the Hauptbahnhof (Münchener Straße) and off the Zeil.' },
    ],
    dayRoom: 'The Sheraton and the Hilton at The Squaire are connected to Terminal 1 and sell day rooms: a bed and a shower without going into town.',
    entry: SCHENGEN,
  },
  ZRH: {
    city: 'Zurich',
    exit: 40,
    toCity: { how: 'Train from the station under the airport', minutes: 12, to: 'Zürich HB' },
    ideas: [
      { title: 'The old town and the lake', note: 'Walk from the station down Bahnhofstrasse to the lake, then back through the lanes of the Altstadt.' },
      { title: 'Christmas markets', note: 'Inside Zürich HB and on Sechseläutenplatz by the opera house.', season: { from: [11, 20], to: [12, 24] } },
    ],
    dayRoom: 'The Radisson Blu is a short walk from the terminals and sells day rooms.',
    entry: SCHENGEN,
  },
  MUC: {
    city: 'Munich',
    exit: 45,
    toCity: { how: 'S-Bahn S1 or S8', minutes: 40, to: 'Marienplatz' },
    ideas: [
      { title: 'Marienplatz and the Viktualienmarkt', note: 'The town hall square and the food market next to it.' },
      { title: 'Christmas market', note: 'Around Marienplatz, the city’s main one.', season: { from: [11, 20], to: [12, 24] } },
    ],
    dayRoom: 'The Hilton Munich Airport sits between the two terminals and sells day rooms.',
    entry: SCHENGEN,
  },
  IST: {
    city: 'Istanbul',
    exit: 45,
    toCity: { how: 'Havaist bus or metro (M11, then M2)', minutes: 75, to: 'Sultanahmet, the old city' },
    ideas: [
      { title: 'Touristanbul', note: 'Turkish Airlines’ free city tour for international transfer passengers on its own flights with a layover of roughly 6 to 24 hours; ask at the Touristanbul desk in arrivals.' },
      { title: 'The Blue Mosque and Hagia Sophia', note: 'Side by side in Sultanahmet: pray at the Sultan Ahmed Mosque.' },
      { title: 'The Grand Bazaar', note: 'A short walk from Sultanahmet; closed on Sundays.' },
    ],
    dayRoom: 'YOTELAir is airside in the terminal, by the hour, so you need not go through passport control.',
    entry: 'Whether you can leave the airport depends on your passport: some need an e-visa for Turkey.',
  },
  DOH: {
    city: 'Doha',
    exit: 40,
    toCity: { how: 'Doha Metro Red Line', minutes: 25, to: 'Msheireb, for Souq Waqif' },
    ideas: [
      { title: 'Museum of Islamic Art', note: 'On the Corniche, with a park and the skyline across the bay.' },
      { title: 'Souq Waqif', note: 'The old market, lively in the evening; halal food everywhere.' },
    ],
    dayRoom: 'The Oryx Airport Hotel is airside in the terminal, by the hour.',
    entry: 'Many passports get visa-free entry to Qatar on arrival; check yours.',
  },
  DXB: {
    city: 'Dubai',
    exit: 45,
    toCity: { how: 'Dubai Metro Red Line', minutes: 30, to: 'Burj Khalifa/Dubai Mall' },
    ideas: [
      { title: 'Burj Khalifa and the fountains', note: 'The fountain shows run every half hour in the evening.' },
      { title: 'Old Dubai and the creek', note: 'Cross by abra between the souks of Deira and Bur Dubai.' },
    ],
    dayRoom: 'The Dubai International Hotel is airside in the terminals, by the hour.',
    entry: 'Many passports get a visa on arrival in the UAE; check yours.',
  },
  HKG: {
    city: 'Hong Kong',
    exit: 35,
    toCity: { how: 'Airport Express', minutes: 25, to: 'Hong Kong station, Central' },
    ideas: [
      { title: 'The Star Ferry and the harbour', note: 'Cross from Central to Tsim Sha Tsui for the skyline.' },
      { title: 'The Peak', note: 'The tram up from Central, if the queue is short.' },
    ],
    dayRoom: 'The Regal Airport Hotel is linked to the terminal and sells day rooms.',
    entry: 'Many passports enter Hong Kong visa-free; check yours.',
  },
  LHR: {
    city: 'London',
    exit: 60,
    toCity: { how: 'Heathrow Express', minutes: 20, to: 'Paddington' },
    ideas: [
      { title: 'Hyde Park and Kensington', note: 'A walk from Paddington; the museums in South Kensington are free.' },
      { title: 'The South Bank', note: 'Westminster to Tower Bridge along the river.' },
    ],
    dayRoom: 'Several airport hotels sell day rooms; the Sofitel is linked to Terminal 5.',
    entry: 'Leaving the airport means entering the UK: most visitors now need an Electronic Travel Authorisation (ETA) first.',
  },
  CDG: {
    city: 'Paris',
    exit: 45,
    toCity: { how: 'RER B', minutes: 40, to: 'Châtelet–Les Halles' },
    ideas: [
      { title: 'The Seine and Notre-Dame', note: 'From Châtelet it is a short walk to the Île de la Cité.' },
      { title: 'The Marais', note: 'Old streets, cafés and the Place des Vosges.' },
    ],
    dayRoom: 'The Sheraton is inside Terminal 2 and sells day rooms.',
    entry: SCHENGEN,
  },
  AMS: {
    city: 'Amsterdam',
    exit: 40,
    toCity: { how: 'Train from the station under Schiphol Plaza', minutes: 17, to: 'Amsterdam Centraal' },
    ideas: [
      { title: 'The canal ring', note: 'Walk the Jordaan and the canals, or take a canal boat from near Centraal.' },
      { title: 'The Rijksmuseum', note: 'Book a time slot ahead.' },
    ],
    dayRoom: 'YOTELAir is airside past security, by the hour.',
    entry: SCHENGEN,
  },
  ICN: {
    city: 'Seoul',
    exit: 45,
    toCity: { how: 'AREX express train', minutes: 45, to: 'Seoul Station' },
    ideas: [
      { title: 'Transit tours', note: 'Incheon Airport runs free transit tours for passengers with a long layover; ask at the transit tour desk.' },
      { title: 'Gyeongbokgung and Bukchon', note: 'The palace and the hanok village beside it.' },
    ],
    dayRoom: 'Darakhyu, the capsule hotel airside in the terminals, by the hour.',
    entry: 'Many passports need a K-ETA to enter Korea; check yours.',
  },
  SIN: {
    city: 'Singapore',
    exit: 30,
    toCity: { how: 'MRT, or a taxi', minutes: 30, to: 'the city' },
    ideas: [
      { title: 'Jewel', note: 'The Rain Vortex and the indoor forest, linked to Terminals 1–3 (outside immigration).' },
      { title: 'Gardens by the Bay', note: 'The Supertrees and the domes, about 25 minutes by taxi.' },
    ],
    dayRoom: 'The Aerotel and Ambassador Transit Hotels are airside, by the hour.',
    entry: 'Many passports enter Singapore visa-free; check yours.',
  },
};

export interface LayoverPlan {
  /** Minutes on the ground between the two flights. */
  wait: number;
  /** Connecting at your home airport: the choice is going home, not sightseeing. */
  atHome: boolean;
  verdict: 'out' | 'tight' | 'stay';
  /** Instants (ms): out of the airport, in the centre, leave the centre, back at the airport. */
  outBy: number;
  inCity: number;
  leaveCity: number;
  backBy: number;
  /** Minutes you'd have in the centre (or at home). */
  free: number;
  guide?: Guide;
  ideas: Idea[];
}

const MIN = 60_000;

/** Whether, and how long, you could leave the airport between two flights. */
export function layoverPlan(from: Segment, to: Segment, home: string): LayoverPlan {
  const land = Date.parse(from.endUtc);
  const leave = Date.parse(to.startUtc);
  const atHome = to.fromCode === home;
  const guide = GUIDES[to.fromCode];
  const exit = guide?.exit ?? 60;
  const ride = atHome ? 40 : (guide?.toCity.minutes ?? 45);
  const domestic = !!to.startTz && to.startTz === to.endTz;
  const outBy = land + exit * MIN;
  const inCity = outBy + ride * MIN;
  const backBy = leave - (domestic ? 75 : 120) * MIN;
  const leaveCity = backBy - ride * MIN;
  const free = Math.round((leaveCity - inCity) / MIN);
  const verdict = free >= 150 ? 'out' : free >= 60 ? 'tight' : 'stay';
  // Seasonal ideas only when the layover falls in their season.
  const day = new Date(land);
  const md = (day.getUTCMonth() + 1) * 100 + day.getUTCDate();
  const ideas = (guide?.ideas ?? []).filter((i) => !i.season || (md >= i.season.from[0] * 100 + i.season.from[1] && md <= i.season.to[0] * 100 + i.season.to[1]));
  return { wait: Math.round((leave - land) / MIN), atHome, verdict, outBy, inCity, leaveCity, backBy, free, guide, ideas };
}
