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
  /** One of the seven saving verses (al-āyāt al-munjiyāt), recited as a set. */
  munjiyat?: boolean;
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
  // The seven saving verses (al-āyāt al-munjiyāt), in the order they are recited.
  {
    ref: '9:51',
    surah: 'At-Tawbah',
    munjiyat: true,
    arabic: ['قُل لَّن يُصِيبَنَآ إِلَّا مَا كَتَبَ ٱللَّهُ لَنَا هُوَ مَوْلَىٰنَا ۚ وَعَلَى ٱللَّهِ فَلْيَتَوَكَّلِ ٱلْمُؤْمِنُونَ'],
    english: 'Say, ‘Only what God has decreed will happen to us. He is our Master: let the believers put their trust in God.’',
  },
  {
    ref: '10:107',
    surah: 'Yūnus',
    munjiyat: true,
    arabic: ['وَإِن يَمْسَسْكَ ٱللَّهُ بِضُرٍّ فَلَا كَاشِفَ لَهُۥٓ إِلَّا هُوَ ۖ وَإِن يُرِدْكَ بِخَيْرٍ فَلَا رَآدَّ لِفَضْلِهِۦ ۚ يُصِيبُ بِهِۦ مَن يَشَآءُ مِنْ عِبَادِهِۦ ۚ وَهُوَ ٱلْغَفُورُ ٱلرَّحِيمُ'],
    english: 'If God inflicts harm on you, no one can remove it but Him, and if He intends good for you, no one can turn His bounty away; He grants His bounty to any of His servants He will. He is the Most Forgiving, the Most Merciful.',
  },
  {
    ref: '11:6',
    surah: 'Hūd',
    munjiyat: true,
    arabic: ['۞ وَمَا مِن دَآبَّةٍ فِى ٱلْأَرْضِ إِلَّا عَلَى ٱللَّهِ رِزْقُهَا وَيَعْلَمُ مُسْتَقَرَّهَا وَمُسْتَوْدَعَهَا ۚ كُلٌّ فِى كِتَـٰبٍ مُّبِينٍ'],
    english: 'There is not a creature that moves on earth whose provision is not His concern. He knows where it lives and its [final] resting place: it is all [there] in a clear record.',
  },
  {
    ref: '11:56',
    surah: 'Hūd',
    munjiyat: true,
    arabic: ['إِنِّى تَوَكَّلْتُ عَلَى ٱللَّهِ رَبِّى وَرَبِّكُم ۚ مَّا مِن دَآبَّةٍ إِلَّا هُوَ ءَاخِذٌۢ بِنَاصِيَتِهَآ ۚ إِنَّ رَبِّى عَلَىٰ صِرَٰطٍ مُّسْتَقِيمٍ'],
    english: 'I put my trust in God, my Lord and your Lord. There is no moving creature which He does not control. My Lord’s way is straight.',
  },
  {
    ref: '29:60',
    surah: 'Al-ʿAnkabūt',
    munjiyat: true,
    arabic: ['وَكَأَيِّن مِّن دَآبَّةٍ لَّا تَحْمِلُ رِزْقَهَا ٱللَّهُ يَرْزُقُهَا وَإِيَّاكُمْ ۚ وَهُوَ ٱلسَّمِيعُ ٱلْعَلِيمُ'],
    english: 'How many are the creatures who do not store their sustenance! God sustains them and you: He alone is the All Hearing, the All Knowing.',
  },
  {
    ref: '35:2',
    surah: 'Fāṭir',
    munjiyat: true,
    arabic: ['مَّا يَفْتَحِ ٱللَّهُ لِلنَّاسِ مِن رَّحْمَةٍ فَلَا مُمْسِكَ لَهَا ۖ وَمَا يُمْسِكْ فَلَا مُرْسِلَ لَهُۥ مِنۢ بَعْدِهِۦ ۚ وَهُوَ ٱلْعَزِيزُ ٱلْحَكِيمُ'],
    english: 'No one can withhold the blessing God opens up for people, nor can anyone but Him release whatever He withholds: He is the Almighty, the All Wise.',
  },
  {
    ref: '39:38',
    surah: 'Az-Zumar',
    munjiyat: true,
    arabic: ['وَلَئِن سَأَلْتَهُم مَّنْ خَلَقَ ٱلسَّمَـٰوَٰتِ وَٱلْأَرْضَ لَيَقُولُنَّ ٱللَّهُ ۚ قُلْ أَفَرَءَيْتُم مَّا تَدْعُونَ مِن دُونِ ٱللَّهِ إِنْ أَرَادَنِىَ ٱللَّهُ بِضُرٍّ هَلْ هُنَّ كَـٰشِفَـٰتُ ضُرِّهِۦٓ أَوْ أَرَادَنِى بِرَحْمَةٍ هَلْ هُنَّ مُمْسِكَـٰتُ رَحْمَتِهِۦ ۚ قُلْ حَسْبِىَ ٱللَّهُ ۖ عَلَيْهِ يَتَوَكَّلُ ٱلْمُتَوَكِّلُونَ'],
    english: 'If you [Prophet] ask them, ‘Who created the heavens and earth?’ they are sure to answer, ‘God,’ so say, ‘Consider those you invoke beside Him: if God wished to harm me, could they undo that harm? If God wished to show me mercy, could they withhold that mercy?’ Say, ‘God is enough for me: all those who trust should put their trust in Him.’',
  },
];

/** Where each of the seven saving verses sits in VERSES, in recitation order. */
export const MUNJIYAT = VERSES.flatMap((v, i) => (v.munjiyat ? [i] : []));

/** One verse per day, the same all day, moving through the list in order. */
export function verseIndexFor(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const days = Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000);
  return ((days % VERSES.length) + VERSES.length) % VERSES.length;
}
