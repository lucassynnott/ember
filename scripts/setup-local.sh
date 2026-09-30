#!/bin/zsh
set -euo pipefail

MODEL_DIR="$HOME/Library/Application Support/MeetingNotes/models"
MODEL_PATH="$MODEL_DIR/ggml-medium.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"

if ! command -v brew >/dev/null 2>&1; then
  print -u2 "Homebrew is required: https://brew.sh"
  exit 1
fi

packages=()
command -v ffmpeg >/dev/null 2>&1 || packages+=(ffmpeg)
command -v whisper-cli >/dev/null 2>&1 || packages+=(whisper-cpp)
if (( ${#packages[@]} )); then
  brew install "${packages[@]}"
fi

mkdir -p "$MODEL_DIR"
if [[ ! -s "$MODEL_PATH" ]]; then
  print "Downloading whisper.cpp medium model to $MODEL_PATH"
  curl --fail --location --progress-bar "$MODEL_URL" --output "$MODEL_PATH.tmp"
  mv "$MODEL_PATH.tmp" "$MODEL_PATH"
else
  print "Whisper medium model already installed."
fi

PHONON_VENV="$HOME/Library/Application Support/MeetingNotes/phonon-venv"
if [[ ! -x "$PHONON_VENV/bin/fermion" ]]; then
  command -v uv >/dev/null 2>&1 || brew install uv
  print "Installing Phonon-2 (Fermion Research) into $PHONON_VENV"
  uv venv --python 3.13 "$PHONON_VENV"
  uv pip install --python "$PHONON_VENV/bin/python" fermion-research mlx mlx-audio mlx-lm soundfile scipy zstandard
else
  print "Phonon-2 runtime already installed."
fi
print "Downloading the Phonon-2 model (about 164 MB, cached after the first run)"
say -o "${TMPDIR:-/tmp}/meeting-notes-phonon-check.aiff" "Meeting Notes is ready."
"$PHONON_VENV/bin/fermion" transcribe phonon-2 "${TMPDIR:-/tmp}/meeting-notes-phonon-check.aiff"
rm -f "${TMPDIR:-/tmp}/meeting-notes-phonon-check.aiff"

print "Local transcription setup complete."
