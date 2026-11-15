// Recitation: plays ayat aloud, one after another, for the verse card and Quran study.

import { LoaderCircle, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export const arabicDigits = (n: number) => String(n).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]!);

// Verse-by-verse recitation by Mishary Rashid Alafasy. quran.com's audio host comes first;
// everyayah.com serves the same files and is tried if it fails.
export const RECITER = 'Mishary Alafasy';
export const audioSources = (surah: number, ayah: number): string[] => {
  const file = `${String(surah).padStart(3, '0')}${String(ayah).padStart(3, '0')}.mp3`;
  return [`https://verses.quran.com/Alafasy/mp3/${file}`, `https://everyayah.com/data/Alafasy_128kbps/${file}`];
};

/** One ayah to recite. `verse` lets a card follow along: an index into its own list. */
export type Track = { surah: number; ayah: number; verse: number };
export type Playback =
  | { state: 'idle' }
  | { state: 'loading' | 'playing' | 'paused'; track: Track; set: string }
  | { state: 'error' };

/**
 * Plays a list of ayat one after another, falling back to the second host when the first
 * fails. `set` names what is playing (one verse, or all seven), so a button knows its own.
 */
export function useRecitation() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [pb, setPb] = useState<Playback>({ state: 'idle' });

  const stop = () => {
    const a = audio.current;
    if (a) {
      a.onended = a.onerror = a.onplaying = a.onwaiting = null;
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    audio.current = null;
  };
  useEffect(() => stop, []);

  const playAt = (tracks: Track[], i: number, set: string, source = 0) => {
    stop();
    const track = tracks[i]!;
    const a = new Audio(audioSources(track.surah, track.ayah)[source]);
    audio.current = a;
    setPb({ state: 'loading', track, set });
    a.onplaying = () => setPb({ state: 'playing', track, set });
    a.onwaiting = () => setPb({ state: 'loading', track, set });
    a.onended = () => (i + 1 < tracks.length ? playAt(tracks, i + 1, set) : (stop(), setPb({ state: 'idle' })));
    a.onerror = () => (source === 0 ? playAt(tracks, i, set, 1) : (stop(), setPb({ state: 'error' })));
    a.play().catch((e: unknown) => {
      // Autoplay refusals are reported here; load failures arrive via onerror.
      if (e instanceof DOMException && e.name === 'NotAllowedError') (stop(), setPb({ state: 'idle' }));
    });
  };

  /** Start `set`, or pause and resume it if it is the one already going. */
  const toggle = (set: string, tracks: Track[]) => {
    const a = audio.current;
    const mine = (pb.state === 'playing' || pb.state === 'paused' || pb.state === 'loading') && pb.set === set;
    if (mine && pb.state === 'playing' && a) {
      a.pause();
      setPb({ ...pb, state: 'paused' });
    } else if (mine && pb.state === 'paused' && a) {
      void a.play().catch(() => setPb({ state: 'error' }));
    } else if (!(mine && pb.state === 'loading')) playAt(tracks, 0, set);
  };

  const halt = () => {
    stop();
    setPb({ state: 'idle' });
  };

  return { pb, toggle, halt };
}

export function PlayIcon({ state }: { state: 'loading' | 'playing' | 'other' }) {
  if (state === 'loading') return <LoaderCircle size={15} className="spin" />;
  if (state === 'playing') return <Pause size={15} fill="currentColor" strokeWidth={0} />;
  return <Play size={15} fill="currentColor" strokeWidth={0} />;
}

