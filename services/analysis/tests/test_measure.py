"""Regression ranges for synthetic stems. Tolerances are intentional."""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from audiosous_analysis.bands import FREQUENCY_BANDS
from audiosous_analysis.errors import AnalysisError
from audiosous_analysis.measure import measure_file

SAMPLE_RATE = 48_000
ROOT = Path(__file__).resolve().parents[1]


def _tone(frequency: float, seconds: float = 2.0, amplitude: float = 0.5, channels: int = 1) -> np.ndarray:
    frames = int(SAMPLE_RATE * seconds)
    time = np.arange(frames) / SAMPLE_RATE
    mono = amplitude * np.sin(2 * math.pi * frequency * time)
    if channels == 1:
        return mono.astype(np.float32)
    return np.column_stack([mono, mono]).astype(np.float32)


def _write(path: Path, audio: np.ndarray) -> None:
    sf.write(path, audio, SAMPLE_RATE, subtype="FLOAT")


def _share(measurement: dict, band_id: str) -> float:
    for band in measurement["bandEnergy"]:
        if band["id"] == band_id:
            return float(band["normalizedEnergy"])
    raise AssertionError(band_id)


def _assert_finite_measurement(measurement: dict) -> None:
    encoded = json.dumps(measurement, allow_nan=False)
    parsed = json.loads(encoded)
    assert parsed["schemaVersion"] == 1
    assert parsed["analysisVersion"] == "0.2.0"
    assert [band["id"] for band in parsed["bandEnergy"]] == [band[0] for band in FREQUENCY_BANDS]
    shares = [band["normalizedEnergy"] for band in parsed["bandEnergy"]]
    assert all(math.isfinite(share) and 0.0 <= share <= 1.0 for share in shares)


def test_band_edges_match_the_shared_model():
    assert [(band[2], band[3]) for band in FREQUENCY_BANDS] == [
        (20.0, 60.0),
        (60.0, 120.0),
        (120.0, 250.0),
        (250.0, 500.0),
        (500.0, 2_000.0),
        (2_000.0, 5_000.0),
        (5_000.0, 10_000.0),
        (10_000.0, 20_000.0),
    ]


def test_pure_tones_concentrate_in_the_expected_bands(tmp_path: Path):
    cases = (
        (50.0, "sub"),
        (100.0, "bass"),
        (1_000.0, "upper-mid"),
        (8_000.0, "brilliance"),
        (14_000.0, "air"),
    )
    for frequency, band_id in cases:
        path = tmp_path / f"{band_id}.wav"
        _write(path, _tone(frequency))
        measurement = measure_file(path)
        _assert_finite_measurement(measurement)
        assert _share(measurement, band_id) > 0.8


def test_white_noise_puts_more_energy_in_the_wider_high_bands(tmp_path: Path):
    rng = np.random.default_rng(1)
    path = tmp_path / "white.wav"
    _write(path, rng.uniform(-0.2, 0.2, SAMPLE_RATE * 2).astype(np.float32))
    measurement = measure_file(path)
    _assert_finite_measurement(measurement)
    assert _share(measurement, "air") > _share(measurement, "sub") * 5


def test_ten_kilohertz_lands_in_the_top_bands(tmp_path: Path):
    path = tmp_path / "high.wav"
    _write(path, _tone(10_000.0))
    measurement = measure_file(path)
    top = _share(measurement, "brilliance") + _share(measurement, "air")
    assert top > 0.85


def test_silence_has_no_invalid_levels(tmp_path: Path):
    path = tmp_path / "silence.wav"
    _write(path, np.zeros(SAMPLE_RATE, dtype=np.float32))
    measurement = measure_file(path)
    _assert_finite_measurement(measurement)
    levels = measurement["levels"]
    assert levels["peakDbfs"] is None
    assert levels["rmsDbfs"] is None
    assert levels["integratedLufs"] is None
    assert levels["crestFactorDb"] is None
    assert levels["integratedLufsStatus"] == "silent"
    assert sum(band["normalizedEnergy"] for band in measurement["bandEnergy"]) == 0


def test_louder_tone_reports_higher_rms(tmp_path: Path):
    quiet = tmp_path / "quiet.wav"
    loud = tmp_path / "loud.wav"
    _write(quiet, _tone(1_000.0, amplitude=0.1))
    _write(loud, _tone(1_000.0, amplitude=0.5))
    quiet_rms = measure_file(quiet)["levels"]["rmsDbfs"]
    loud_rms = measure_file(loud)["levels"]["rmsDbfs"]
    assert quiet_rms is not None and loud_rms is not None
    assert loud_rms > quiet_rms + 10


def test_sine_levels_and_lufs_are_near_the_known_signal(tmp_path: Path):
    path = tmp_path / "reference.wav"
    # Peak -20 dBFS. A sine's RMS is 3.01 dB lower. K-weighting is about 0 dB at 1 kHz,
    # so integrated loudness sits near the RMS, not the peak.
    amplitude = 10 ** (-20 / 20)
    _write(path, _tone(1_000.0, amplitude=amplitude))
    levels = measure_file(path)["levels"]
    assert levels["peakDbfs"] == pytest_approx(-20, abs=0.2)
    assert levels["rmsDbfs"] == pytest_approx(-23.01, abs=0.3)
    assert levels["crestFactorDb"] == pytest_approx(3.01, abs=0.2)
    assert levels["integratedLufsStatus"] == "measured"
    assert levels["integratedLufs"] == pytest_approx(-23.01, abs=1.0)
    louder = tmp_path / "louder.wav"
    _write(louder, _tone(1_000.0, amplitude=amplitude * 2))
    louder_lufs = measure_file(louder)["levels"]["integratedLufs"]
    assert louder_lufs is not None and levels["integratedLufs"] is not None
    assert louder_lufs > levels["integratedLufs"] + 5


def test_impulse_train_has_a_larger_crest_factor_than_a_sine(tmp_path: Path):
    sine = tmp_path / "sine.wav"
    clicks = tmp_path / "clicks.wav"
    _write(sine, _tone(1_000.0, amplitude=0.5))
    frames = SAMPLE_RATE * 2
    impulse = np.zeros(frames, dtype=np.float32)
    impulse[:: SAMPLE_RATE // 10] = 0.9
    _write(clicks, impulse)
    sine_crest = measure_file(sine)["levels"]["crestFactorDb"]
    click_crest = measure_file(clicks)["levels"]["crestFactorDb"]
    assert sine_crest is not None and click_crest is not None
    assert click_crest > sine_crest + 10


def test_stereo_file_reports_both_channels_and_keeps_the_bytes(tmp_path: Path):
    path = tmp_path / "stereo.wav"
    _write(path, _tone(100.0, channels=2))
    before = path.read_bytes()
    measurement = measure_file(path)
    assert path.read_bytes() == before
    assert measurement["source"]["channelCount"] == 2
    assert _share(measurement, "bass") > 0.8


def test_repeated_measurement_matches(tmp_path: Path):
    path = tmp_path / "steady.wav"
    _write(path, _tone(100.0))
    assert measure_file(path) == measure_file(path)


def test_unreadable_bytes_become_an_analysis_error(tmp_path: Path):
    path = tmp_path / "notes.wav"
    path.write_bytes(b"this is not audio")
    try:
        measure_file(path)
    except AnalysisError as error:
        assert error.code == "unsupported-audio"
        assert error.message == "Unable to analyze notes.wav"
        assert str(path) not in error.detail
    else:
        raise AssertionError("expected an analysis error")


def test_sidecar_returns_json_for_one_wav(tmp_path: Path):
    path = tmp_path / "bass.wav"
    _write(path, _tone(100.0))
    completed = subprocess.run(
        [sys.executable, "-m", "audiosous_analysis"],
        input=json.dumps({"contractVersion": 1, "operation": "analyze_track", "audioPath": str(path)}),
        text=True,
        capture_output=True,
        cwd=ROOT,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["ok"] is True
    assert payload["contractVersion"] == 1
    assert payload["measurement"]["bandEnergy"][1]["normalizedEnergy"] > 0.8


def test_sidecar_explains_a_bad_request():
    completed = subprocess.run(
        [sys.executable, "-m", "audiosous_analysis"],
        input="{not json",
        text=True,
        capture_output=True,
        cwd=ROOT,
        check=False,
    )
    payload = json.loads(completed.stdout)
    assert payload["ok"] is False
    assert payload["error"]["code"] == "invalid-request"


def pytest_approx(expected: float, abs: float):  # noqa: A002 — mirrors pytest.approx keyword
    import pytest

    return pytest.approx(expected, abs=abs)
