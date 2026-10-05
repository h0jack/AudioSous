"""Offline bounce of Current vs Spatial Candidate (and the reviewed plan) for listening, plus a cross-check.

    services/analysis/.venv/bin/python packages/spatial-planner/scripts/render-space-audition.py OUT_DIR [--wav]

Reads OUT_DIR/audition.json from plan-space-project.ts and the 48 kHz playback proxies and measures
Current, Spatial Candidate, and the reviewed plan in stereo and folded to mono ((L + R) / 2). With --wav
it also writes current.wav, candidate.wav, reviewed.wav (48 kHz float stereo) and *_mono.wav for
listening, about 80 MB per bounce of a 2.5 minute song. Saved EQ, fader, section gain, width, and pan/balance follow the native
engine: EQ, then width on the stereo stem's mid/side pair, then the equal-power pan law, then gain.
Pan and width changes at section edges ramp over 30 ms. No limiter, no normalization.

It is an independent NumPy implementation of the spatial stage. For every recommendation it measures
the stem's correlation and mono fold-down loss over the windows where it competes, before and after,
and prints them next to the planner's prediction from cached statistics.
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

# Reuse the EQ bouncer's proxy reader and RBJ filter chain (its file name is not an importable module name).
_EQ_SCRIPT = Path(__file__).resolve().parents[2] / "eq-planner" / "scripts" / "render-eq-audition.py"
_namespace: dict = {"__name__": "render_eq_audition"}
exec(compile(_EQ_SCRIPT.read_text(), str(_EQ_SCRIPT), "exec"), _namespace)
read_proxy = _namespace["read_proxy"]
chain = _namespace["chain"]

RATE = 48_000
RAMP = int(0.03 * RATE)
GAIN_RAMP = int(0.01 * RATE)


def place(audio: np.ndarray, pan: float, width: float, mono: bool) -> np.ndarray:
    """Width on mid/side, then the equal-power law. A mono source ignores width."""
    left, right = audio[:, 0], audio[:, 1]
    if not mono and width != 1.0:
        mid = 0.5 * (left + right)
        side = 0.5 * (left - right) * width
        left, right = mid + side, mid - side
    position = (min(max(pan, -1.0), 1.0) + 1) / 2
    return np.stack([left * math.sqrt(1 - position), right * math.sqrt(position)], axis=1)


def smooth(values: np.ndarray, width: int) -> np.ndarray:
    padded = np.concatenate([np.full(width, values[0]), values])
    return np.convolve(padded, np.ones(width) / width, mode="valid")[: values.shape[0]]


def spatial_curves(view: dict, track_id: str, frames: int) -> tuple[np.ndarray, np.ndarray]:
    own = next(item for item in view["tracks"] if item["trackId"] == track_id)
    pan = np.full(frames, float(own["pan"]))
    width = np.full(frames, float(own["width"]))
    for region in [item for item in view["regions"] if item["trackId"] == track_id]:
        start, end = int(region["startSeconds"] * RATE), min(frames, int(region["endSeconds"] * RATE))
        pan[start:end] = region["pan"]
        width[start:end] = region["width"]
    return smooth(pan, RAMP), smooth(width, RAMP)


def render(audition: dict, view: dict) -> np.ndarray:
    project = Path(audition["projectDir"])
    longest = 0
    stems = []
    for track in audition["tracks"]:
        if track["muted"]:
            continue
        proxy = project / "cache" / "playback" / f"{track['id']}.proxy"
        if not proxy.is_file():
            continue
        with proxy.open("rb") as handle:
            mono = int.from_bytes(handle.read(14)[12:14], "little") == 1
        audio = chain(read_proxy(proxy), track["eq"])
        frames = audio.shape[0]
        pan, width = spatial_curves(view, track["id"], frames)
        if not mono:
            mid = 0.5 * (audio[:, 0] + audio[:, 1])
            side = 0.5 * (audio[:, 0] - audio[:, 1]) * width
            audio = np.stack([mid + side, mid - side], axis=1)
        position = (np.clip(pan, -1.0, 1.0) + 1) / 2
        placed = np.stack([audio[:, 0] * np.sqrt(1 - position), audio[:, 1] * np.sqrt(position)], axis=1)
        gain = np.full(frames, 10 ** ((track["gainDb"] + view["trimDb"]) / 20))
        for region in track["sectionGains"]:
            gain[int(region["startSeconds"] * RATE) : int(region["endSeconds"] * RATE)] = 10 ** ((region["gainDb"] + view["trimDb"]) / 20)
        stems.append(placed * smooth(gain, GAIN_RAMP)[:, None])
        longest = max(longest, frames)
    mix = np.zeros((longest, 2))
    for stem in stems:
        mix[: stem.shape[0]] += stem
    return mix


def stereo_stats(audio: np.ndarray) -> dict:
    left, right = audio[:, 0], audio[:, 1]
    ll, rr, lr = float(np.mean(left * left)), float(np.mean(right * right)), float(np.mean(left * right))
    mono = float(np.mean((0.5 * (left + right)) ** 2))
    return {
        "correlation": lr / math.sqrt(max(ll * rr, 1e-30)),
        "monoLossDb": 10 * math.log10(max(0.5 * (ll + rr), 1e-20) / max(mono, 1e-20)),
        "lean": abs(rr - ll) / max(rr + ll, 1e-20),
        "peakDbfs": 20 * math.log10(max(float(np.max(np.abs(audio))), 1e-12)),
        "rmsDbfs": 10 * math.log10(max(0.5 * (ll + rr), 1e-20)),
    }


def check(audition: dict) -> list[str]:
    project = Path(audition["projectDir"])
    tracks = {item["id"]: item for item in audition["tracks"]}
    lines = []
    for item in audition["checks"]:
        proxy = project / "cache" / "playback" / f"{item['trackId']}.proxy"
        with proxy.open("rb") as handle:
            mono = int.from_bytes(handle.read(14)[12:14], "little") == 1
        audio = chain(read_proxy(proxy), tracks[item["trackId"]]["eq"])
        picked = np.concatenate([audio[int(start * RATE) : int(end * RATE)] for start, end in item["windows"]] or [audio])
        before = stereo_stats(place(picked, item["before"]["pan"], item["before"]["width"], mono))
        after = stereo_stats(place(picked, item["after"]["pan"], item["after"]["width"], mono))
        predicted = item["predicted"] or {}
        lines.append(
            f"{tracks[item['trackId']]['name']:<22} measured corr {before['correlation']:+.2f} -> {after['correlation']:+.2f}, mono loss {before['monoLossDb']:.2f} -> {after['monoLossDb']:.2f} dB"
            f" | predicted corr {predicted.get('correlationBefore', float('nan')):+.2f} -> {predicted.get('correlationAfter', float('nan')):+.2f},"
            f" mono loss {predicted.get('monoLossBeforeDb', float('nan')):.2f} -> {predicted.get('monoLossAfterDb', float('nan')):.2f} dB"
            f" | {sum(end - start for start, end in item['windows']):.1f} s"
        )
    return lines


def main() -> None:
    out = Path(sys.argv[1])
    write = "--wav" in sys.argv[2:]
    audition = json.loads((out / "audition.json").read_text())
    for name in ("current", "candidate", "reviewed"):
        mix = render(audition, audition[name])
        stats = stereo_stats(mix)
        folded = 0.5 * (mix[:, 0] + mix[:, 1])
        if write:
            sf.write(out / f"{name}.wav", mix.astype(np.float32), RATE, subtype="FLOAT")
            sf.write(out / f"{name}_mono.wav", folded.astype(np.float32), RATE, subtype="FLOAT")
        mono_peak = 20 * math.log10(max(float(np.max(np.abs(folded))), 1e-12))
        mono_rms = 10 * math.log10(max(float(np.mean(folded**2)), 1e-20))
        print(
            f"{name:<9} stereo peak {stats['peakDbfs']:+.2f} dBFS rms {stats['rmsDbfs']:+.2f} dBFS corr {stats['correlation']:+.3f} lean {stats['lean']:.3f}"
            f" | mono peak {mono_peak:+.2f} dBFS rms {mono_rms:+.2f} dBFS (fold-down loss {stats['monoLossDb']:.2f} dB)"
        )
    for line in check(audition):
        print(line)


if __name__ == "__main__":
    main()
