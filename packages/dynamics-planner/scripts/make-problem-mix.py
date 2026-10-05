"""Builds the deliberately problematic real-music project for the dynamics acceptance run.

    services/analysis/.venv/bin/python packages/dynamics-planner/scripts/make-problem-mix.py \
        "test-assets/Generated 5" "target/acceptance/Generated 5 Dynamics"

It reads the 48 kHz playback proxies of Generated 5 (never the original media) and writes a new project folder
whose stems carry known dynamics problems, so the planner's answers can be checked against what was put in:

- Bass: Bass Bus 4 dB louder in the drops (its low end over the kick) with note-to-note level jumps (0 to -8 dB)
  at irregular intervals that never repeat.
- Pad: MasterEQ with a +7 dB presence bell at 2.5 kHz baked in, so it covers the lead's presence range.
- Lead: Bleeps Bus gated into 6-second phrases in the drops, so the pad masks it only while it plays.
- Clap: a synthetic clap on the off-beats with an attack far sharper than its body (spiky percussion).
- Kick (PunchBox) and Atmosphere (Skimming Air) as they are.

The source project is not modified. Analysis caches for the new stems are measured with the sidecar's own code;
run the eq_bands and envelope_frames examples on the new folder afterwards.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import lfilter

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "services" / "analysis"))
from audiosous_analysis import ANALYSIS_ENGINE_VERSION, ANALYSIS_SCHEMA_VERSION  # noqa: E402
from audiosous_analysis.measure import measure_file  # noqa: E402

RATE = 48_000
SECTIONS = [
    ("intro", "Intro", "intro", 0.0, 17.7),
    ("break", "Break", "breakdown", 17.7, 33.6),
    ("drop", "Drop", "drop", 33.6, 86.6),
    ("drop2", "Drop 2", "drop", 86.6, 123.7),
    ("outro", "Outro", "outro", 123.7, 141.43),
]


def read_proxy(path: Path) -> np.ndarray:
    raw = path.read_bytes()
    if raw[:4] != b"ASPX":
        raise SystemExit(f"{path} is not a playback proxy")
    channels = int.from_bytes(raw[12:14], "little")
    frames = int.from_bytes(raw[16:24], "little")
    data = np.frombuffer(raw[64:], dtype="<f4", count=frames * channels).reshape(frames, channels)
    return np.repeat(data, 2, axis=1) if channels == 1 else data.copy()


def bell(audio: np.ndarray, hz: float, gain_db: float, q: float) -> np.ndarray:
    a = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * hz / RATE
    alpha = np.sin(w0) / (2 * q)
    b = np.array([1 + alpha * a, -2 * np.cos(w0), 1 - alpha * a])
    den = np.array([1 + alpha / a, -2 * np.cos(w0), 1 - alpha / a])
    return lfilter(b / den[0], den / den[0], audio, axis=0).astype(np.float32)


def smooth_gain(points: list[tuple[float, float]], frames: int, fade: float) -> np.ndarray:
    """Piecewise-constant gain (seconds, dB) with linear fades of `fade` seconds at each change."""
    gain = np.zeros(frames, dtype=np.float64)
    for (start, db), (end, _) in zip(points, points[1:] + [(frames / RATE, 0.0)]):
        gain[int(start * RATE) : int(end * RATE)] = db
    width = max(1, int(fade * RATE))
    kernel = np.ones(width) / width
    gain = np.convolve(gain, kernel, mode="same")
    return (10 ** (gain / 20)).astype(np.float32)[:, None]


def onsets(audio: np.ndarray) -> np.ndarray:
    hop = 480
    peak = np.abs(audio).max(axis=1)
    frames = len(peak) // hop
    envelope = 20 * np.log10(np.maximum(peak[: frames * hop].reshape(frames, hop).max(axis=1), 1e-9))
    out, last = [], -100
    for index in range(3, frames):
        if envelope[index] > envelope.max() - 30 and envelope[index] - envelope[index - 3 : index].min() >= 9 and index - last >= 6:
            out.append(index * hop)
            last = index
    return np.array(out)


def main() -> None:
    source, destination = Path(sys.argv[1]), Path(sys.argv[2])
    project = json.loads((source / "project.amix").read_text())
    by_name = {track["name"]: track for track in project["tracks"]}

    def proxy(fragment: str) -> np.ndarray:
        track = next(item for name, item in by_name.items() if fragment in name)
        return read_proxy(source / "cache" / "playback" / f"{track['id']}.proxy")

    rng = np.random.default_rng(6)
    kick = proxy("PunchBox")
    frames = kick.shape[0]
    duration = frames / RATE

    # Bass: note-level jumps at irregular, non-repeating intervals.
    bass = proxy("Bass Bus")
    # Louder in the drops, so its low end sits on top of the kick there.
    bass = bass * smooth_gain([(0.0, 0.0), (33.6, 4.0), (123.7, 0.0)], frames, 0.05)
    points, time = [], 0.0
    while time < duration:
        points.append((time, float(-8 * rng.random())))
        time += float(0.35 + 0.55 * rng.random())
    bass = bass * smooth_gain(points, frames, 0.015)

    # Pad: a presence bump that covers the lead.
    pad = bell(proxy("MasterEQ"), 2_500, 7, 1.0)

    # Lead: phrases of 6 s on, 6 s off inside the drops; as it was elsewhere.
    lead = proxy("Bleeps Bus")
    gate = []
    for start in (33.6, 86.6):
        end = 86.6 if start == 33.6 else 123.7
        time = start
        while time < end:
            gate.append((time, 0.0))
            gate.append((min(end, time + 6), -90.0))
            time += 12
    gate.append((123.7, 0.0))
    lead = lead * smooth_gain([(0.0, 0.0)] + gate, frames, 0.05)

    # Clap: an off-beat clap with a 3 ms attack spike far above a 60 ms body.
    hits = onsets(kick)
    beat = float(np.median(np.diff(hits))) if len(hits) > 8 else 0.469 * RATE
    clap = np.zeros((frames, 2), dtype=np.float32)
    burst = np.arange(int(0.25 * RATE)) / RATE
    noise = rng.standard_normal((len(burst), 2)).astype(np.float32)
    envelope = np.where(burst < 0.003, 1.0, 0.12 * np.exp(-(burst - 0.003) / 0.06)).astype(np.float32)[:, None]
    shape = bell(noise * envelope, 1_800, 6, 0.8) * 0.5
    for onset in hits[1::2]:
        at = int(onset + beat / 2)
        if at + len(burst) < frames and 33.6 * RATE <= at < 123.7 * RATE:
            clap[at : at + len(burst)] += shape

    stems = [
        ("Kick", "kick", kick, None),
        ("Bass", "bass", bass, None),
        ("Lead", "lead", lead, None),
        ("Pad", "pad", pad, None),
        ("Clap", "snare-clap", clap, None),
        ("Atmosphere", "atmosphere", proxy("Skimming Air"), None),
    ]
    (destination / "media").mkdir(parents=True, exist_ok=True)
    (destination / "cache" / "analysis").mkdir(parents=True, exist_ok=True)
    (destination / "recovery").mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    tracks = []
    for name, role, audio, _ in stems:
        track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"generated-5-dynamics/{name}"))
        filename = f"{name}.wav"
        relative = f"media/{track_id}__{filename}"
        path = destination / relative
        sf.write(path, np.clip(audio, -1, 1), RATE, subtype="PCM_24")
        stat = os.stat(path)
        tracks.append(
            {
                "id": track_id,
                "name": name,
                "role": role,
                "customLabel": None,
                "file": {"relativePath": relative, "filename": filename},
                "metadata": {"format": "wav", "sampleRate": RATE, "channelCount": 2, "bitDepth": 24, "durationSeconds": duration, "fileSizeBytes": stat.st_size},
                "gainDb": 0,
                "pan": 0,
                "width": 1,
                "muted": False,
                "solo": False,
                "processing": {"schemaVersion": 2, "nodes": [], "dynamics": []},
            }
        )
        measurement = measure_file(path)
        entry = {
            "schemaVersion": ANALYSIS_SCHEMA_VERSION,
            "analysisVersion": ANALYSIS_ENGINE_VERSION,
            "identity": {"relativePath": relative, "fileSizeBytes": stat.st_size, "modifiedAtNs": str(stat.st_mtime_ns)},
            "scope": {"type": "track"},
            "measuredAt": now,
            "measurement": measurement,
        }
        (destination / "cache" / "analysis" / f"{track_id}.json").write_text(json.dumps(entry))
        print(f"{name}: {relative}")
    lead_id = next(track["id"] for track in tracks if track["name"] == "Lead")
    document = {
        "schemaVersion": 4,
        "project": {"id": "generated-5-dynamics", "name": "Generated 5 Dynamics", "createdAt": now, "updatedAt": now, "sampleRate": RATE, "durationSeconds": duration},
        "tracks": tracks,
        "sections": [
            {"id": key, "name": name, "type": kind, "startTime": start, "endTime": min(end, duration), "userIntent": None, "source": "manual", "confidence": None, "structuralGroupId": None}
            for key, name, kind, start, end in SECTIONS
        ],
        "sectionTrackSettings": [
            {"trackId": lead_id, "sectionId": key, "userIntent": None, "prominence": "focal", "overrides": {"gainDb": None, "pan": None, "width": None}, "processing": {"schemaVersion": 2, "nodes": [], "dynamics": []}}
            for key in ("drop", "drop2")
        ],
        "mixVariants": project["mixVariants"],
        "activeMixVariantId": project["activeMixVariantId"],
        "comparison": {"scope": "entire-mix", "aVariantId": project["comparison"]["aVariantId"], "bVariantId": project["comparison"]["bVariantId"], "trackId": None},
        "uiState": {"selectedTrackId": None, "selectedSectionId": None, "timeRange": None, "loop": None, "playheadSeconds": 0, "timelineZoom": 1, "timelineScroll": 0},
    }
    text = json.dumps(document, indent=2) + "\n"
    (destination / "project.amix").write_text(text)
    (destination / "recovery" / "project.amix").write_text(text)
    print(f"Wrote {destination / 'project.amix'}")


if __name__ == "__main__":
    main()
