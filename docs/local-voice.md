# Local Parakeet voice validation

The required model is **nvidia/parakeet-tdt-0.6b-v3**. This implementation
loads only its int8 ONNX conversion. It does not load Nemotron or Parakeet
Unified, and local failures surface without switching speech engines.

## Provenance

- [NVIDIA model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3),
  published August 14, 2025; model repository revision observed October 19,
  2026: `541d1f99c6b0c3cd0b11a95167540bb8edefd82b`.
- Original NVIDIA checkpoint: 2,509,332,480-byte `.nemo`; CC-BY-4.0.
- [k2-fsa conversion](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2):
  487,170,055-byte download, approximately 639 MiB extracted model files.
  Archive SHA-256:
  `5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf`.
  The release does not record an immutable upstream NVIDIA commit for the
  conversion; the archive digest identifies the actual deployed weights.
- Runtime: sherpa-onnx 1.13.8 (Apache-2.0), CPU provider, 128-bin features,
  `nemo_transducer` model type. NumPy 2.5.4 and websockets 17.2.

The offline TDT model is used with utterance buffering: growing previews are
recomputed every two seconds, and a 1.2-second quiet interval commits the
utterance. Previews can change considerably before the final. Quiet audio
uses a simple RMS threshold of 0.01; noise or quiet speech can affect it.
Utterances are limited to 20 seconds, then a new segment begins.

## Measurements

Measured October 19, 2026 on an AMD Ryzen 9 9950X3D host under WSL, 24
visible logical CPUs and 62 GiB RAM. Each inference process was constrained
to two CPU threads, `CPUQuota=200%`, and `MemoryMax=2G`. GPU measurements
were unavailable: the WSL NVIDIA management executable crashed. These are
CPU results and do not imply GPU performance.

Existing bake-off fixtures: 20 short dashboard commands and 10 dictation
sentences, synthesized with three Piper voices. No human microphone corpus
was available. WER below is the mean per-utterance score after lowercasing
and removing punctuation; number words and spelling variants are not
normalized (for example, “sixteen” versus “16” counts as an error).

| Measurement | Result |
| --- | --- |
| Cold recognizer load | 1.56 s |
| Peak recognizer / full sidecar RSS | 887 MiB / 907 MiB |
| Offline CPU seconds per audio second | 0.126 overall; 0.090 dictation |
| Full sidecar CPU, including previews and load | 20.58 CPU s for 65.24 s audio |
| Offline utterance decode | median 0.122 s; dictation median 0.192 s |
| Real-time first preview, dictation | median 2.03 s; range 2.00–2.42 s |
| Final after explicit stop, real-time replay | median 0.105 s; range 0.070–1.214 s |
| Commands | 14/20 exact; mean WER 24.2% |
| Dictation | 7/10 exact; mean WER 4.4% |

Short commands can be misheard: “dock left” became “Doc left,” “dock right”
became “Dalk right,” “acknowledge” became “A knowledge,” and “close pane”
became “Close pain.” Prefer longer phrases, inspect dictation before sending,
and retain the existing confirmation for actions. These synthetic measurements
are not a guarantee for accents, microphones, or background noise.

## Repeatable checks

`make check` exercises the Go server and real Chromium against fictional
project fixtures with a speech sidecar stub. Voice scenarios cover PCM
transport, readiness, partial/final handling, duplicate segment finals,
selection replacement, coordinator dictation, cancellation, explicit startup
errors, and the browser speech-detection toggle. Screenshots are written to
`e2e/artifacts/voice-local-*.png`.

For the actual model, install/fetch it and provide a 16 kHz mono WAV containing:
“The dashboard shows three red threads and one waiting on review.” Include
at least two seconds of trailing silence. Run:

```sh
HERDR_DASH_STT_FIXTURE=/absolute/path/to/fixture.wav make stt-check
```

Optional `HERDR_DASH_STT_DIR` and `HERDR_DASH_STT_PYTHON` select an isolated
model cache and runtime. This browser check uses actual PCM and inference,
asserts the interim does not alter the chat, and verifies exactly one correct
final replaces the selection. It produces `voice-real-partial.png`,
`voice-real-final.png`, and `voice-real-transcripts.json`. These artifacts
can contain local paths and should remain outside commits.
