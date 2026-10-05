"""Offline bounce of Current vs EQ Candidate (and the reviewed plan) for listening, plus a cross-check.

    services/analysis/.venv/bin/python packages/eq-planner/scripts/render-eq-audition.py OUT_DIR

Reads OUT_DIR/audition.json from plan-eq-project.ts and the 48 kHz playback proxies, and writes
current.wav, candidate.wav, and accepted.wav (48 kHz float). Gain, balance, section gain, and the
RBJ cookbook filters follow the native engine: section filters run after track filters and fade in
and out over 30 ms. No limiter, no normalization.

It also measures, for every recommendation, the filtered stem's level inside its conflict range
over the windows where the parts overlap, before and after. This is an independent Python
implementation of the same filters, so it cross-checks the planner's spectral prediction.
"""

import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import sosfilt

RATE = 48_000
FADE = int(0.03 * RATE)
GAIN_RAMP = int(0.01 * RATE)


def read_proxy(path: Path) -> np.ndarray:
    data = path.read_bytes()
    if data[:4] != b"ASPX":
        raise ValueError(f"{path.name} is not an Audiosous proxy")
    channels = struct.unpack_from("<H", data, 12)[0]
    frames = struct.unpack_from("<Q", data, 16)[0]
    offset = struct.unpack_from("<I", data, 44)[0]
    samples = np.frombuffer(data, dtype="<f4", count=frames * channels, offset=offset)
    audio = samples.reshape(frames, channels).astype(np.float64)
    return audio if channels == 2 else np.repeat(audio[:, :1], 2, axis=1)


def biquad(kind: str, hz: float, gain_db: float, q: float) -> np.ndarray:
    w0 = 2 * math.pi * min(max(hz, 20.0), 20_000.0) / RATE
    cos, sin = math.cos(w0), math.sin(w0)
    alpha = sin / (2 * max(q, 0.1))
    a = 10 ** ((0.0 if kind.endswith("pass") else gain_db) / 40)
    if kind == "low-pass":
        b0, b1, b2, a0, a1, a2 = (1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha
    elif kind == "high-pass":
        b0, b1, b2, a0, a1, a2 = (1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha
    elif kind == "bell":
        b0, b1, b2, a0, a1, a2 = 1 + alpha * a, -2 * cos, 1 - alpha * a, 1 + alpha / a, -2 * cos, 1 - alpha / a
    elif kind == "low-shelf":
        r = 2 * math.sqrt(a) * alpha
        b0, b1, b2 = a * (a + 1 - (a - 1) * cos + r), 2 * a * (a - 1 - (a + 1) * cos), a * (a + 1 - (a - 1) * cos - r)
        a0, a1, a2 = a + 1 + (a - 1) * cos + r, -2 * (a - 1 + (a + 1) * cos), a + 1 + (a - 1) * cos - r
    else:
        r = 2 * math.sqrt(a) * alpha
        b0, b1, b2 = a * (a + 1 + (a - 1) * cos + r), -2 * a * (a - 1 + (a + 1) * cos), a * (a + 1 + (a - 1) * cos - r)
        a0, a1, a2 = a + 1 - (a - 1) * cos + r, 2 * (a - 1 - (a + 1) * cos), a + 1 - (a - 1) * cos - r
    return np.array([[b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]])


def chain(audio: np.ndarray, filters: list[dict]) -> np.ndarray:
    if not filters:
        return audio
    sos = np.vstack([biquad(item["kind"], item["frequencyHz"], item["gainDb"], item["q"]) for item in filters])
    return sosfilt(sos, audio, axis=0)


def ramp_mask(frames: int, windows: list[tuple[float, float]], width: int) -> np.ndarray:
    mask = np.zeros(frames)
    for start, end in windows:
        mask[int(start * RATE) : min(frames, int(end * RATE))] = 1.0
    if width <= 1:
        return mask
    kernel = np.ones(width) / width
    return np.convolve(mask, kernel, mode="same")


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
        audio = read_proxy(proxy)
        frames = audio.shape[0]
        own = next((item["filters"] for item in view["tracks"] if item["trackId"] == track["id"]), [])
        filtered = chain(audio, own)
        for region in [item for item in view["regions"] if item["trackId"] == track["id"]]:
            extra = chain(filtered, region["filters"])
            mask = ramp_mask(frames, [(region["startSeconds"], region["endSeconds"])], FADE)[:, None]
            filtered = filtered * (1 - mask) + extra * mask
        gain = np.full(frames, 10 ** ((track["gainDb"] + view["trimDb"]) / 20))
        for region in track["sectionGains"]:
            gain[int(region["startSeconds"] * RATE) : int(region["endSeconds"] * RATE)] = 10 ** ((region["gainDb"] + view["trimDb"]) / 20)
        gain = np.convolve(np.concatenate([np.full(GAIN_RAMP, gain[0]), gain]), np.ones(GAIN_RAMP) / GAIN_RAMP, mode="valid")[:frames]
        position = (min(max(track["pan"], -1.0), 1.0) + 1) / 2
        balance = np.array([math.sqrt(1 - position), math.sqrt(position)])
        stems.append(filtered * gain[:, None] * balance[None, :])
        longest = max(longest, frames)
    mix = np.zeros((longest, 2))
    for stem in stems:
        mix[: stem.shape[0]] += stem
    return mix


def band_level(audio: np.ndarray, low: float, high: float, windows: list[list[float]]) -> float:
    edges = []
    if low > 25:
        edges += [("high-pass", low)] * 2
    if high < 19_000:
        edges += [("low-pass", high)] * 2
    band = chain(audio, [{"kind": kind, "frequencyHz": hz, "gainDb": 0, "q": 0.707} for kind, hz in edges])
    picked = [band[int(start * RATE) : int(end * RATE)] for start, end in windows]
    joined = np.concatenate(picked) if picked else band
    return 10 * math.log10(max(float(np.mean(joined**2)), 1e-20))


def check(audition: dict, plan: dict) -> list[str]:
    project = Path(audition["projectDir"])
    lines = []
    current = {item["trackId"]: item["filters"] for item in audition["current"]["tracks"]}
    for change in plan["changes"]:
        evidence = change["evidence"]
        focus = evidence.get("focus")
        if focus:
            low, high = evidence["edgesHz"][focus[0]], evidence["edgesHz"][focus[1] + 1]
        else:
            hz = change["processing"]["filter"]["frequencyHz"]
            low, high = (20.0, hz) if change["processing"]["filter"]["kind"] == "high-pass" else (hz / 1.5, hz * 1.5)
        audio = read_proxy(project / "cache" / "playback" / f"{change['trackId']}.proxy")
        saved = current.get(change["trackId"], [])
        replaced = evidence.get("replaces")
        before_filters = saved
        after_filters = [item for item in saved if item != replaced] + [change["processing"]["filter"]]
        before = band_level(chain(audio, before_filters), low, high, evidence["windows"])
        after = band_level(chain(audio, after_filters), low, high, evidence["windows"])
        predicted = change["evaluation"]["regionChangeDb"] if change.get("evaluation") else float("nan")
        lines.append(
            f"{change['id']}: {low:.0f}-{high:.0f} Hz measured {after - before:+.2f} dB, predicted {predicted:+.2f} dB"
        )
    return lines


def main() -> None:
    out = Path(sys.argv[1])
    audition = json.loads((out / "audition.json").read_text())
    plan = json.loads((out / "plan.json").read_text())
    for name in ("current", "candidate", "accepted"):
        mix = render(audition, audition[name])
        peak = float(np.max(np.abs(mix))) if mix.size else 0.0
        rms = math.sqrt(float(np.mean(mix**2))) if mix.size else 0.0
        sf.write(out / f"{name}.wav", mix.astype(np.float32), RATE, subtype="FLOAT")
        print(f"{name}.wav peak {20 * math.log10(max(peak, 1e-12)):+.2f} dBFS rms {20 * math.log10(max(rms, 1e-12)):+.2f} dBFS")
    for line in check(audition, plan):
        print(line)


if __name__ == "__main__":
    main()
