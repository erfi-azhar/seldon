// Airports a Singapore-based traveller is likely to pass through: code → city, name
// and time zone. Anything not listed keeps whatever zone the booking gave.

export interface Airport {
  city: string;
  name: string;
  tz: string;
  /** Latitude and longitude, to the nearest hundredth of a degree: enough to draw a route. */
  lat: number;
  lon: number;
}

const A = (city: string, name: string, tz: string, lat: number, lon: number): Airport => ({ city, name, tz, lat, lon });

export const AIRPORTS: Record<string, Airport> = {
  SIN: A('Singapore', 'Changi', 'Asia/Singapore', 1.36, 103.99),
  KUL: A('Kuala Lumpur', 'KLIA', 'Asia/Kuala_Lumpur', 2.75, 101.71),
  PEN: A('Penang', 'Penang International', 'Asia/Kuala_Lumpur', 5.3, 100.28),
  BKI: A('Kota Kinabalu', 'Kota Kinabalu International', 'Asia/Kuching', 5.94, 116.05),
  CGK: A('Jakarta', 'Soekarno–Hatta', 'Asia/Jakarta', -6.13, 106.66),
  DPS: A('Bali', 'Ngurah Rai', 'Asia/Makassar', -8.75, 115.17),
  BKK: A('Bangkok', 'Suvarnabhumi', 'Asia/Bangkok', 13.69, 100.75),
  HKT: A('Phuket', 'Phuket International', 'Asia/Bangkok', 8.11, 98.32),
  SGN: A('Ho Chi Minh City', 'Tan Son Nhat', 'Asia/Ho_Chi_Minh', 10.82, 106.66),
  HAN: A('Hanoi', 'Noi Bai', 'Asia/Ho_Chi_Minh', 21.22, 105.81),
  MNL: A('Manila', 'Ninoy Aquino', 'Asia/Manila', 14.51, 121.02),
  CEB: A('Cebu', 'Mactan–Cebu', 'Asia/Manila', 10.31, 123.98),
  DAD: A('Da Nang', 'Da Nang International', 'Asia/Ho_Chi_Minh', 16.04, 108.2),
  PNH: A('Phnom Penh', 'Techo', 'Asia/Phnom_Penh', 11.32, 104.87),
  RGN: A('Yangon', 'Yangon International', 'Asia/Yangon', 16.91, 96.13),
  CNX: A('Chiang Mai', 'Chiang Mai International', 'Asia/Bangkok', 18.77, 98.96),
  SUB: A('Surabaya', 'Juanda', 'Asia/Jakarta', -7.38, 112.79),
  LGK: A('Langkawi', 'Langkawi International', 'Asia/Kuala_Lumpur', 6.33, 99.73),
  KCH: A('Kuching', 'Kuching International', 'Asia/Kuching', 1.48, 110.35),
  HKG: A('Hong Kong', 'Hong Kong International', 'Asia/Hong_Kong', 22.31, 113.92),
  TPE: A('Taipei', 'Taoyuan', 'Asia/Taipei', 25.08, 121.23),
  PVG: A('Shanghai', 'Pudong', 'Asia/Shanghai', 31.14, 121.81),
  PEK: A('Beijing', 'Capital', 'Asia/Shanghai', 40.08, 116.58),
  CAN: A('Guangzhou', 'Baiyun', 'Asia/Shanghai', 23.39, 113.3),
  SZX: A('Shenzhen', "Bao'an", 'Asia/Shanghai', 22.64, 113.81),
  XMN: A('Xiamen', 'Gaoqi', 'Asia/Shanghai', 24.54, 118.13),
  CTU: A('Chengdu', 'Shuangliu', 'Asia/Shanghai', 30.58, 103.95),
  TFU: A('Chengdu', 'Tianfu', 'Asia/Shanghai', 30.31, 104.44),
  HGH: A('Hangzhou', 'Xiaoshan', 'Asia/Shanghai', 30.23, 120.43),
  MFM: A('Macau', 'Macau International', 'Asia/Macau', 22.15, 113.59),
  ICN: A('Seoul', 'Incheon', 'Asia/Seoul', 37.46, 126.44),
  NRT: A('Tokyo', 'Narita', 'Asia/Tokyo', 35.77, 140.39),
  HND: A('Tokyo', 'Haneda', 'Asia/Tokyo', 35.55, 139.78),
  KIX: A('Osaka', 'Kansai', 'Asia/Tokyo', 34.43, 135.24),
  NGO: A('Nagoya', 'Chubu Centrair', 'Asia/Tokyo', 34.86, 136.81),
  GMP: A('Seoul', 'Gimpo', 'Asia/Seoul', 37.56, 126.79),
  PUS: A('Busan', 'Gimhae', 'Asia/Seoul', 35.18, 128.94),
  FUK: A('Fukuoka', 'Fukuoka', 'Asia/Tokyo', 33.59, 130.45),
  CTS: A('Sapporo', 'New Chitose', 'Asia/Tokyo', 42.78, 141.69),
  DEL: A('Delhi', 'Indira Gandhi', 'Asia/Kolkata', 28.56, 77.1),
  BOM: A('Mumbai', 'Chhatrapati Shivaji', 'Asia/Kolkata', 19.09, 72.87),
  BLR: A('Bengaluru', 'Kempegowda', 'Asia/Kolkata', 13.2, 77.71),
  MAA: A('Chennai', 'Chennai International', 'Asia/Kolkata', 12.99, 80.17),
  CMB: A('Colombo', 'Bandaranaike', 'Asia/Colombo', 7.18, 79.88),
  MLE: A('Malé', 'Velana', 'Indian/Maldives', 4.19, 73.53),
  DAC: A('Dhaka', 'Hazrat Shahjalal', 'Asia/Dhaka', 23.84, 90.4),
  KTM: A('Kathmandu', 'Tribhuvan', 'Asia/Kathmandu', 27.7, 85.36),
  KHI: A('Karachi', 'Jinnah', 'Asia/Karachi', 24.91, 67.16),
  LHE: A('Lahore', 'Allama Iqbal', 'Asia/Karachi', 31.52, 74.4),
  ISB: A('Islamabad', 'Islamabad International', 'Asia/Karachi', 33.55, 72.83),
  DXB: A('Dubai', 'Dubai International', 'Asia/Dubai', 25.25, 55.36),
  AUH: A('Abu Dhabi', 'Zayed International', 'Asia/Dubai', 24.43, 54.65),
  DOH: A('Doha', 'Hamad', 'Asia/Qatar', 25.27, 51.61),
  JED: A('Jeddah', 'King Abdulaziz', 'Asia/Riyadh', 21.68, 39.16),
  MED: A('Madinah', 'Prince Mohammad bin Abdulaziz', 'Asia/Riyadh', 24.55, 39.7),
  RUH: A('Riyadh', 'King Khalid', 'Asia/Riyadh', 24.96, 46.7),
  MCT: A('Muscat', 'Muscat International', 'Asia/Muscat', 23.59, 58.28),
  BAH: A('Bahrain', 'Bahrain International', 'Asia/Bahrain', 26.27, 50.63),
  KWI: A('Kuwait', 'Kuwait International', 'Asia/Kuwait', 29.24, 47.97),
  AMM: A('Amman', 'Queen Alia', 'Asia/Amman', 31.72, 35.99),
  IST: A('Istanbul', 'Istanbul Airport', 'Europe/Istanbul', 41.26, 28.74),
  CAI: A('Cairo', 'Cairo International', 'Africa/Cairo', 30.12, 31.41),
  LHR: A('London', 'Heathrow', 'Europe/London', 51.47, -0.45),
  LGW: A('London', 'Gatwick', 'Europe/London', 51.15, -0.18),
  MAN: A('Manchester', 'Manchester', 'Europe/London', 53.35, -2.27),
  CDG: A('Paris', 'Charles de Gaulle', 'Europe/Paris', 49.01, 2.55),
  AMS: A('Amsterdam', 'Schiphol', 'Europe/Amsterdam', 52.31, 4.76),
  FRA: A('Frankfurt', 'Frankfurt', 'Europe/Berlin', 50.04, 8.56),
  MUC: A('Munich', 'Munich', 'Europe/Berlin', 48.35, 11.79),
  ZRH: A('Zurich', 'Zurich', 'Europe/Zurich', 47.46, 8.55),
  FCO: A('Rome', 'Fiumicino', 'Europe/Rome', 41.8, 12.25),
  MXP: A('Milan', 'Malpensa', 'Europe/Rome', 45.63, 8.72),
  BCN: A('Barcelona', 'El Prat', 'Europe/Madrid', 41.3, 2.08),
  MAD: A('Madrid', 'Barajas', 'Europe/Madrid', 40.47, -3.56),
  CPH: A('Copenhagen', 'Kastrup', 'Europe/Copenhagen', 55.62, 12.65),
  VIE: A('Vienna', 'Vienna International', 'Europe/Vienna', 48.11, 16.57),
  BRU: A('Brussels', 'Brussels', 'Europe/Brussels', 50.9, 4.48),
  LIS: A('Lisbon', 'Humberto Delgado', 'Europe/Lisbon', 38.77, -9.13),
  DUB: A('Dublin', 'Dublin', 'Europe/Dublin', 53.43, -6.27),
  ATH: A('Athens', 'Eleftherios Venizelos', 'Europe/Athens', 37.94, 23.94),
  ARN: A('Stockholm', 'Arlanda', 'Europe/Stockholm', 59.65, 17.92),
  OSL: A('Oslo', 'Gardermoen', 'Europe/Oslo', 60.19, 11.1),
  HEL: A('Helsinki', 'Helsinki-Vantaa', 'Europe/Helsinki', 60.32, 24.96),
  SYD: A('Sydney', 'Kingsford Smith', 'Australia/Sydney', -33.94, 151.18),
  MEL: A('Melbourne', 'Tullamarine', 'Australia/Melbourne', -37.67, 144.84),
  BNE: A('Brisbane', 'Brisbane', 'Australia/Brisbane', -27.38, 153.12),
  PER: A('Perth', 'Perth', 'Australia/Perth', -31.94, 115.97),
  ADL: A('Adelaide', 'Adelaide', 'Australia/Adelaide', -34.95, 138.53),
  DRW: A('Darwin', 'Darwin', 'Australia/Darwin', -12.41, 130.88),
  AKL: A('Auckland', 'Auckland', 'Pacific/Auckland', -37.01, 174.79),
  CHC: A('Christchurch', 'Christchurch', 'Pacific/Auckland', -43.49, 172.53),
  SFO: A('San Francisco', 'San Francisco International', 'America/Los_Angeles', 37.62, -122.38),
  LAX: A('Los Angeles', 'LAX', 'America/Los_Angeles', 33.94, -118.41),
  SEA: A('Seattle', 'Seattle–Tacoma', 'America/Los_Angeles', 47.45, -122.31),
  JFK: A('New York', 'JFK', 'America/New_York', 40.64, -73.78),
  EWR: A('New York', 'Newark', 'America/New_York', 40.69, -74.17),
  BOS: A('Boston', 'Logan', 'America/New_York', 42.37, -71.01),
  IAD: A('Washington', 'Dulles', 'America/New_York', 38.95, -77.46),
  ATL: A('Atlanta', 'Hartsfield–Jackson', 'America/New_York', 33.64, -84.43),
  MIA: A('Miami', 'Miami International', 'America/New_York', 25.79, -80.29),
  DFW: A('Dallas', 'Dallas/Fort Worth', 'America/Chicago', 32.9, -97.04),
  DEN: A('Denver', 'Denver International', 'America/Denver', 39.86, -104.67),
  HNL: A('Honolulu', 'Daniel K. Inouye', 'Pacific/Honolulu', 21.32, -157.92),
  YYZ: A('Toronto', 'Pearson', 'America/Toronto', 43.68, -79.63),
  MEX: A('Mexico City', 'Benito Juárez', 'America/Mexico_City', 19.44, -99.07),
  BOG: A('Bogotá', 'El Dorado', 'America/Bogota', 4.7, -74.15),
  LIM: A('Lima', 'Jorge Chávez', 'America/Lima', -12.02, -77.11),
  GRU: A('São Paulo', 'Guarulhos', 'America/Sao_Paulo', -23.43, -46.47),
  CGH: A('São Paulo', 'Congonhas', 'America/Sao_Paulo', -23.63, -46.66),
  GIG: A('Rio de Janeiro', 'Galeão', 'America/Sao_Paulo', -22.81, -43.25),
  EZE: A('Buenos Aires', 'Ezeiza', 'America/Argentina/Buenos_Aires', -34.82, -58.54),
  SCL: A('Santiago', 'Arturo Merino Benítez', 'America/Santiago', -33.39, -70.79),
  IAH: A('Houston', 'George Bush', 'America/Chicago', 29.99, -95.34),
  ORD: A('Chicago', "O'Hare", 'America/Chicago', 41.98, -87.9),
  YVR: A('Vancouver', 'Vancouver', 'America/Vancouver', 49.19, -123.18),
  JNB: A('Johannesburg', 'O. R. Tambo', 'Africa/Johannesburg', -26.14, 28.24),
  CPT: A('Cape Town', 'Cape Town International', 'Africa/Johannesburg', -33.97, 18.6),
  NBO: A('Nairobi', 'Jomo Kenyatta', 'Africa/Nairobi', -1.32, 36.93),
  ADD: A('Addis Ababa', 'Bole', 'Africa/Addis_Ababa', 8.98, 38.8),
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
