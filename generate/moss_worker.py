#!/usr/bin/env python3
# Long-lived MOSS-TTS voice-clone worker, driven by the `moss` provider in
# generate/tts-providers.ts.
#
# WHY a persistent worker (and not one `python` per segment): loading MOSS
# (a ~1.7B transformer) costs many seconds. Synthesizing a post one segment
# at a time would reload the model on every sentence and dominate the build.
# So the TS provider spawns this script ONCE, we load the model a single
# time, then serve one segment per request over a line-delimited JSON
# protocol on stdin/stdout. The model stays resident between requests.
#
# This mirrors run_voiceclone.py in the MOSS-TTS repo (voice cloning from a
# reference clip): the reference is re-supplied at generation time via
# `build_user_message(..., reference=[ref])` — MOSS has no separate
# "train a speaker embedding once" step, so the clip is re-encoded per call.
# The expensive thing we amortize by staying alive is the model load, not
# the cloning.
#
# Protocol — one compact JSON object per line, both directions:
#   startup  -> {"ready": true}                     (model loaded, accepting work)
#   stdin    <- {"text": "<segment text>", "out": "/abs/path.wav"}
#   stdout   -> {"ok": true}                         (wrote `out`)
#   stdout   -> {"ok": false, "error": "<message>"}  (this segment failed)
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
    parser.add_argument("--model", required=True, help="MOSS HF model id")
    parser.add_argument(
        "--reference", required=True, help="voice-clone reference .wav clip"
    )
    parser.add_argument(
        "--device",
        default="auto",
        help="force device (mps/cuda/cpu); 'auto' picks the best available",
    )
    args = parser.parse_args()

    # Imports live inside main so an --help / argparse error doesn't pay the
    # multi-second torch import cost.
    import torch
    import torchaudio
    from transformers import AutoModel, AutoProcessor

    if args.device != "auto":
        device = args.device
    elif torch.backends.mps.is_available():
        device = "mps"
    elif torch.cuda.is_available():
        device = "cuda"
    else:
        device = "cpu"
    dtype = torch.float32
    print(f"[moss-worker] device={device} dtype={dtype}", file=sys.stderr)

    processor = AutoProcessor.from_pretrained(args.model, trust_remote_code=True)
    processor.audio_tokenizer = processor.audio_tokenizer.to(device)

    model = AutoModel.from_pretrained(
        args.model,
        trust_remote_code=True,
        attn_implementation="eager",
        torch_dtype=dtype,
    ).to(device)
    model.eval()

    sampling_rate = processor.model_config.sampling_rate
    print(f"[moss-worker] model loaded; sampling_rate={sampling_rate}", file=sys.stderr)

    # Tell the parent we're ready to accept work. Until this line lands the
    # provider treats the worker as "still loading", not "wedged".
    _emit({"ready": True, "samplingRate": sampling_rate})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = req["text"]
            out_path = req["out"]

            conversations = [
                [processor.build_user_message(text=text, reference=[args.reference])]
            ]
            batch = processor(conversations, mode="generation")
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)

            with torch.no_grad():
                outputs = model.generate(
                    input_ids=input_ids,
                    attention_mask=attention_mask,
                    max_new_tokens=4096,
                    audio_temperature=1.0,
                    audio_top_p=0.95,
                    audio_top_k=50,
                    audio_repetition_penalty=1.1,
                )

            wrote = False
            for message in processor.decode(outputs):
                audio = message.audio_codes_list[0]
                torchaudio.save(out_path, audio.unsqueeze(0), sampling_rate)
                wrote = True
                break
            if not wrote:
                raise RuntimeError("MOSS produced no audio for this segment")

            _emit({"ok": True})
        except Exception as exc:  # one bad segment shouldn't kill the worker
            _emit({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
