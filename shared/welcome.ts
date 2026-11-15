// "Welcome" in the language of where you've landed, found by the place's time zone (every airport
// Terminus knows has one). English-speaking places, and zones not listed, get plain "Welcome".

export interface Welcome {
  /** The word as it's written there: "ようこそ", "Bienvenue". */
  word: string;
  /** How to say it, for scripts you may not read; empty when it's written in Latin letters. */
  roman: string;
  language: string;
}

const W = (word: string, language: string, roman = ''): Welcome => ({ word, roman, language });

const ARABIC = W('أهلاً وسهلاً', 'Arabic', 'Ahlan wa sahlan');
const MALAY = W('Selamat datang', 'Malay');
const INDONESIAN = W('Selamat datang', 'Indonesian');
const SPANISH = W('Bienvenidos', 'Spanish');
const GERMAN = W('Willkommen', 'German');
const FRENCH = W('Bienvenue', 'French');
const PORTUGUESE = W('Bem-vindo', 'Portuguese');
const MANDARIN = W('欢迎', 'Mandarin', 'Huānyíng');
const CANTONESE = W('歡迎', 'Cantonese', 'Fūnyìhng');

const BY_ZONE: Record<string, Welcome> = {
  'Asia/Tokyo': W('ようこそ', 'Japanese', 'Yōkoso'),
  'Asia/Seoul': W('환영합니다', 'Korean', 'Hwanyeonghamnida'),
  'Asia/Shanghai': MANDARIN,
  'Asia/Taipei': W('歡迎', 'Mandarin', 'Huānyíng'),
  'Asia/Hong_Kong': CANTONESE,
  'Asia/Macau': CANTONESE,
  'Asia/Bangkok': W('ยินดีต้อนรับ', 'Thai', 'Yindi tonrap'),
  'Asia/Ho_Chi_Minh': W('Chào mừng', 'Vietnamese'),
  'Asia/Phnom_Penh': W('សូមស្វាគមន៍', 'Khmer', 'Saum svagatam'),
  'Asia/Yangon': W('ကြိုဆိုပါတယ်', 'Burmese', 'Kyo so ba de'),
  'Asia/Kuala_Lumpur': MALAY,
  'Asia/Kuching': MALAY,
  'Asia/Brunei': MALAY,
  'Asia/Jakarta': INDONESIAN,
  'Asia/Makassar': INDONESIAN,
  'Asia/Pontianak': INDONESIAN,
  'Asia/Jayapura': INDONESIAN,
  'Asia/Manila': W('Maligayang pagdating', 'Filipino'),
  'Asia/Kolkata': W('स्वागत है', 'Hindi', 'Swāgat hai'),
  'Asia/Calcutta': W('स्वागत है', 'Hindi', 'Swāgat hai'),
  'Asia/Colombo': W('ආයුබෝවන්', 'Sinhala', 'Āyubōvan'),
  'Asia/Kathmandu': W('स्वागतम्', 'Nepali', 'Swāgatam'),
  'Asia/Dhaka': W('স্বাগতম', 'Bengali', 'Shagotom'),
  'Asia/Karachi': W('خوش آمدید', 'Urdu', 'Khush āmdīd'),
  'Asia/Tehran': W('خوش آمدید', 'Persian', 'Khosh āmadid'),
  'Indian/Maldives': W('މަރުޙަބާ', 'Dhivehi', 'Marhabaa'),
  'Asia/Dubai': ARABIC,
  'Asia/Qatar': ARABIC,
  'Asia/Bahrain': ARABIC,
  'Asia/Kuwait': ARABIC,
  'Asia/Muscat': ARABIC,
  'Asia/Riyadh': ARABIC,
  'Asia/Amman': ARABIC,
  'Africa/Cairo': ARABIC,
  'Asia/Jerusalem': W('ברוכים הבאים', 'Hebrew', 'Brukhim haba’im'),
  'Europe/Istanbul': W('Hoş geldiniz', 'Turkish'),
  'Asia/Istanbul': W('Hoş geldiniz', 'Turkish'),
  'Africa/Nairobi': W('Karibu', 'Swahili'),
  'Africa/Addis_Ababa': W('እንኳን ደህና መጡ', 'Amharic', 'Inkwan dehna metu'),
  'Europe/Paris': FRENCH,
  'Europe/Brussels': FRENCH,
  'Europe/Berlin': GERMAN,
  'Europe/Vienna': GERMAN,
  'Europe/Zurich': GERMAN,
  'Europe/Rome': W('Benvenuti', 'Italian'),
  'Europe/Madrid': SPANISH,
  'Europe/Lisbon': PORTUGUESE,
  'Europe/Amsterdam': W('Welkom', 'Dutch'),
  'Europe/Copenhagen': W('Velkommen', 'Danish'),
  'Europe/Oslo': W('Velkommen', 'Norwegian'),
  'Europe/Stockholm': W('Välkommen', 'Swedish'),
  'Europe/Helsinki': W('Tervetuloa', 'Finnish'),
  'Europe/Athens': W('Καλώς ήρθατε', 'Greek', 'Kalós írthate'),
  'Europe/Prague': W('Vítejte', 'Czech'),
  'Europe/Warsaw': W('Witamy', 'Polish'),
  'Europe/Budapest': W('Üdvözöljük', 'Hungarian'),
  'Europe/Moscow': W('Добро пожаловать', 'Russian', 'Dobro pozhalovat’'),
  'America/Mexico_City': SPANISH,
  'America/Bogota': SPANISH,
  'America/Lima': SPANISH,
  'America/Santiago': SPANISH,
  'America/Buenos_Aires': SPANISH,
  'America/Argentina/Buenos_Aires': SPANISH,
  'America/Sao_Paulo': PORTUGUESE,
  'Pacific/Auckland': W('Haere mai', 'Māori'),
  'Pacific/Honolulu': W('E komo mai', 'Hawaiian'),
};

/** "Welcome" where this zone is, or null where it's English (or the zone isn't known). */
export function welcomeIn(tz: string | null | undefined): Welcome | null {
  return (tz && BY_ZONE[tz]) || null;
}
