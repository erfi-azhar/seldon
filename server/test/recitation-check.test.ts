import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bareLetters, checkRecitation, sameWord } from '../../shared/recitation-check.ts';

// The ayah is 2:255 in the Uthmani text from quran.com; HEARD is what the recitation model
// transcribed from Mishary Alafasy reciting it (everyday spelling, full vowels).
const AYAH = "ٱللَّهُ لَآ إِلَـٰهَ إِلَّا هُوَ ٱلْحَىُّ ٱلْقَيُّومُ ۚ لَا تَأْخُذُهُۥ سِنَةٌ وَلَا نَوْمٌ ۚ لَّهُۥ مَا فِى ٱلسَّمَـٰوَٰتِ وَمَا فِى ٱلْأَرْضِ ۗ مَن ذَا ٱلَّذِى يَشْفَعُ عِندَهُۥٓ إِلَّا بِإِذْنِهِۦ ۚ يَعْلَمُ مَا بَيْنَ أَيْدِيهِمْ وَمَا خَلْفَهُمْ ۖ وَلَا يُحِيطُونَ بِشَىْءٍ مِّنْ عِلْمِهِۦٓ إِلَّا بِمَا شَآءَ ۚ وَسِعَ كُرْسِيُّهُ ٱلسَّمَـٰوَٰتِ وَٱلْأَرْضَ ۖ وَلَا يَـُٔودُهُۥ حِفْظُهُمَا ۚ وَهُوَ ٱلْعَلِىُّ ٱلْعَظِيمُ";
const HEARD = "اللَّهُ لَا إِلَهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ لَا تَأْخُذُهُ سِنَةٌ وَلَا نَوْمٌ لَهُ مَا فِي السَّمَاوَاتِ وَمَا فِي الْأَرْضِ مَنْ ذَا الَّذِي يَشْفَعُ عِنْدَهُ إِلَّا بِإِذْنِهِ يَعْلَمُ مَا بَيْنَ أَيْدِيهِمْ وَمَا خَلْفَهُمْ وَلَا يُحِيطُونَ بِشَيْءٍ مِنْ عِلْمِهِ إِلَّا بِمَا شَاءُ وَسِعَ كُرْسِيُّهُ السَّمَاوَاتِ وَالْأَرْضِ وَلَا يَئُودُهُ حِفْظُهُمَا وَهُوَ الْعَلِيُّ الْعَظِيمُ";

test('Uthmani and everyday spellings of the same word come out the same', () => {
  assert.equal(bareLetters('ٱلسَّمَـٰوَٰتِ'), bareLetters('السَّمَاوَاتِ'));
  assert.equal(bareLetters('لَهُۥ'), bareLetters('لَهُ'));
  assert.equal(bareLetters('شَآءَ'), bareLetters('شَاءُ'));
  assert.ok(sameWord(bareLetters('ٱلرَّحْمَـٰنِ'), bareLetters('الرَّحْمَنِ')), 'a dagger alif written out or not');
  assert.ok(sameWord(bareLetters('يَـُٔودُهُۥ'), bareLetters('يَئُودُهُ')), 'a hamza on a different seat');
  assert.ok(sameWord(bareLetters('ٱلصَّلَوٰةَ'), bareLetters('الصَّلَاةَ')));
  assert.ok(!sameWord(bareLetters('خَلْفَهُمْ'), bareLetters('خَلَقَهُمْ')), 'a different letter is a different word');
  assert.ok(!sameWord(bareLetters('لَا'), bareLetters('مَا')));
});

test('a faithful recitation matches every word; pause marks are left alone', () => {
  const r = checkRecitation(AYAH, HEARD);
  assert.deepEqual(r.counts, { ok: 50, different: 0, missed: 0, added: 0 });
  assert.ok(r.words.some((w) => w.status === 'mark'), 'the pause signs between words are kept, unmarked');
  assert.equal(r.words.map((w) => w.word).join(' '), AYAH.split(/\s+/).join(' '), 'every word of the ayah, in order');
});

test('skipped, changed, added and unfinished recitation are each found', () => {
  const words = HEARD.split(' ');
  const skipped = checkRecitation(AYAH, [...words.slice(0, 5), ...words.slice(7)].join(' '));
  // Expected words are taken from the ayah itself, so they match its exact characters.
  const tokens = AYAH.split(/\s+/);
  const token = (bare: string) => tokens.find((t) => bareLetters(t) === bare)!;
  assert.deepEqual(skipped.words.filter((w) => w.status === 'missed').map((w) => w.word), [token('الحي'), token('القيوم')]);

  const changed = checkRecitation(AYAH, HEARD.replace('خَلْفَهُمْ', 'خَلَقَهُمْ'));
  assert.deepEqual(changed.words.filter((w) => w.status === 'different').map((w) => [w.word, 'heard' in w && w.heard]), [[token('خلفهم'), 'خَلَقَهُمْ']]);

  const added = checkRecitation(AYAH, HEARD.replace('وَسِعَ', 'وَلَقَدْ وَسِعَ'));
  assert.deepEqual(added.added.map((a) => a.heard), ['وَلَقَدْ']);
  assert.equal(added.counts.ok, 50);

  const early = checkRecitation(AYAH, words.slice(0, 20).join(' '));
  assert.equal(early.counts.ok, 20);
  assert.equal(early.counts.missed, 30);

  assert.equal(checkRecitation(AYAH, '').counts.missed, 50);
});
