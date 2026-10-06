"""Builds the deliberately problematic real-music project for the Full Mix acceptance run.

    services/analysis/.venv/bin/python packages/mix-planner/scripts/make-full-mix-problem.py \
        "test-assets/Generated 5" "target/acceptance/Generated 5 Full Mix"

It reads the 48 kHz playback proxies of Generated 5 (never the original media) and writes a new project whose
stems carry the milestone's demonstration problems, so the plan can be checked against what was put in:

- Kick: PunchBox as it is.
- Bass: Bass Bus 4 dB louder in the drops (its low end on top of the kick there) with note-to-note level jumps
  (0 to -8 dB) at irregular intervals that never repeat: a kick/bass collision and level instability.
- Lead: Bleeps Bus gated into 6-second phrases in the drops; Focal there.
- Pad: MasterEQ with a +7 dB presence bell at 2.5 kHz baked in, so it covers the lead's presence range.
- Synth: Stutter Expression, a stereo part. The scenario widens it past what folds to mono and pans it toward the
  pad, so the two crowd the right-center: that problem lives in the project's pan and width, not the audio.
- Atmosphere: Skimming Air as it is.

The bass, pad, and lead are made exactly as for the Milestone 6 dynamics run (same seed), so the two runs can be
compared. The source project is not modified. Run the eq_bands, stereo_frames, and envelope_frames examples on the
new folder afterwards.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location("m6", HERE.parents[2] / "dynamics-planner" / "scripts" / "make-problem-mix.py")
m6 = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(m6)


def main() -> None:
    source, destination = Path(sys.argv[1]), Path(sys.argv[2])
    project = json.loads((source / "project.amix").read_text())
    by_name = {track["name"]: track for track in project["tracks"]}

    def proxy(fragment: str) -> np.ndarray:
        track = next(item for name, item in by_name.items() if fragment in name)
        return m6.read_proxy(source / "cache" / "playback" / f"{track['id']}.proxy")

    rng = np.random.default_rng(6)
    kick = proxy("PunchBox")
    frames = kick.shape[0]
    duration = frames / m6.RATE

    bass = proxy("Bass Bus")
    bass = bass * m6.smooth_gain([(0.0, 0.0), (33.6, 4.0), (123.7, 0.0)], frames, 0.05)
    points, time = [], 0.0
    while time < duration:
        points.append((time, float(-8 * rng.random())))
        time += float(0.35 + 0.55 * rng.random())
    bass = bass * m6.smooth_gain(points, frames, 0.015)

    pad = m6.bell(proxy("MasterEQ"), 2_500, 7, 1.0)

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
    lead = lead * m6.smooth_gain([(0.0, 0.0)] + gate, frames, 0.05)

    stems = [
        ("Kick", "kick", kick),
        ("Bass", "bass", bass),
        ("Lead", "lead", lead),
        ("Pad", "pad", pad),
        ("Synth", "synth", proxy("Stutter Expression")),
        ("Atmosphere", "atmosphere", proxy("Skimming Air")),
    ]
    (destination / "media").mkdir(parents=True, exist_ok=True)
    (destination / "cache" / "analysis").mkdir(parents=True, exist_ok=True)
    (destination / "recovery").mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    tracks = []
    for name, role, audio in stems:
        track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"generated-5-full-mix/{name}"))
        filename = f"{name}.wav"
        relative = f"media/{track_id}__{filename}"
        path = destination / relative
        sf.write(path, np.clip(audio, -1, 1), m6.RATE, subtype="PCM_24")
        stat = os.stat(path)
        tracks.append(
            {
                "id": track_id,
                "name": name,
                "role": role,
                "customLabel": None,
                "file": {"relativePath": relative, "filename": filename},
                "metadata": {"format": "wav", "sampleRate": m6.RATE, "channelCount": 2, "bitDepth": 24, "durationSeconds": duration, "fileSizeBytes": stat.st_size},
                "gainDb": 0,
                "pan": 0,
                "width": 1,
                "muted": False,
                "solo": False,
                "processing": {"schemaVersion": 2, "nodes": [], "dynamics": []},
            }
        )
        measurement = m6.measure_file(path)
        entry = {
            "schemaVersion": m6.ANALYSIS_SCHEMA_VERSION,
            "analysisVersion": m6.ANALYSIS_ENGINE_VERSION,
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
        "project": {"id": "generated-5-full-mix", "name": "Generated 5 Full Mix", "createdAt": now, "updatedAt": now, "sampleRate": m6.RATE, "durationSeconds": duration},
        "tracks": tracks,
        "sections": [
            {"id": key, "name": name, "type": kind, "startTime": start, "endTime": min(end, duration), "userIntent": None, "source": "manual", "confidence": None, "structuralGroupId": None}
            for key, name, kind, start, end in m6.SECTIONS
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
