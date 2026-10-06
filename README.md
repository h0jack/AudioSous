# Audiosous

Audiosous is a local desktop application for musicians who can make a track and want help shaping the mix. It plays stems on one native clock, measures them, and plans level, EQ, stereo, and dynamics changes deterministically, alone or as one Full Mix plan you audition and apply. Auto Mix builds one coordinated, verified Recommended Mix in a click (you preview it, see what changes, and apply it as one undo step), and Export renders the applied mix from the original stems to WAV, FLAC, or MP3 with an optional distribution loudness stage. An optional assistant lets you ask for changes in your own words and drives those planners; it sends structured project information to the AI provider you connect, never audio (see `docs/assistant.md`). Nothing here uploads audio.

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

`npm run dev` opens the Audiosous window. MP3 export uses the system's LAME library (`libmp3lame`, for example `apt install libmp3lame0` or `brew install lame`); WAV and FLAC need nothing extra. On Linux that needs WebKitGTK and the GStreamer good plugins (`gst-plugins-good`), which provide the audio output Play uses. The first analysis of a stem also needs the Python environment above.

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

See `docs/architecture.md`, `docs/assistant.md`, `docs/project-format.md`, and `docs/milestones.md`.
