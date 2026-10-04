# Architecture

Audiosous is a local desktop application. Milestone 1 does not mix, host plugins, or call a model. It exists so later analysis and DSP can sit on a stable project, a single playback clock, and a selection context.

## Repository layout

```text
Audiosous/
├── apps/desktop/          React + Vite UI and the Tauri shell
├── packages/
│   ├── project-model/     Versioned .amix schema, migrations, roles, import checks
│   ├── audio-files/       WAV and AIFF header inspection (no full decode)
│   ├── audio-engine/      One playback clock. Stems are read in short windows.
│   └── analysis-contract/ Versioned JSON DTOs for the analysis sidecar
├── services/analysis/     Python sidecar. Tauri spawns it and exchanges JSON.
├── docs/
└── test-assets/           Reserved for generated stems in a later slice
```

`packages/timeline` and `packages/ui` are intentionally absent. The timeline lives in the desktop app until it is large enough to split out.

Dependency direction:

```text
apps/desktop
  → project-model
  → audio-files
  → audio-engine
  → analysis-contract

audio-engine → project-model
services/analysis  has no dependency on the UI
```

The React app never imports `services/analysis`.

## Dependencies

| Concern | Choice |
| --- | --- |
| UI | React, TypeScript, Vite, Tailwind CSS, Zustand |
| Desktop shell | Tauri 2 |
| Project validation | Zod |
| Tests | Vitest for TypeScript, `cargo test` for path and copy safety |
| Analysis | Python sidecar (`numpy`, `scipy`, `soundfile`, `pyloudnorm`). The UI does not import it |

There is no cloud client, account system, or upload step.

## Project schema

The on-disk document is schema version 1. The shape is **song → sections → tracks → track × section**. Tracks, manual sections, section intent, and track × section intent can be edited.

Persisted now:

- sections, including source, confidence, and `structuralGroupId`
- track × section intent, optional prominence (`primary` / `focal` / `supporting`), gain/pan overrides, and an empty `ProcessingGraph`
- mix variants (`Original`, `Working Mix`) and an A/B comparison record with three scopes: entire mix, soloed track, and one track inside the full mix
- selection context: track, section, time range, and loop

`schemaVersion` is required. `migrateProject` walks registered migrations until the current version, then validates. A newer file is refused with an update message. Unknown future fields are not silently kept inside a v1 document.

Waveform peaks are not embedded in `project.amix`. Each stem is measured once into min/max pairs at 256, 1024, and 4096 frames, then written to `cache/waveforms/<trackId>.peaks`. The project screen draws every lane from that cache on one horizontal scale. Zoom chooses the coarsest level that still has at least one peak per pixel. The PCM used to build the peaks is discarded.

## Audio engine

`packages/audio-engine` owns the transport. Every stem is scheduled from one `AudioContext` clock in short PCM windows. The whole stem is never decoded into memory. Mute, solo, gain, and pan are applied on that clock. Looping a selected range wraps on the same clock.

```typescript
interface AudioEngine {
  loadProject(project: ProjectDocument, media: MediaResolver): Promise<void>;
  play(startTime?: number): Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  setTrackGain(trackId: string, gainDb: number): void;
  setTrackPan(trackId: string, pan: number): void;
  setMute(trackId: string, muted: boolean): void;
  setSolo(trackId: string, solo: boolean): void;
  setLoop(region: { startSeconds: number; endSeconds: number } | null): void;
  getCurrentTime(): number;
  getDuration(): number;
  dispose(): void;
}
```

`play` returns a promise because starting the device clock is asynchronous. Pan is `-1` (left) through `0` (center) to `+1` (right). The UI will show that as −100 to +100. Gain is decibels in the persisted range −96 to +12. Silence is mute, because JSON cannot store −∞.

`loadProject` takes a media resolver so the engine never interprets bundle layout and never receives paths from the project file unchecked. The UI must not render `<audio>` elements. One engine owns the clock for every stem.

`setLoop` is on the interface now so looping does not require a second playback API.

## How audio paths are stored

A project is a folder:

```text
Night Drive/
├── project.amix
├── media/
│   └── <trackId>__<filename>.wav
├── cache/
└── recovery/
    └── project.amix
```

`project.amix` stores only bundle-relative paths such as `media/<trackId>__kick.wav`. On import the shell copies bytes into `media/`. The copy is read-only from Audiosous's point of view, and the original export is opened read-only and never written.

Rules enforced in both TypeScript and Rust:

- the path must start with `media/`
- no absolute paths, drive prefixes, empty segments, `.`, or `..`
- no null bytes
- when the file exists, the canonical path must still sit inside the project folder, so a symlink cannot escape the bundle

Opening a project re-reads headers from those relative paths. A missing file is a warning. It does not prevent the project from opening.

Machine-specific absolute paths exist only in memory during the import that the user just picked.

## Analysis sidecar

Measurements run in `services/analysis`. The React app never imports that package. It validates JSON with `@audiosous/analysis-contract` (`contractVersion` 1, `analysisVersion` `0.3.0`). Suggest sections still uses cached peak energy and does not start Python.

```text
media/<track>.wav
    │
    ▼
Tauri analyze_audio
    │  paths must stay inside the project media folder
    ▼
python -m audiosous_analysis
    │  one JSON object on stdin, one on stdout
    ▼
measurement DTO
    │
    ▼
cache/analysis/<name>.json
```

A measurement includes peak dBFS, RMS dBFS, integrated LUFS, crest factor, energy share across Sub, Bass, Low Mid, Mid, Upper Mid, Presence, Brilliance, and Air, plus a 48-bin spectrum, a loudness timeline, and a spectrogram. The scope is the whole stem, a section, a time range, or the mix. The mix sums the raw stem files. Faders, mute, and pan are not part of it. Stems in one mix measurement must share a sample rate.

Comparison, overlap, and the activity map are derived in the UI from those measurements. They do not start a separate analysis operation.

A cache entry is current when the analysis version, file identity, and requested scope all match. Whole-stem cache is `cache/analysis/<trackId>.json`. A section uses `<trackId>__section-<sectionId>`. A time range uses `<trackId>__range`. The mix uses `cache/analysis/mix.json`. Changing a fader does not invalidate a measurement. Changing the stem file, the selected window, or the analysis version does. Drawings stay out of `project.amix`.

`analyze_audio` runs off the UI thread, so playback keeps the existing clock. The desktop app looks for `services/analysis/.venv/bin/python`, or `AUDIOSOUS_PYTHON`. A late result for a stem the user already left is ignored. The dev build is not yet a packaged sidecar.

## Tauri and Web Audio

Synchronized playback uses these constraints:

1. **Memory.** `decodeAudioData` turns each stem into a full float32 buffer. A 32-stem, 10-minute, 48 kHz stereo session is on the order of 7 GB of PCM before the UI exists. The Milestone 1 engine must not decode every stem into an `AudioBuffer` at once. The interface is here so a streaming native backend can replace the webview engine without a timeline rewrite.

2. **One clock.** If a webview engine is used for short sessions, every stem is scheduled from a single `AudioContext.currentTime`. Independent `<audio>` elements will drift and are disallowed.

3. **Seek and loop.** A seek or loop restart stops the scheduled nodes and starts them again against the same context time. Loop boundaries use that clock, not `setInterval`.

4. **Gesture and latency.** Playback has to resume the audio context from the play action. WebKitGTK on Linux has higher output latency and no exclusive mode. That is acceptable for early monitoring and a poor final engine.

5. **Sample rate.** The device rate may differ from the project rate. A shared context keeps stems aligned with each other, but later sample-accurate processing should own resampling inside the engine. The UI does not see an `AudioContext`.

6. **File access.** The webview cannot read arbitrary disk paths. Header inspection uses small ranged reads through Tauri. Absolute paths are resolved in the shell and are not written into `project.amix`.

7. **Variants.** `loadProject` already receives the project, including the active mix variant and the A/B scope. A later engine can switch streams behind the same play, seek, gain, and solo methods.

## Logging

Structured events for this slice: `project.create`, `project.open`, `project.save`, `track.import`, `track.decode.failure`. The desktop shell appends JSON lines to the application log directory. Playhead motion is not logged.

## Milestone 1

Included: the shell, schema version 1, WAV/AIFF import, waveform cache, one shared playback clock, mute/solo/gain/pan, manual sections, section and track × section intent, looping a range or a section, undo/redo, explicit save plus autosave after an edit settles, and experimental section suggestions from cached peaks.

Not included: spawning the Python sidecar, DSP, and every later item listed in `docs/milestones.md`. Source WAVs are never modified. A 32-stem project is read in short windows, not decoded into one buffer per stem.
