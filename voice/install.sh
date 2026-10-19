#!/bin/sh
set -eu
runtime="${HOME}/.local/share/herdr-dash/stt-runtime"
mkdir -p "$(dirname "$runtime")"
if command -v uv >/dev/null 2>&1; then
    uv venv --allow-existing --python 3.12 "$runtime"
    uv pip install --python "$runtime/bin/python" sherpa-onnx==1.13.8 numpy==2.5.4 websockets==17.2
else
    python3 -m venv "$runtime"
    "$runtime/bin/python" -m pip install sherpa-onnx==1.13.8 numpy==2.5.4 websockets==17.2
fi
printf '%s\n' 'Local Parakeet TDT v3 runtime installed. Run make stt-fetch, then enable HERDR_DASH_STT=local.'
