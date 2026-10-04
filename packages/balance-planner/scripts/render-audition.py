"""Offline bounce of Current vs AutoBalance for listening.

    services/analysis/.venv/bin/python packages/balance-planner/scripts/render-audition.py OUT_DIR

Reads OUT_DIR/audition.json from plan-project.ts and writes current.wav and candidate.wav (48 kHz, 24-bit).
Section gain regions ramp over 10 ms, the same ramp the native engine uses. No limiter, no normalization.
"""

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

RAMP_SECONDS = 0.01
OUT_RATE = 48_000


def gain_curve(frames: int, rate: int, base_db: float, regions: list[dict]) -> np.ndarray:
    target = np.full(frames, 10 ** (base_db / 20), dtype=np.float32)
    for region in regions:
        start = int(region["startSeconds"] * rate)
        end = min(frames, int(region["endSeconds"] * rate))
        target[start:end] = 10 ** (region["gainDb"] / 20)
    # A moving average over RAMP_SECONDS turns each step into a 10 ms linear slope.
    width = max(1, int(RAMP_SECONDS * rate))
    padded = np.concatenate([np.full(width, target[0], dtype=np.float64), target.astype(np.float64)])
    sums = np.cumsum(padded)
    return ((sums[width:] - sums[:-width]) / width).astype(np.float32)


def render(audition: dict, mode: str) -> tuple[np.ndarray, int]:
    project = Path(audition["projectDir"])
    mix = None
    rate = None
    gains = {item["trackId"]: item["gainDb"] for item in audition["candidate"]["tracks"]}
    for track in audition["tracks"]:
        if track["muted"]:
            continue
        data, file_rate = sf.read(project / track["path"], always_2d=True, dtype="float32")
        if data.shape[1] == 1:
            data = np.repeat(data, 2, axis=1)
        rate = rate or file_rate
        if mode == "current":
            base, regions = track["currentGainDb"], track["currentRegions"]
        else:
            base = gains[track["id"]]
            regions = [r for r in audition["candidate"]["regions"] if r["trackId"] == track["id"]]
        curve = gain_curve(len(data), file_rate, base, regions)
        shaped = data[:, :2] * curve[:, None]
        if mix is None:
            mix = shaped
        else:
            n = max(len(mix), len(shaped))
            mix = np.pad(mix, ((0, n - len(mix)), (0, 0))) + np.pad(shaped, ((0, n - len(shaped)), (0, 0)))
    assert mix is not None and rate is not None
    if rate != OUT_RATE:
        mix = resample_poly(mix, OUT_RATE, rate, axis=0)
    return mix, OUT_RATE


def describe(label: str, mix: np.ndarray) -> None:
    peak = 20 * np.log10(np.max(np.abs(mix)) + 1e-12)
    rms = 20 * np.log10(np.sqrt(np.mean(mix**2)) + 1e-12)
    clipped = int(np.sum(np.abs(mix) >= 1.0))
    print(f"{label:9} sample peak {peak:6.2f} dBFS   rms {rms:6.2f} dBFS   samples >= 0 dBFS: {clipped}")


def main() -> None:
    out = Path(sys.argv[1])
    audition = json.loads((out / "audition.json").read_text())
    for mode in ("current", "candidate"):
        mix, rate = render(audition, mode)
        describe(mode, mix)
        sf.write(out / f"{mode}.wav", mix.astype(np.float32), rate, subtype="PCM_24")


if __name__ == "__main__":
    main()
