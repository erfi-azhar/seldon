// Airline tails, to tell flights apart at a glance. Star Alliance airlines use illustrated tails
// from public/tails (sources and licences in its ATTRIBUTION.md); the airlines' names, logos and
// liveries remain theirs. Other airlines get a fin drawn in their livery colours and broad
// pattern, or a neutral fin with their code.

import { useId, type ReactNode } from 'react';

/** The fin, in a 40×40 box: a raked leading edge, a near-upright trailing edge. */
const FIN = 'M7 37 L21 5 Q22 3.5 24 3.5 L32.5 3.5 Q34 3.5 33.8 5 L31 37 Z';

type Livery = { base: string; art?: ReactNode };

const stroke = (d: string, color: string, w = 3) => <path d={d} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" />;
const band = (y: number, h: number, color: string) => <rect x="0" y={y} width="40" height={h} fill={color} />;

const LIVERIES: Record<string, Livery> = {
  // Singapore Airlines: deep navy, a sweep of gold.
  SQ: { base: '#1b2a5e', art: <>{stroke('M13 30 C18 22 24 16 32 13', '#f2b51b', 3.2)}{stroke('M17 33 C21 28 26 24 32 22', '#f2b51b', 1.6)}</> },
  // Scoot: yellow, a dark flick.
  TR: { base: '#ffd200', art: stroke('M14 30 C20 26 26 20 31 12', '#1d1d1b', 2.2) },
  // Qatar Airways: burgundy, a pale sweeping curve.
  QR: { base: '#5c0a33', art: <>{stroke('M12 33 C16 22 23 14 33 9', '#e9e1e5', 2.2)}{stroke('M16 35 C20 27 26 21 33 18', '#e9e1e5', 1.2)}</> },
  // Emirates: the UAE flag across the fin.
  EK: { base: '#ffffff', art: <><rect x="0" y="0" width="17" height="40" fill="#d71921" />{band(5, 8, '#00843d')}{band(13, 8, '#ffffff')}{band(21, 16, '#111111')}<rect x="0" y="0" width="17" height="40" fill="#d71921" /></> },
  // Etihad: earth tones in facets.
  EY: { base: '#b89a5b', art: <><path d="M12 37 L26 4 L40 4 L40 37 Z" fill="#8c6d34" /><path d="M20 37 L30 14 L40 14 L40 37 Z" fill="#d7c08a" /></> },
  // Turkish Airlines: red, a white roundel.
  TK: { base: '#c70a1f', art: <circle cx="25" cy="17" r="5.5" fill="none" stroke="#fff" strokeWidth="2.2" /> },
  // Lufthansa: dark blue, a white ring.
  LH: { base: '#05164d', art: <circle cx="25" cy="17" r="5.8" fill="none" stroke="#fff" strokeWidth="1.8" /> },
  // Swiss: the Swiss cross.
  LX: { base: '#e30613', art: <><rect x="22.5" y="11" width="5" height="14" fill="#fff" /><rect x="18" y="15.5" width="14" height="5" fill="#fff" /></> },
  // Austrian: red, white band.
  OS: { base: '#e3051b', art: band(17, 6, '#ffffff') },
  // Cathay Pacific: deep green, a white brush wing.
  CX: { base: '#005d63', art: stroke('M14 28 C20 24 25 18 32 15', '#ffffff', 2.6) },
  // Malaysia Airlines: white with red and navy bands.
  MH: { base: '#ffffff', art: <><path d="M0 26 L40 10 L40 17 L0 33 Z" fill="#cc0000" /><path d="M0 33 L40 17 L40 24 L0 40 Z" fill="#00337f" /></> },
  // AirAsia: red, a white swoosh.
  AK: { base: '#ff0000', art: stroke('M13 29 C19 27 25 21 31 13', '#ffffff', 2.6) },
  // Batik Air: red with a white band.
  OD: { base: '#c8102e', art: band(20, 4, '#ffffff') },
  // Garuda Indonesia: deep blue into teal, a pale wing.
  GA: { base: '#0b4f74', art: <><path d="M0 22 L40 10 L40 40 L0 40 Z" fill="#1f8aa8" />{stroke('M14 30 C19 26 25 21 31 18', '#a9e2ef', 1.8)}</> },
  // Thai Airways: purple, magenta and gold.
  TG: { base: '#4b1e7f', art: <>{stroke('M12 32 C18 26 24 18 32 12', '#d4006f', 3)}{stroke('M16 35 C21 29 26 24 32 21', '#c9a227', 2)}</> },
  // Vietnam Airlines: teal, a gold flower.
  VN: { base: '#0a6e86', art: <circle cx="24.5" cy="18" r="4" fill="#d9a93d" /> },
  // Philippine Airlines: white with blue, red and yellow.
  PR: { base: '#ffffff', art: <><path d="M0 24 L40 14 L40 20 L0 30 Z" fill="#0038a8" /><path d="M0 30 L40 20 L40 26 L0 36 Z" fill="#ce1126" /><circle cx="27" cy="11" r="2.4" fill="#fcd116" /></> },
  // EVA Air: green with an orange band.
  BR: { base: '#00704a', art: band(19, 5, '#f39800') },
  // China Airlines: white with a pink blossom.
  CI: { base: '#ffffff', art: <circle cx="25" cy="17" r="5" fill="#e4007f" /> },
  // Shenzhen Airlines: red, a gold sweep.
  ZH: { base: '#c41230', art: <>{stroke('M13 31 C18 24 24 18 32 14', '#e5b84b', 2.8)}{stroke('M17 34 C21 29 26 25 32 23', '#e5b84b', 1.4)}</> },
  // China Southern: blue, a red flower.
  CZ: { base: '#0b4ea2', art: <circle cx="25" cy="16" r="4.6" fill="#e60012" /> },
  // China Eastern: white, red and blue.
  MU: { base: '#ffffff', art: <>{stroke('M15 28 C20 22 26 17 32 14', '#d40000', 2.6)}{stroke('M17 33 C22 28 27 24 32 22', '#16378b', 2.2)}</> },
  // Air China: white, a red emblem.
  CA: { base: '#ffffff', art: <circle cx="25" cy="16" r="4.6" fill="none" stroke="#c8102e" strokeWidth="2.4" /> },
  // ANA: dark blue with a lighter band.
  NH: { base: '#13448f', art: <path d="M0 26 L40 12 L40 18 L0 32 Z" fill="#3fa9f5" /> },
  // Japan Airlines: white, a red circle.
  JL: { base: '#ffffff', art: <circle cx="25" cy="16" r="5.6" fill="none" stroke="#e60012" strokeWidth="2.6" /> },
  // Korean Air: sky blue, a red and blue roundel.
  KE: { base: '#9fd1ee', art: <><circle cx="25" cy="17" r="5" fill="#00256c" /><path d="M20 17 A5 5 0 0 1 30 17 Z" fill="#c60c30" /></> },
  // Asiana: grey with stripes.
  OZ: { base: '#8a8d8f', art: <>{band(14, 2, '#e4002b')}{band(17, 2, '#f7a800')}{band(20, 2, '#0072bc')}</> },
  // Air India: red and gold.
  AI: { base: '#da0e29', art: band(16, 6, '#ae8c41') },
  // IndiGo: indigo, white dots.
  '6E': { base: '#001b94', art: <><circle cx="22" cy="14" r="1.6" fill="#fff" /><circle cx="26" cy="14" r="1.6" fill="#fff" /><circle cx="24" cy="18" r="1.6" fill="#fff" /><circle cx="28" cy="18" r="1.6" fill="#fff" /></> },
  // SriLankan: blue with a peacock-green sweep.
  UL: { base: '#173a7a', art: stroke('M13 31 C18 25 24 19 32 15', '#2bb673', 3) },
  // Saudia: sand and blue.
  SV: { base: '#d6c49a', art: <path d="M0 24 L40 10 L40 40 L0 40 Z" fill="#004b87" /> },
  // British Airways: the dockyard flag sweep.
  BA: { base: '#ffffff', art: <><path d="M0 22 C12 18 26 14 40 8 L40 16 C26 21 12 26 0 30 Z" fill="#c8102e" /><path d="M0 30 C12 26 26 21 40 16 L40 26 C26 30 12 34 0 38 Z" fill="#012169" /></> },
  // Air France: white with blue and red stripes.
  AF: { base: '#ffffff', art: <><path d="M10 37 L22 5 L25 5 L13 37 Z" fill="#002157" /><path d="M14 37 L26 5 L29 5 L17 37 Z" fill="#ed1c24" /></> },
  // KLM: light blue, a white crest.
  KL: { base: '#00a1de', art: stroke('M19 17 L23 14 L27 17 L31 14', '#ffffff', 2) },
  // Iberia: red, yellow, red.
  IB: { base: '#d7192d', art: band(15, 9, '#fcbc00') },
  // TAP: green and red.
  TP: { base: '#0f9d58', art: <path d="M0 26 L40 12 L40 40 L0 40 Z" fill="#e2001a" /> },
  // Ethiopian: green, yellow, red.
  ET: { base: '#078930', art: <>{band(16, 8, '#fcdd09')}{band(24, 16, '#da121a')}</> },
  // Qantas: red, a white leap.
  QF: { base: '#e40000', art: stroke('M14 30 C18 20 24 14 32 12', '#ffffff', 2.6) },
  // Air New Zealand: black, a white koru.
  NZ: { base: '#111111', art: <circle cx="25" cy="17" r="5" fill="none" stroke="#fff" strokeWidth="2" /> },
  // United: navy, a light-blue globe.
  UA: { base: '#002244', art: <><circle cx="25" cy="17" r="5.5" fill="#0e74c9" />{band(15, 1, '#002244')}{band(18, 1, '#002244')}</> },
  // American: flag stripes.
  AA: { base: '#ffffff', art: <><rect x="12" y="0" width="5" height="40" fill="#b61f23" /><rect x="22" y="0" width="5" height="40" fill="#0078d2" /></> },
  // Delta: navy with a red widget.
  DL: { base: '#003366', art: <path d="M19 26 L25 12 L31 26 Z" fill="#e01933" /> },
  // Air Canada: black, a red leaf.
  AC: { base: '#111111', art: <circle cx="25" cy="17" r="4.8" fill="#d22630" /> },
  // LATAM: indigo with a coral sweep.
  LA: { base: '#1b0088', art: stroke('M13 31 C19 26 25 19 32 13', '#ed1650', 3) },
  // GOL: orange.
  G3: { base: '#ff7020', art: stroke('M15 29 C20 25 26 20 31 15', '#ffffff', 2) },
  // Azul: blue.
  AD: { base: '#00205b', art: stroke('M15 29 C20 25 26 20 31 15', '#3ab4e6', 2.2) },
};

/**
 * How an airline's aircraft look from above, for the plane flying the route globe: the fuselage roof,
 * the fin (seen edge-on, with its accent), the engine nacelles. For Star Alliance airlines the fin
 * and accent are the two main colours of their illustrated tail, so the plane matches its card.
 */
export interface PlanePaint {
  body: string;
  fin: string;
  accent: string;
  engine: string;
}
const WHITE = '#f7f8fa';
const GREY = '#dfe3e8';
const paint = (fin: string, accent = fin, engine = GREY, body = WHITE): PlanePaint => ({ body, fin, accent, engine });
const PLANES: Record<string, PlanePaint> = {
  A3: paint('#1441bf', '#9ed4fe'),
  AV: paint('#cc0014', '#f50000'),
  AZ: paint('#1aa4e4', '#00801a'),
  CM: paint('#1d5ba9', '#f7f9fa'),
  LO: paint('#1a3171', '#ffffff'),
  MS: paint('#032351', '#13c6ee'),
  OU: paint('#fefefe', '#d3142c'),
  SA: paint('#007749', '#e1b640'),
  SN: paint('#fefefe', '#ff2c2c'),
  SQ: paint('#202254', '#e68e24'),
  TR: paint('#ffd200', '#1d1d1b', '#ffd200'),
  QR: paint('#5c0a33', '#5c0a33', GREY, '#eeebee'),
  EK: paint('#d71921', '#00843d'),
  EY: paint('#b89a5b', '#8c6d34', '#b89a5b', '#efe9dc'),
  TK: paint('#fb1919', '#ffffff'),
  LH: paint('#042552', '#ffffff', '#042552'),
  LX: paint('#fe0611', '#ffffff'),
  OS: paint('#d6211b', '#ffffff'),
  CX: paint('#005d63', '#ffffff'),
  MH: paint('#cc0000', '#00337f'),
  AK: paint('#ff0000', '#ffffff', '#ff0000'),
  OD: paint('#c8102e', '#ffffff'),
  GA: paint('#0b4f74', '#1f8aa8'),
  TG: paint('#2d1149', '#ddbd24'),
  VN: paint('#0a6e86', '#d9a93d'),
  PR: paint('#0038a8', '#ce1126'),
  BR: paint('#00a54e', '#f0451c'),
  CI: paint('#e4007f', '#ffffff'),
  ZH: paint('#bd2225', '#b7976a'),
  CZ: paint('#0b4ea2', '#e60012'),
  MU: paint('#16378b', '#d40000'),
  CA: paint('#fefefe', '#e60012'),
  NH: paint('#213f9a', '#00b3f0'),
  JL: paint('#e60012', '#ffffff'),
  KE: paint('#00256c', '#c60c30', GREY, '#a9d6f0'),
  OZ: paint('#db222e', '#e0c43f'),
  AI: paint('#f40026', '#cb8957'),
  '6E': paint('#001b94', '#ffffff', '#001b94'),
  UL: paint('#173a7a', '#2bb673'),
  SV: paint('#004b87', '#d6c49a'),
  BA: paint('#c8102e', '#012169'),
  AF: paint('#002157', '#ed1c24'),
  KL: paint('#00a1de', '#ffffff', GREY, '#2fb2e6'),
  IB: paint('#d7192d', '#fcbc00'),
  TP: paint('#bed630', '#ec1b23'),
  ET: paint('#5e8f4d', '#ffc92d'),
  QF: paint('#e40000', '#ffffff'),
  NZ: paint('#2c2c2c', '#ffffff'),
  UA: paint('#2e35bc', '#56daff', '#2e35bc'),
  AA: paint('#b61f23', '#0078d2', GREY, '#e6eaee'),
  DL: paint('#003366', '#e01933'),
  AC: paint('#1c1c1c', '#e32e2e', '#1c1c1c'),
  LA: paint('#1b0088', '#ed1650'),
  G3: paint('#ff7020', '#ffffff', '#ff7020'),
  AD: paint('#00205b', '#3ab4e6'),
};
/** An airline's paint for the globe's plane; a plain grey-tailed airliner for airlines not listed. */
export const planePaint = (code?: string): PlanePaint => PLANES[(code ?? '').toUpperCase()] ?? paint('#5b6b86', '#9aa8bd');

/**
 * Star Alliance airlines whose tails are full livery illustrations, served from /tails/<code>.svg
 * (see public/tails/ATTRIBUTION.md for where each comes from). Others get the drawn fin below.
 */
const ILLUSTRATED = new Set(['A3', 'AC', 'AI', 'AV', 'AZ', 'BR', 'CA', 'CM', 'ET', 'LH', 'LO', 'LX', 'MS', 'NH', 'NZ', 'OS', 'OU', 'OZ', 'SA', 'SN', 'SQ', 'TG', 'TK', 'TP', 'UA', 'ZH']);

/** An airline's tail on a small tile. */
export function AirlineTail({ code, size = 38 }: { code: string; size?: number }) {
  const key = code.trim().toUpperCase();
  if (ILLUSTRATED.has(key)) return <img className="airline-tail" src={`/tails/${key}.svg`} width={size} height={size} alt={`${key} tail`} draggable={false} />;
  return <DrawnTail code={key} size={size} />;
}

/** The drawn fin: the livery's colours and broad pattern, for airlines without an illustration. */
function DrawnTail({ code, size }: { code: string; size: number }) {
  const clip = `t${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const key = code;
  const livery = LIVERIES[key];
  return (
    <svg className="airline-tail" width={size} height={size} viewBox="0 0 40 40" role="img" aria-label={key ? `${key} tail` : 'Flight'}>
      <defs>
        <clipPath id={clip}>
          <path d={FIN} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect width="40" height="40" fill={livery?.base ?? '#5b6b86'} />
        {livery?.art}
        {!livery && key && (
          <text x="25" y="25" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="#fff" fontFamily="inherit">
            {key}
          </text>
        )}
      </g>
      <path d={FIN} fill="none" stroke="rgb(0 0 0 / 0.12)" strokeWidth="0.8" />
    </svg>
  );
}
