// Speech recognition for the recitation check, run on this device in a worker so the page
// stays responsive. The model is Tarteel's Whisper fine-tuned on Quran recitation, in a
// browser-ready (ONNX) conversion pinned to one revision; it downloads once and the browser
// keeps it. The ONNX runtime's WebAssembly is served from this app, not a CDN.

import { env, pipeline } from '@huggingface/transformers';
import asyncifyMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import asyncifyWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import plainMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import plainWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

export const MODEL = 'eventhorizon0/tarteel-ai-onnx-whisper-base-ar-quran';
export const REVISION = '86aa2ae915f3b11c60b4c031774a7b5123477ba5';

export type AsrRequest = { type: 'transcribe'; id: number; audio: Float32Array };
export type AsrEvent =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string };

// Older Safari without WebGPU runs the plain build; everything else the asyncify one,
// as transformers.js itself would choose.
const safari = /Version\/(\d+)[\d.]* .*Safari/.exec(navigator.userAgent);
const oldSafari = !!safari && Number(safari[1]) < 26 && !('gpu' in navigator);
env.allowLocalModels = false;
env.backends.onnx.wasm!.wasmPaths = oldSafari ? { mjs: plainMjs, wasm: plainWasm } : { mjs: asyncifyMjs, wasm: asyncifyWasm };

const post = (e: AsrEvent) => (self as unknown as Worker).postMessage(e);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let asr: Promise<any> | null = null;
function load() {
  if (asr) return asr;
  const files = new Map<string, { loaded: number; total: number }>();
  asr = pipeline('automatic-speech-recognition', MODEL, {
    revision: REVISION,
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' },
    device: 'wasm',
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== 'progress' || !p.file || !p.total) return;
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      post({ type: 'progress', loaded, total });
    },
  }).then((p) => {
    post({ type: 'ready' });
    return p;
  });
  asr.catch(() => (asr = null));
  return asr;
}

self.onmessage = async (e: MessageEvent<AsrRequest>) => {
  const req = e.data;
  if (req.type !== 'transcribe') return;
  try {
    const run = await load();
    // Settings measured on Alafasy's recitation: longer ayat are read in 30-second pieces.
    const out = (await run(req.audio, { chunk_length_s: 30, stride_length_s: 5 })) as { text: string };
    post({ type: 'result', id: req.id, text: out.text.trim() });
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
