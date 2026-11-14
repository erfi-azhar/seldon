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
  CEB: A('Cebu', 'Mactan–Cebu', 'Asia/Manila'),
  DAD: A('Da Nang', 'Da Nang International', 'Asia/Ho_Chi_Minh'),
  PNH: A('Phnom Penh', 'Techo', 'Asia/Phnom_Penh'),
  RGN: A('Yangon', 'Yangon International', 'Asia/Yangon'),
  CNX: A('Chiang Mai', 'Chiang Mai International', 'Asia/Bangkok'),
  SUB: A('Surabaya', 'Juanda', 'Asia/Jakarta'),
  LGK: A('Langkawi', 'Langkawi International', 'Asia/Kuala_Lumpur'),
  KCH: A('Kuching', 'Kuching International', 'Asia/Kuching'),
  HKG: A('Hong Kong', 'Hong Kong International', 'Asia/Hong_Kong'),
  TPE: A('Taipei', 'Taoyuan', 'Asia/Taipei'),
  PVG: A('Shanghai', 'Pudong', 'Asia/Shanghai'),
  PEK: A('Beijing', 'Capital', 'Asia/Shanghai'),
  CAN: A('Guangzhou', 'Baiyun', 'Asia/Shanghai'),
  SZX: A('Shenzhen', "Bao'an", 'Asia/Shanghai'),
  XMN: A('Xiamen', 'Gaoqi', 'Asia/Shanghai'),
  CTU: A('Chengdu', 'Shuangliu', 'Asia/Shanghai'),
  TFU: A('Chengdu', 'Tianfu', 'Asia/Shanghai'),
  HGH: A('Hangzhou', 'Xiaoshan', 'Asia/Shanghai'),
  MFM: A('Macau', 'Macau International', 'Asia/Macau'),
  ICN: A('Seoul', 'Incheon', 'Asia/Seoul'),
  NRT: A('Tokyo', 'Narita', 'Asia/Tokyo'),
  HND: A('Tokyo', 'Haneda', 'Asia/Tokyo'),
  KIX: A('Osaka', 'Kansai', 'Asia/Tokyo'),
  NGO: A('Nagoya', 'Chubu Centrair', 'Asia/Tokyo'),
  GMP: A('Seoul', 'Gimpo', 'Asia/Seoul'),
  PUS: A('Busan', 'Gimhae', 'Asia/Seoul'),
  FUK: A('Fukuoka', 'Fukuoka', 'Asia/Tokyo'),
  CTS: A('Sapporo', 'New Chitose', 'Asia/Tokyo'),
  DEL: A('Delhi', 'Indira Gandhi', 'Asia/Kolkata'),
  BOM: A('Mumbai', 'Chhatrapati Shivaji', 'Asia/Kolkata'),
  BLR: A('Bengaluru', 'Kempegowda', 'Asia/Kolkata'),
  MAA: A('Chennai', 'Chennai International', 'Asia/Kolkata'),
  CMB: A('Colombo', 'Bandaranaike', 'Asia/Colombo'),
  MLE: A('Malé', 'Velana', 'Indian/Maldives'),
  DAC: A('Dhaka', 'Hazrat Shahjalal', 'Asia/Dhaka'),
  KTM: A('Kathmandu', 'Tribhuvan', 'Asia/Kathmandu'),
  KHI: A('Karachi', 'Jinnah', 'Asia/Karachi'),
  LHE: A('Lahore', 'Allama Iqbal', 'Asia/Karachi'),
  ISB: A('Islamabad', 'Islamabad International', 'Asia/Karachi'),
  DXB: A('Dubai', 'Dubai International', 'Asia/Dubai'),
  AUH: A('Abu Dhabi', 'Zayed International', 'Asia/Dubai'),
  DOH: A('Doha', 'Hamad', 'Asia/Qatar'),
  JED: A('Jeddah', 'King Abdulaziz', 'Asia/Riyadh'),
  MED: A('Madinah', 'Prince Mohammad bin Abdulaziz', 'Asia/Riyadh'),
  RUH: A('Riyadh', 'King Khalid', 'Asia/Riyadh'),
  MCT: A('Muscat', 'Muscat International', 'Asia/Muscat'),
  BAH: A('Bahrain', 'Bahrain International', 'Asia/Bahrain'),
  KWI: A('Kuwait', 'Kuwait International', 'Asia/Kuwait'),
  AMM: A('Amman', 'Queen Alia', 'Asia/Amman'),
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
  VIE: A('Vienna', 'Vienna International', 'Europe/Vienna'),
  BRU: A('Brussels', 'Brussels', 'Europe/Brussels'),
  LIS: A('Lisbon', 'Humberto Delgado', 'Europe/Lisbon'),
  DUB: A('Dublin', 'Dublin', 'Europe/Dublin'),
  ATH: A('Athens', 'Eleftherios Venizelos', 'Europe/Athens'),
  ARN: A('Stockholm', 'Arlanda', 'Europe/Stockholm'),
  OSL: A('Oslo', 'Gardermoen', 'Europe/Oslo'),
  HEL: A('Helsinki', 'Helsinki-Vantaa', 'Europe/Helsinki'),
  SYD: A('Sydney', 'Kingsford Smith', 'Australia/Sydney'),
  MEL: A('Melbourne', 'Tullamarine', 'Australia/Melbourne'),
  BNE: A('Brisbane', 'Brisbane', 'Australia/Brisbane'),
  PER: A('Perth', 'Perth', 'Australia/Perth'),
  ADL: A('Adelaide', 'Adelaide', 'Australia/Adelaide'),
  DRW: A('Darwin', 'Darwin', 'Australia/Darwin'),
  AKL: A('Auckland', 'Auckland', 'Pacific/Auckland'),
  CHC: A('Christchurch', 'Christchurch', 'Pacific/Auckland'),
  SFO: A('San Francisco', 'San Francisco International', 'America/Los_Angeles'),
  LAX: A('Los Angeles', 'LAX', 'America/Los_Angeles'),
  SEA: A('Seattle', 'Seattle–Tacoma', 'America/Los_Angeles'),
  JFK: A('New York', 'JFK', 'America/New_York'),
  EWR: A('New York', 'Newark', 'America/New_York'),
  BOS: A('Boston', 'Logan', 'America/New_York'),
  IAD: A('Washington', 'Dulles', 'America/New_York'),
  ATL: A('Atlanta', 'Hartsfield–Jackson', 'America/New_York'),
  MIA: A('Miami', 'Miami International', 'America/New_York'),
  DFW: A('Dallas', 'Dallas/Fort Worth', 'America/Chicago'),
  DEN: A('Denver', 'Denver International', 'America/Denver'),
  HNL: A('Honolulu', 'Daniel K. Inouye', 'Pacific/Honolulu'),
  YYZ: A('Toronto', 'Pearson', 'America/Toronto'),
  MEX: A('Mexico City', 'Benito Juárez', 'America/Mexico_City'),
  BOG: A('Bogotá', 'El Dorado', 'America/Bogota'),
  LIM: A('Lima', 'Jorge Chávez', 'America/Lima'),
  GRU: A('São Paulo', 'Guarulhos', 'America/Sao_Paulo'),
  CGH: A('São Paulo', 'Congonhas', 'America/Sao_Paulo'),
  GIG: A('Rio de Janeiro', 'Galeão', 'America/Sao_Paulo'),
  EZE: A('Buenos Aires', 'Ezeiza', 'America/Argentina/Buenos_Aires'),
  SCL: A('Santiago', 'Arturo Merino Benítez', 'America/Santiago'),
  IAH: A('Houston', 'George Bush', 'America/Chicago'),
  ORD: A('Chicago', "O'Hare", 'America/Chicago'),
  YVR: A('Vancouver', 'Vancouver', 'America/Vancouver'),
  JNB: A('Johannesburg', 'O. R. Tambo', 'Africa/Johannesburg'),
  CPT: A('Cape Town', 'Cape Town International', 'Africa/Johannesburg'),
  NBO: A('Nairobi', 'Jomo Kenyatta', 'Africa/Nairobi'),
  ADD: A('Addis Ababa', 'Bole', 'Africa/Addis_Ababa'),
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

/** An instant as the wall-clock time ("YYYY-MM-DDTHH:MM") in a zone. */
export function utcToZoned(at: Date, tz: string): string {
  const zone = validZone(tz) ? tz : 'UTC';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
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
