# Audiosous

Audiosous is a local desktop application for musicians who can make a track and want help shaping the mix. Milestone 1 covers the project file, stem import, a shared playback clock, waveforms, sections, intent, undo, and autosave. Nothing here uploads audio.

## Run the desktop app

Analysis, stem copies, and project folders run in the desktop window.

```sh
npm install
cd services/analysis
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cd ../..
npm run dev
```

`npm run dev` opens the Audiosous window. On Linux that needs WebKitGTK and the GStreamer good plugins (`gst-plugins-good`), which provide the audio output Play uses. The first analysis of a stem also needs the Python environment above.

There is a browser preview for layout work. It does not start the analysis engine:

```sh
npm run dev --workspace @audiosous/desktop
```

## Project folder

```text
Night Drive/
├── project.amix
├── media/
├── cache/
└── recovery/
    └── project.amix
```

`project.amix` is versioned JSON. Media paths inside it stay relative to that folder. Import copies stems and does not modify the originals.

See `docs/architecture.md`, `docs/project-format.md`, and `docs/milestones.md`.
