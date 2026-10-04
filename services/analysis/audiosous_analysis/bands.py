"""Frequency bands shared with @audiosous/analysis-contract FREQUENCY_BANDS."""

from __future__ import annotations

import numpy as np

FREQUENCY_BANDS: tuple[tuple[str, str, float, float], ...] = (
    ("sub", "Sub", 20.0, 60.0),
    ("bass", "Bass", 60.0, 120.0),
    ("low-mid", "Low Mid", 120.0, 250.0),
    ("mid", "Mid", 250.0, 500.0),
    ("upper-mid", "Upper Mid", 500.0, 2_000.0),
    ("presence", "Presence", 2_000.0, 5_000.0),
    ("brilliance", "Brilliance", 5_000.0, 10_000.0),
    ("air", "Air", 10_000.0, 20_000.0),
)


def band_energy(freqs: np.ndarray, power: np.ndarray) -> list[dict[str, float | str]]:
    """Share of total band power. Empty or silent spectra report zeros, never NaN."""
    energies: list[float] = []
    last = len(FREQUENCY_BANDS) - 1
    for index, (_band_id, _name, low, high) in enumerate(FREQUENCY_BANDS):
        if freqs.size == 0 or power.size == 0:
            energies.append(0.0)
            continue
        if index == last:
            mask = (freqs >= low) & (freqs <= high)
        else:
            mask = (freqs >= low) & (freqs < high)
        energies.append(float(np.sum(power[mask])))

    total = float(sum(energies))
    if total <= 0.0 or not np.isfinite(total):
        shares = [0.0 for _ in energies]
    else:
        rounded = [round(energy / total, 6) for energy in energies]
        largest = max(range(len(rounded)), key=lambda item: rounded[item])
        drift = round(1.0 - sum(rounded), 6)
        rounded[largest] = round(min(1.0, max(0.0, rounded[largest] + drift)), 6)
        shares = rounded

    result: list[dict[str, float | str]] = []
    for (band_id, name, low, high), share in zip(FREQUENCY_BANDS, shares, strict=True):
        result.append(
            {
                "id": band_id,
                "name": name,
                "lowHz": low,
                "highHz": high,
                "normalizedEnergy": share,
            }
        )
    return result
