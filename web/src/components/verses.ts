// Verses of encouragement and calm for the Faith sphere outside Ramadan.
//
// Arabic is the Uthmani (Hafs) text and English is M.A.S. Abdel Haleem's translation,
// both copied verbatim from quran.com via quran.ai. Don't edit the wording by hand:
// re-fetch it from the source if a verse is added or changed.

export interface Verse {
  /** quran.com reference, e.g. "13:28" or "94:5-6". */
  ref: string;
  surah: string;
  /** One string per ayah, verbatim. */
  arabic: string[];
  english: string;
}

export const VERSES: Verse[] = [
  {
    ref: '13:28',
    surah: 'Ar-Raʿd',
    arabic: ['ٱلَّذِينَ ءَامَنُوا۟ وَتَطْمَئِنُّ قُلُوبُهُم بِذِكْرِ ٱللَّهِ ۗ أَلَا بِذِكْرِ ٱللَّهِ تَطْمَئِنُّ ٱلْقُلُوبُ'],
    english: 'those who have faith and whose hearts find peace in the remembrance of God- truly it is in the remembrance of God that hearts find peace-',
  },
  {
    ref: '94:5-6',
    surah: 'Ash-Sharḥ',
    arabic: ['فَإِنَّ مَعَ ٱلْعُسْرِ يُسْرًا', 'إِنَّ مَعَ ٱلْعُسْرِ يُسْرًا'],
    english: 'So truly where there is hardship there is also ease; truly where there is hardship there is also ease.',
  },
  {
    ref: '2:153',
    surah: 'Al-Baqarah',
    arabic: ['يَـٰٓأَيُّهَا ٱلَّذِينَ ءَامَنُوا۟ ٱسْتَعِينُوا۟ بِٱلصَّبْرِ وَٱلصَّلَوٰةِ ۚ إِنَّ ٱللَّهَ مَعَ ٱلصَّـٰبِرِينَ'],
    english: 'You who believe, seek help through steadfastness and prayer, for God is with the steadfast.',
  },
  {
    ref: '2:186',
    surah: 'Al-Baqarah',
    arabic: ['وَإِذَا سَأَلَكَ عِبَادِى عَنِّى فَإِنِّى قَرِيبٌ ۖ أُجِيبُ دَعْوَةَ ٱلدَّاعِ إِذَا دَعَانِ ۖ فَلْيَسْتَجِيبُوا۟ لِى وَلْيُؤْمِنُوا۟ بِى لَعَلَّهُمْ يَرْشُدُونَ'],
    english: '[Prophet], if My servants ask you about Me, I am near. I respond to those who call Me, so let them respond to Me, and believe in Me, so that they may be guided.',
  },
  {
    ref: '39:53',
    surah: 'Az-Zumar',
    arabic: ['۞ قُلْ يَـٰعِبَادِىَ ٱلَّذِينَ أَسْرَفُوا۟ عَلَىٰٓ أَنفُسِهِمْ لَا تَقْنَطُوا۟ مِن رَّحْمَةِ ٱللَّهِ ۚ إِنَّ ٱللَّهَ يَغْفِرُ ٱلذُّنُوبَ جَمِيعًا ۚ إِنَّهُۥ هُوَ ٱلْغَفُورُ ٱلرَّحِيمُ'],
    english: 'Say, ‘[God says], My servants who have harmed yourselves by your own excess, do not despair of God’s mercy. God forgives all sins: He is truly the Most Forgiving, the Most Merciful.',
  },
  {
    ref: '3:139',
    surah: 'Āl ʿImrān',
    arabic: ['وَلَا تَهِنُوا۟ وَلَا تَحْزَنُوا۟ وَأَنتُمُ ٱلْأَعْلَوْنَ إِن كُنتُم مُّؤْمِنِينَ'],
    english: 'Do not lose heart or despair- if you are true believers you have the upper hand-',
  },
  {
    ref: '64:11',
    surah: 'At-Taghābun',
    arabic: ['مَآ أَصَابَ مِن مُّصِيبَةٍ إِلَّا بِإِذْنِ ٱللَّهِ ۗ وَمَن يُؤْمِنۢ بِٱللَّهِ يَهْدِ قَلْبَهُۥ ۚ وَٱللَّهُ بِكُلِّ شَىْءٍ عَلِيمٌ'],
    english: 'Misfortunes can only happen with God’s permission––He will guide the heart of anyone who believes in Him: God knows all things––',
  },
  {
    ref: '33:3',
    surah: 'Al-Aḥzāb',
    arabic: ['وَتَوَكَّلْ عَلَى ٱللَّهِ ۚ وَكَفَىٰ بِٱللَّهِ وَكِيلًا'],
    english: 'Put your trust in God: God is enough to trust.',
  },
  {
    ref: '27:62',
    surah: 'An-Naml',
    arabic: ['أَمَّن يُجِيبُ ٱلْمُضْطَرَّ إِذَا دَعَاهُ وَيَكْشِفُ ٱلسُّوٓءَ وَيَجْعَلُكُمْ خُلَفَآءَ ٱلْأَرْضِ ۗ أَءِلَـٰهٌ مَّعَ ٱللَّهِ ۚ قَلِيلًا مَّا تَذَكَّرُونَ'],
    english: 'Who is it that answers the distressed when they call upon Him? Who removes their suffering? Who makes you successors in the earth? Is it another god beside God? Little notice you take!',
  },
  {
    ref: '93:3',
    surah: 'Aḍ-Ḍuḥā',
    arabic: ['مَا وَدَّعَكَ رَبُّكَ وَمَا قَلَىٰ'],
    english: 'your Lord has not forsaken you [Prophet], nor does He hate you,',
  },
  {
    ref: '65:3',
    surah: 'Aṭ-Ṭalāq',
    arabic: ['وَيَرْزُقْهُ مِنْ حَيْثُ لَا يَحْتَسِبُ ۚ وَمَن يَتَوَكَّلْ عَلَى ٱللَّهِ فَهُوَ حَسْبُهُۥٓ ۚ إِنَّ ٱللَّهَ بَـٰلِغُ أَمْرِهِۦ ۚ قَدْ جَعَلَ ٱللَّهُ لِكُلِّ شَىْءٍ قَدْرًا'],
    english: 'and will provide for them from an unexpected source; God will be enough for those who put their trust in Him. God achieves His purpose; God has set a due measure for everything.',
  },
];

/** One verse per day, the same all day, moving through the list in order. */
export function verseIndexFor(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const days = Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000);
  return ((days % VERSES.length) + VERSES.length) % VERSES.length;
}
