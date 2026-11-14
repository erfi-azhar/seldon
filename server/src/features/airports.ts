// Airports a Singapore-based traveller is likely to pass through: code → city, name
// and time zone. Anything not listed keeps whatever zone the booking gave.

export interface Airport {
  city: string;
  name: string;
  tz: string;
}

const A = (city: string, name: string, tz: string): Airport => ({ city, name, tz });

export const AIRPORTS: Record<string, Airport> = {
  SIN: A('Singapore', 'Changi', 'Asia/Singapore'),
  KUL: A('Kuala Lumpur', 'KLIA', 'Asia/Kuala_Lumpur'),
  PEN: A('Penang', 'Penang International', 'Asia/Kuala_Lumpur'),
  BKI: A('Kota Kinabalu', 'Kota Kinabalu International', 'Asia/Kuching'),
  CGK: A('Jakarta', 'Soekarno–Hatta', 'Asia/Jakarta'),
  DPS: A('Bali', 'Ngurah Rai', 'Asia/Makassar'),
  BKK: A('Bangkok', 'Suvarnabhumi', 'Asia/Bangkok'),
  HKT: A('Phuket', 'Phuket International', 'Asia/Bangkok'),
  SGN: A('Ho Chi Minh City', 'Tan Son Nhat', 'Asia/Ho_Chi_Minh'),
  HAN: A('Hanoi', 'Noi Bai', 'Asia/Ho_Chi_Minh'),
  MNL: A('Manila', 'Ninoy Aquino', 'Asia/Manila'),
  HKG: A('Hong Kong', 'Hong Kong International', 'Asia/Hong_Kong'),
  TPE: A('Taipei', 'Taoyuan', 'Asia/Taipei'),
  PVG: A('Shanghai', 'Pudong', 'Asia/Shanghai'),
  PEK: A('Beijing', 'Capital', 'Asia/Shanghai'),
  CAN: A('Guangzhou', 'Baiyun', 'Asia/Shanghai'),
  ICN: A('Seoul', 'Incheon', 'Asia/Seoul'),
  NRT: A('Tokyo', 'Narita', 'Asia/Tokyo'),
  HND: A('Tokyo', 'Haneda', 'Asia/Tokyo'),
  KIX: A('Osaka', 'Kansai', 'Asia/Tokyo'),
  FUK: A('Fukuoka', 'Fukuoka', 'Asia/Tokyo'),
  CTS: A('Sapporo', 'New Chitose', 'Asia/Tokyo'),
  DEL: A('Delhi', 'Indira Gandhi', 'Asia/Kolkata'),
  BOM: A('Mumbai', 'Chhatrapati Shivaji', 'Asia/Kolkata'),
  BLR: A('Bengaluru', 'Kempegowda', 'Asia/Kolkata'),
  MAA: A('Chennai', 'Chennai International', 'Asia/Kolkata'),
  CMB: A('Colombo', 'Bandaranaike', 'Asia/Colombo'),
  MLE: A('Malé', 'Velana', 'Indian/Maldives'),
  DXB: A('Dubai', 'Dubai International', 'Asia/Dubai'),
  AUH: A('Abu Dhabi', 'Zayed International', 'Asia/Dubai'),
  DOH: A('Doha', 'Hamad', 'Asia/Qatar'),
  JED: A('Jeddah', 'King Abdulaziz', 'Asia/Riyadh'),
  MED: A('Madinah', 'Prince Mohammad bin Abdulaziz', 'Asia/Riyadh'),
  RUH: A('Riyadh', 'King Khalid', 'Asia/Riyadh'),
  IST: A('Istanbul', 'Istanbul Airport', 'Europe/Istanbul'),
  CAI: A('Cairo', 'Cairo International', 'Africa/Cairo'),
  LHR: A('London', 'Heathrow', 'Europe/London'),
  LGW: A('London', 'Gatwick', 'Europe/London'),
  MAN: A('Manchester', 'Manchester', 'Europe/London'),
  CDG: A('Paris', 'Charles de Gaulle', 'Europe/Paris'),
  AMS: A('Amsterdam', 'Schiphol', 'Europe/Amsterdam'),
  FRA: A('Frankfurt', 'Frankfurt', 'Europe/Berlin'),
  MUC: A('Munich', 'Munich', 'Europe/Berlin'),
  ZRH: A('Zurich', 'Zurich', 'Europe/Zurich'),
  FCO: A('Rome', 'Fiumicino', 'Europe/Rome'),
  MXP: A('Milan', 'Malpensa', 'Europe/Rome'),
  BCN: A('Barcelona', 'El Prat', 'Europe/Madrid'),
  MAD: A('Madrid', 'Barajas', 'Europe/Madrid'),
  CPH: A('Copenhagen', 'Kastrup', 'Europe/Copenhagen'),
  SYD: A('Sydney', 'Kingsford Smith', 'Australia/Sydney'),
  MEL: A('Melbourne', 'Tullamarine', 'Australia/Melbourne'),
  BNE: A('Brisbane', 'Brisbane', 'Australia/Brisbane'),
  PER: A('Perth', 'Perth', 'Australia/Perth'),
  AKL: A('Auckland', 'Auckland', 'Pacific/Auckland'),
  CHC: A('Christchurch', 'Christchurch', 'Pacific/Auckland'),
  SFO: A('San Francisco', 'San Francisco International', 'America/Los_Angeles'),
  LAX: A('Los Angeles', 'LAX', 'America/Los_Angeles'),
  SEA: A('Seattle', 'Seattle–Tacoma', 'America/Los_Angeles'),
  JFK: A('New York', 'JFK', 'America/New_York'),
  EWR: A('New York', 'Newark', 'America/New_York'),
  IAH: A('Houston', 'George Bush', 'America/Chicago'),
  ORD: A('Chicago', "O'Hare", 'America/Chicago'),
  YVR: A('Vancouver', 'Vancouver', 'America/Vancouver'),
  JNB: A('Johannesburg', 'O. R. Tambo', 'Africa/Johannesburg'),
};

export const airport = (code: string): Airport | null => AIRPORTS[code.toUpperCase()] ?? null;

/** Whether Intl knows this IANA zone. */
export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A wall-clock time ("YYYY-MM-DDTHH:MM") in a zone, as an instant. */
export function zonedToUtc(local: string, tz: string): Date {
  const zone = validZone(tz) ? tz : 'UTC';
  const guess = Date.parse(`${local.slice(0, 16)}:00Z`);
  if (Number.isNaN(guess)) throw new Error(`Not a time: ${local}`);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const offset = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t);
}
