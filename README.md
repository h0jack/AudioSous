# Audiosous

Audiosous is a local desktop application for musicians who can make a track and want help shaping the mix. Milestone 1 covers the project file, stem import, a shared playback clock, waveforms, sections, intent, undo, and autosave. Nothing here uploads audio.

## Run

```sh
npm install
npm test
npm run dev
```

`npm run dev` opens the Tauri window. On Linux that needs WebKitGTK, which this machine already uses for Tauri.

The browser preview, without the desktop shell:

```sh
npm run dev --workspace @audiosous/desktop
```

The preview can inspect dropped WAV or AIFF files, guess roles, and save `project.amix`. Copying stems into a project folder happens in the desktop app, because the browser cannot keep those files beside the project.

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
