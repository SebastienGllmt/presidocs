#!/usr/bin/env python3
# Long-lived Qwen3-ForcedAligner worker, driven by the `qwen3` aligner in
# generate/aligner.ts.
#
# WHY a persistent worker (and not one `python align.py` per segment): the
# aligner's ~0.6B model costs several seconds to load — and the *original*
# integration paid that load on EVERY segment, because `align()` spawned a
# fresh `python` per call. Benchmarking showed that reload was the dominant
# cost: aligning a 1.6s clip and a 54s clip took ~5.96s and ~6.93s
# respectively, i.e. ~5.9s is pure model load and only ~1s is the actual
# alignment compute for a very long segment. Over a ~160-segment post that is
# ~16 minutes of nothing but reloading the model. So — exactly like
# moss_worker.py — the TS side spawns this script ONCE, we load the model a
# single time, then serve one segment per request over a line-delimited JSON
# protocol on stdin/stdout. The model stays resident between requests.
#
# WHY CPU by default (see methodology.md "Word-level timing"): with the reload
# amortized away by this worker, warm per-segment compute is ~234ms — small
# enough that CPU costs nothing we'd notice — while keeping the aligner off the
# GPU hands the entire card to MOSS, whose ~13.4 GB already over-subscribes an
# 11 GB card. So on a discrete GPU CPU wins on both axes: no VRAM contention
# with MOSS, and no slower in practice (the old spawn-per-call GPU path paid
# CUDA init + host->device load every segment anyway). The device is still
# overridable (QWEN3_ALIGNER_DEVICE) for machines that prefer cuda/mps.
#
# This mirrors align.py in the Qwen3-ForcedAligner checkout (same model load
# and `model.align(audio=, text=, language=)` call); the only difference is we
# keep the model alive and stream segments instead of running once and exiting.
#
# Protocol — one compact JSON object per line, both directions:
#   startup  -> {"ready": true}                          (model loaded)
#   stdin    <- {"audio": "/abs/path.wav", "text": "...", "language": "English"}
#   stdout   -> {"ok": true, "tokens": [{"start": s, "end": s, "text": "..."}]}
#   stdout   -> {"ok": false, "error": "<message>"}      (this segment failed)
# EOF on stdin ends the worker cleanly.
#
# stdout carries ONLY protocol JSON. transformers/torch/tqdm chatter would
# otherwise corrupt the stream, so right after capturing the real stdout for
# protocol use we point sys.stdout at stderr; every library `print` and
# progress bar then lands on stderr (which the parent inherits to the
# terminal, so model-load progress is still visible).

import argparse
import json
import sys

# Capture the genuine stdout for the protocol, then redirect Python-level
# stdout to stderr so noisy library output can't corrupt the JSON stream.
_protocol_out = sys.stdout
sys.stdout = sys.stderr


def _emit(obj):
    _protocol_out.write(json.dumps(obj) + "\n")
    _protocol_out.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Qwen3-ForcedAligner model dir")
    parser.add_argument(
        "--device",
        default="cpu",
        help="torch device (cpu/cuda:0/mps); CPU default keeps the GPU free for MOSS",
    )
    args = parser.parse_args()

    # Imports live inside main so an --help / argparse error doesn't pay the
    # multi-second torch import cost.
    import torch
    from qwen_asr import Qwen3ForcedAligner

    print(f"[align-worker] device={args.device}", file=sys.stderr)
    # bf16 matches align.py exactly, so the worker's timings are identical to
    # the one-shot path it replaces (the alignment cache is keyed on text, not
    # device, so this also stays consistent with any already-cached words).
    model = Qwen3ForcedAligner.from_pretrained(
        args.model,
        dtype=torch.bfloat16,
        device_map=args.device,
    )
    print("[align-worker] model loaded", file=sys.stderr)

    # Tell the parent we're ready to accept work. Until this line lands the
    # aligner treats the worker as "still loading", not "wedged".
    _emit({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            audio = req["audio"]
            text = req["text"]
            language = req.get("language", "English")

            results = model.align(audio=audio, text=text, language=language)

            # align() returns one result list per input; we send a single
            # segment, so results[0] is this segment's tokens. Serialize the
            # fields the TS side needs (seconds + text); it converts to ms.
            tokens = [
                {"start": tok.start_time, "end": tok.end_time, "text": tok.text}
                for tok in results[0]
            ]
            _emit({"ok": True, "tokens": tokens})
        except Exception as exc:  # one bad segment shouldn't kill the worker
            _emit({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
