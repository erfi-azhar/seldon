// Recite an ayah from memory into the microphone and see which words matched. Recording and
// recognition both happen on this device: the audio never leaves it. Speech recognition
// (Tarteel's Quran model) turns the recording into words, and checkRecitation lines them up
// with the ayah. It finds words missed, said differently or added; it does not judge tajweed.

import { Mic, RotateCcw, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { QuranVerse } from '../../../shared/types.ts';
import { checkRecitation, type CheckResult } from '../../../shared/recitation-check.ts';
import { cx, plural } from '../lib.ts';
import type { AsrEvent, AsrRequest } from '../quran-asr.worker.ts';
import { arabicDigits } from './recitation.tsx';

const READY_KEY = 'recitation-checker-ready';
const MAX_SECONDS = 180;
/** The model's files, and those plus the speech engine: what a first check downloads. */
const MODEL_FILES_MB = 150;
const MODEL_MB = 175;

type Phase =
  | { kind: 'idle' }
  | { kind: 'consent' }
  | { kind: 'recording'; started: number }
  | { kind: 'working'; loaded?: number; total?: number }
  | { kind: 'done'; result: CheckResult; heard: string }
  | { kind: 'error'; message: string };

// One worker for the page's lifetime: the model stays loaded between checks.
let worker: Worker | null = null;
let nextId = 1;
function getWorker(): Worker {
  worker ??= new Worker(new URL('../quran-asr.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

function remembered(): boolean {
  try {
    return localStorage.getItem(READY_KEY) === '1';
  } catch {
    return false;
  }
}

/** The recording, as the 16 kHz mono samples Whisper expects. */
async function toSamples(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    return (await off.startRendering()).getChannelData(0);
  } finally {
    void ctx.close();
  }
}

function transcribe(audio: Float32Array, onProgress: (loaded: number, total: number) => void): Promise<string> {
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent<AsrEvent>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.loaded, m.total);
      else if (m.type === 'result' && m.id === id) done(() => resolve(m.text));
      else if (m.type === 'error' && m.id === id) done(() => reject(new Error(m.message)));
    };
    const done = (fn: () => void) => {
      w.removeEventListener('message', onMessage);
      fn();
    };
    w.addEventListener('message', onMessage);
    w.postMessage({ type: 'transcribe', id, audio } satisfies AsrRequest, [audio.buffer]);
  });
}

/** The ayah's text and translation, with the recitation check beneath them. */
export function CheckableAyah({ verse }: { verse: QuranVerse }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [peek, setPeek] = useState(false);
  const [now, setNow] = useState(Date.now());
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);

  const release = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  // A different ayah starts afresh; leaving the page lets go of the microphone.
  useEffect(() => {
    setPhase({ kind: 'idle' });
    setPeek(false);
  }, [verse.key]);
  useEffect(() => () => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
    release();
  }, []);
  useEffect(() => {
    if (phase.kind !== 'recording') return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - phase.started > MAX_SECONDS * 1000) recorder.current?.stop();
    }, 250);
    return () => clearInterval(t);
  }, [phase]);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setPhase({ kind: 'error', message: 'This browser can’t record audio.' });
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setPhase({ kind: 'error', message: 'The microphone wasn’t allowed. Allow it for this site in your browser’s settings, then try again.' });
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream.current);
    recorder.current = rec;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      release();
      setPeek(false);
      setPhase({ kind: 'working' });
      try {
        const samples = await toSamples(new Blob(chunks, { type: rec.mimeType }));
        if (samples.length < 16000 * 0.6) throw new Error('That was too short to hear. Recite the ayah, then press Done.');
        const heard = await transcribe(samples, (loaded, total) => setPhase({ kind: 'working', loaded, total }));
        try {
          localStorage.setItem(READY_KEY, '1');
        } catch {
          /* it'll ask again next time */
        }
        if (!heard.replace(/\s/g, '')) throw new Error('No recitation was heard. Check the microphone and try again.');
        setPhase({ kind: 'done', result: checkRecitation(verse.arabic, heard), heard });
      } catch (err) {
        setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    };
    rec.start();
    setPhase({ kind: 'recording', started: Date.now() });
  };

  const begin = () => (remembered() ? void start() : setPhase({ kind: 'consent' }));
  const recording = phase.kind === 'recording';
  const result = phase.kind === 'done' ? phase.result : null;
  const hidden = recording && !peek;
  const seconds = recording ? Math.floor((now - phase.started) / 1000) : 0;

  return (
    <>
      <div className={cx('ayah-text', hidden && 'is-hidden')}>
        <p className="quran-arabic" lang="ar" dir="rtl">
          {result
            ? result.words.map((w, i) => (
                <span key={i}>
                  <span
                    className={cx('rw', `rw-${w.status}`)}
                    title={w.status === 'different' ? `Heard: ${w.heard}` : w.status === 'missed' ? 'Not heard' : undefined}
                  >
                    {w.word}
                  </span>
                  {result.added.filter((a) => a.after === i).map((a, k) => (
                    <span key={k} className="rw rw-added" title="Said, but not in this ayah">
                      {' '}+{a.heard}
                    </span>
                  ))}{' '}
                </span>
              ))
            : verse.arabic}{' '}
          <span className="verse-end">﴿{arabicDigits(verse.ayah)}﴾</span>
        </p>
        <p className="quran-translation">{verse.translation}</p>
        {hidden && (
          <div className="ayah-cover">
            <span>Hidden while you recite</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPeek(true)}>
              Peek
            </button>
          </div>
        )}
      </div>

      <div className="rc">
        {phase.kind === 'idle' && (
          <button type="button" className="btn btn-sm rc-start" onClick={begin}>
            <Mic size={14} /> Check my recitation
          </button>
        )}

        {phase.kind === 'consent' && (
          <div className="rc-note">
            <p>
              The checker listens on this device, so your recitation isn’t sent anywhere. The first time, it downloads its speech model (about {MODEL_MB} MB); after that
              it’s kept and starts straight away.
            </p>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void start()}>
                <Mic size={14} /> Start reciting
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPhase({ kind: 'idle' })}>
                Not now
              </button>
            </div>
          </div>
        )}

        {recording && (
          <div className="rc-live">
            <span className="rc-dot" aria-hidden />
            <span>
              Listening · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
            </span>
            <span className="hint grow">Recite the ayah from memory, then press Done.</span>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => recorder.current?.stop()}>
              <Square size={12} fill="currentColor" /> Done
            </button>
          </div>
        )}

        {phase.kind === 'working' && (
          <div className="rc-live">
            <span className="spinner" aria-hidden />
            <span className="grow">
              {phase.total
                ? `Getting the checker ready (one time) · ${Math.min(MODEL_FILES_MB, Math.round((phase.loaded ?? 0) / 1e6))} of about ${MODEL_FILES_MB} MB`
                : 'Listening back to your recitation…'}
            </span>
          </div>
        )}

        {result && <Summary result={result} onAgain={() => void start()} onClear={() => setPhase({ kind: 'idle' })} />}

        {phase.kind === 'error' && (
          <div className="rc-note is-error">
            <p>{phase.message}</p>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn btn-sm" onClick={begin}>
                Try again
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPhase({ kind: 'idle' })}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Summary({ result, onAgain, onClear }: { result: CheckResult; onAgain: () => void; onClear: () => void }) {
  const { ok, different, missed, added } = result.counts;
  const total = ok + different + missed;
  const toCheck = different + missed + added;
  return (
    <div className="rc-summary">
      <div className="rc-score">
        <b>{toCheck === 0 ? `All ${total} words matched` : `${ok} of ${total} words matched`}</b>
        {toCheck > 0 && (
          <span className="hint">
            {[missed && `${missed} not heard`, different && `${plural(different, 'word')} sounded different`, added && `${added} added`].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>
      {toCheck > 0 && (
        <div className="rc-legend">
          <span>
            <i className="rw-missed" /> Not heard
          </span>
          <span>
            <i className="rw-different" /> Sounded different
          </span>
          {added > 0 && (
            <span>
              <i className="rw-added" /> Added
            </span>
          )}
        </div>
      )}
      {different > 0 && (
        <ul className="rc-heard">
          {result.words.flatMap((w, i) =>
            w.status === 'different' ? [
              <li key={i}>
                <span lang="ar" dir="rtl">{w.word}</span> <span className="hint">heard as</span> <span lang="ar" dir="rtl">{w.heard}</span>
              </li>,
            ] : [],
          )}
        </ul>
      )}
      <p className="hint rc-caveat">Checks the words, not tajweed. The listener can mishear a letter now and then, so treat these as words to check.</p>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-sm" onClick={onAgain}>
          <RotateCcw size={13} /> Recite again
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
          <X size={13} /> Clear
        </button>
      </div>
    </div>
  );
}
