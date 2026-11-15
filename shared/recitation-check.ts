// Compare what was recited (as speech recognition heard it) with the ayah's text, word by
// word. The model writes in everyday spelling with full vowels; the mushaf text is Uthmani.
// So both are reduced to bare letters first (no vowels, one alef, no Quranic marks), and two
// words count as the same when their letters are close enough. This finds words missed,
// said differently or added. It cannot judge tajweed, and it ignores vowel slips by design.

/** Bare letters: what's left once vowels, marks and spelling variants are set aside. */
export function bareLetters(word: string): string {
  return word
    .normalize('NFC')
    .replace(/ٰ/g, 'ا') // dagger alif, as in Uthmani ٱلرَّحْمَـٰنِ
    .replace(/[ٱآأإ]/g, 'ا') // alef wasla and alefs with hamza or madda
    .replace(/ـ/g, '') // tatweel
    .replace(/[ؐ-ًؚ-ٟۖ-ۭ࣓-ࣿ]/g, '') // vowels, hamza marks, Quranic signs
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ء/g, '')
    .replace(/[^ؠ-يٮ-ۓ]/g, ''); // Arabic letters only
}

// Uthmani and everyday spelling differ mostly in the long-vowel letters (an alef written or
// left out, a hamza on a different seat) and in ة written ت. Those differences cost little;
// any other letter differing is a different word (خَلْفَهُمْ is not خَلَقَهُمْ).
const SOFT = new Set(['ا', 'و', 'ي']);
const softPair = (x: string, y: string) => (SOFT.has(x) && SOFT.has(y)) || (x === 'ه' && y === 'ت') || (x === 'ت' && y === 'ه');

/** A weighted edit distance between two bare words. */
export function wordDistance(a: string, b: string): number {
  const gap = (ch: string) => (SOFT.has(ch) ? 0.3 : 1);
  const row = [0];
  for (let j = 1; j <= b.length; j++) row[j] = row[j - 1]! + gap(b[j - 1]!);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = prev + gap(a[i - 1]!);
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      const x = a[i - 1]!;
      const y = b[j - 1]!;
      row[j] = Math.min(row[j]! + gap(x), row[j - 1]! + gap(y), prev + (x === y ? 0 : softPair(x, y) ? 0.3 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** Up to this distance, two words are the same word written two ways. */
export const SAME = 0.6;
export const sameWord = (a: string, b: string) => wordDistance(a, b) <= SAME;

export type WordResult =
  | { status: 'ok'; word: string }
  | { status: 'different'; word: string; heard: string }
  | { status: 'missed'; word: string }
  /** Not a word: a pause mark or other sign between words, shown as it is. */
  | { status: 'mark'; word: string };

export interface CheckResult {
  /** Every word of the ayah in order, each with what happened to it. */
  words: WordResult[];
  /** Words that were said but aren't in the ayah, and the index of the ayah word they came after (-1: before the first). */
  added: { heard: string; after: number }[];
  counts: { ok: number; different: number; missed: number; added: number };
}

/** Line up the ayah's words with what was heard (an edit-distance alignment over words). */
export function checkRecitation(ayah: string, heard: string): CheckResult {
  const tokens = ayah.split(/\s+/).filter(Boolean);
  const ref = tokens.map((w, i) => ({ i, w, bare: bareLetters(w) })).filter((x) => x.bare);
  const hyp = heard
    .split(/\s+/)
    .map((w) => ({ w, bare: bareLetters(w) }))
    .filter((x) => x.bare);
  const n = ref.length;
  const m = hyp.length;
  // cost[i][j]: the cheapest way to line up the first i ayah words with the first j heard.
  const cost: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  // The same word costs next to nothing; a different word in its place costs a little more
  // than a missed one would, but less than a miss and an addition together.
  const sub = (i: number, j: number) => {
    const d = wordDistance(ref[i]!.bare, hyp[j]!.bare);
    return d <= SAME ? d * 0.5 : 1.1;
  };
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) cost[i]![j] = Math.min(cost[i - 1]![j]! + 1, cost[i]![j - 1]! + 1, cost[i - 1]![j - 1]! + sub(i - 1, j - 1));

  const status = new Map<number, WordResult>();
  const added: CheckResult['added'] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i]![j] === cost[i - 1]![j - 1]! + sub(i - 1, j - 1)) {
      const r = ref[i - 1]!;
      const h = hyp[j - 1]!;
      status.set(r.i, sameWord(r.bare, h.bare) ? { status: 'ok', word: r.w } : { status: 'different', word: r.w, heard: h.w });
      i--;
      j--;
    } else if (i > 0 && (j === 0 || cost[i]![j] === cost[i - 1]![j]! + 1)) {
      const r = ref[i - 1]!;
      status.set(r.i, { status: 'missed', word: r.w });
      i--;
    } else {
      added.unshift({ heard: hyp[j - 1]!.w, after: i > 0 ? ref[i - 1]!.i : -1 });
      j--;
    }
  }
  const words = tokens.map((w, k): WordResult => status.get(k) ?? { status: 'mark', word: w });
  const count = (s: WordResult['status']) => words.filter((x) => x.status === s).length;
  return { words, added, counts: { ok: count('ok'), different: count('different'), missed: count('missed'), added: added.length } };
}
