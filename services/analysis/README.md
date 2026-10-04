# Audiosous analysis

Python sidecar for stem measurements. The desktop UI does not import this package. Tauri starts `python -m audiosous_analysis`, writes one JSON request to stdin, and reads one JSON response from stdout.

Install the engine once:

```sh
cd services/analysis
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
```

The desktop app uses `services/analysis/.venv/bin/python`. Set `AUDIOSOUS_PYTHON` to point somewhere else. Internal arrays stay in this process. The UI only sees the versioned measurement defined by `@audiosous/analysis-contract`.

This slice measures one whole stem: peak, RMS, integrated LUFS, crest factor, and energy share across the shared frequency bands. It does not change the WAV file.
