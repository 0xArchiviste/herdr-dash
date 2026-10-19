"""Parakeet TDT v3 local PCM WebSocket adapter.

TDT v3 is an offline model. Previews re-decode the current utterance; only
silence/end-of-input commits it. Segment IDs identify finals, never text.
Audio and inference stay on this machine. No other model is loaded.
"""
import argparse
import asyncio
import collections
import json
import logging
import numpy as np
import sherpa_onnx
from websockets.asyncio.server import serve

RATE = 16000
PREVIEW = 2 * RATE
MAX_AUDIO = 20 * RATE
SILENCE = int(1.2 * RATE)


def load_model(directory, threads):
    from pathlib import Path
    d = Path(directory)
    return sherpa_onnx.OfflineRecognizer.from_transducer(
        tokens=str(d / "tokens.txt"), encoder=str(d / "encoder.int8.onnx"),
        decoder=str(d / "decoder.int8.onnx"), joiner=str(d / "joiner.int8.onnx"),
        feature_dim=128, num_threads=threads, model_type="nemo_transducer",
    )


async def run(args):
    recognizer = load_model(args.model_dir, args.threads)
    decode_lock = asyncio.Lock()
    active = set()

    def decode(audio):
        stream = recognizer.create_stream()
        stream.accept_waveform(RATE, audio)
        recognizer.decode_stream(stream)
        return stream.result.text.strip()

    async def session(ws):
        if len(active) >= 2:
            await ws.close(1013, "local speech engine busy")
            return
        active.add(ws)
        audio = []
        count = quiet = last_preview = segment = 0
        speech = False
        preroll = collections.deque(maxlen=5)  # at most 0.5 s from 100 ms frames

        async def result(final=False, eof=False):
            nonlocal segment, last_preview
            text = ""
            if speech and count:
                samples = np.concatenate(audio)
                async with decode_lock:
                    text = await asyncio.to_thread(decode, samples)
            await ws.send(json.dumps(dict(text=text, segment=segment, is_final=final, is_eof=eof)))
            if final:
                segment += 1
            last_preview = count

        try:
            async for message in ws:
                if isinstance(message, str):
                    if message != "Done":
                        raise ValueError("expected float32 PCM or Done")
                    await result(final=True, eof=True)
                    await ws.send("Done!")
                    return
                if not message or len(message) % 4 or len(message) > RATE * 4:
                    raise ValueError("expected at most one second of 16 kHz float32 PCM per frame")
                block = np.frombuffer(message, dtype="<f4").copy()
                if not np.isfinite(block).all() or np.max(np.abs(block)) > 1.01:
                    raise ValueError("invalid PCM samples")
                # Process fixed 100 ms blocks, regardless of network frame sizes.
                for start in range(0, len(block), 1600):
                    part = block[start:start + 1600]
                    voiced = float(np.sqrt(np.mean(part * part))) >= 0.01
                    if not speech:
                        preroll.append(part)
                        if not voiced:
                            continue
                        audio = list(preroll)
                        count = sum(len(x) for x in audio)
                        preroll.clear()
                        speech = True
                    else:
                        audio.append(part)
                        count += len(part)
                    quiet = 0 if voiced else quiet + len(part)
                    if quiet >= SILENCE or count >= MAX_AUDIO:
                        await result(final=True)
                        audio = []; count = quiet = last_preview = 0; speech = False
                    elif count - last_preview >= PREVIEW:
                        await result()
        except (ValueError, RuntimeError) as exc:
            logging.exception("local transcription failed")
            await ws.close(1011, str(exc)[:100])
        finally:
            active.discard(ws)

    async with serve(session, "127.0.0.1", args.port, max_size=RATE * 4,
                     max_queue=16, compression=None):
        logging.info("Parakeet TDT v3 ready on loopback port %s", args.port)
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--threads", type=int, default=2)
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run(parser.parse_args()))
