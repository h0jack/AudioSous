# Architecture

Audiosous is a local desktop application. Milestone 1 does not mix, host plugins, or call a model. It exists so later analysis and DSP can sit on a stable project, a single playback clock, and a selection context.

## Repository layout

```text
Audiosous/
├── apps/desktop/          React + Vite UI and the Tauri shell
├── crates/audio-engine/   Native playback clock, proxies, and device output
├── packages/
│   ├── project-model/     Versioned .amix schema, migrations, roles, import checks
│   ├── audio-files/       WAV and AIFF header inspection (no full decode)
│   ├── audio-engine/      Playback interface. Desktop uses the Rust engine; the browser preview uses Web Audio.
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
| Playback | `cpal` output, `rtrb` rings, rubato `FftFixedIn` proxies |
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

Waveform peaks are not embedded in `project.amix`. Each stem is measured once into min/max pairs at 256, 1024, and 4096 frames, then written to `cache/waveforms/<trackId>.peaks`. The desktop app measures those peaks in Rust from the original stem. The browser preview still measures them in JavaScript. The project screen draws every lane from that cache on one horizontal scale. Zoom chooses the coarsest level that still has at least one peak per pixel. The PCM used to build the peaks is discarded.

## Audio engine

Desktop playback runs in Rust (`crates/audio-engine`). React sends play, pause, seek, gain, pan, mute, solo, and loop. It polls position and diagnostics about 30 times a second. The playhead does not advance while buffers are priming.

The browser preview still uses `packages/audio-engine`, which schedules short PCM windows on one `AudioContext`. Set `AUDIOSOUS_AUDIO_ENGINE=legacy` before launching the desktop app to force that path. The native engine is the default.

Original stems in `media/` stay untouched. Each stem gets a disposable playback proxy at `cache/playback/<trackId>.proxy`: 48 kHz, little-endian float32, the same channel count up to stereo, with a 64-byte header. The header stores the source size, modification time, format version, and resampler id. A mismatch deletes the proxy and builds it again. `project.amix` does not contain the PCM.

Proxies are resampled offline with rubato's `FftFixedIn` (8192-frame chunks, 2 sub-chunks). A long sinc resampler was rejected because a 192 kHz stem took far too long. The FFT resampler is band-limited and fast enough to build those stems in the background. The audio callback never resamples.

Output uses `cpal`. The engine asks for 32-bit float stereo at 48 kHz. If the device accepts that, the callback mixes the proxy rings directly. If the device rate is different, a mixer thread resamples the stereo bus with a short sinc and the callback only copies. A 16-bit device gets the same mixer thread, then a sample conversion in the callback. Final render quality is independent of this 48 kHz proxy.

Four reader threads fill one `rtrb` ring per stem. Each ring holds about 5 seconds; playback starts after about 1 second is buffered, and readers keep about 3 seconds filled. The callback applies a 10 ms gain ramp, equal-power pan, mute, and solo, then sums. A dry ring writes silence for that stem and increments an underrun counter. It does not lock, allocate, read disk, or call into JavaScript. Seek bumps a generation so an in-flight read cannot enter the new rings. Loop wrap is the same frame on every stem.

The mix order is read, then a per-track process stage that is currently identity, then gain, pan, sum, then a mix-bus stage that is currently identity. Later EQ, dynamics, and sidechain can sit in those stages without replacing the clock. Tracks are pulled into the same callback block, so a later sidechain can read another stem.

Loudness, RMS, correlation, width, onsets, and spectrum inside the audible band can later be measured from the 48 kHz proxy. True peak, crest factor, the source-mix sum, and anything above 20 kHz stay on the original file. Playback does not call Python.

The project screen's Audio engine disclosure shows the output rate, buffer fill, underruns, seek prime time, and callback time.

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
│   ├── waveforms/
│   ├── analysis/
│   └── playback/
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

Measurements run in `services/analysis`. The React app never imports that package. It validates JSON with `@audiosous/analysis-contract` (`contractVersion` 1, `analysisVersion` `0.4.0`). Suggest sections still uses cached peak energy and does not start Python. The desktop queue runs one analysis at a time. A newer, higher-priority measurement cancels the job that is no longer the one on screen.

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

A measurement includes peak dBFS, RMS dBFS, integrated LUFS, crest factor, stereo balance, correlation, width, and mid/side level, plus dynamic range, onset density, and active/silent time. Spectral centroid, bandwidth, rolloff, and flatness sit beside the eight-band energy share, a 48-bin spectrum, a loudness timeline, and a spectrogram. The scope is the whole stem, a section, a time range, or the source mix. The source mix sums the raw stem files in short blocks. Faders, mute, and pan are not part of it, and it is not the mix coming out of the speakers. Stems in one source-mix measurement must share a sample rate.

Long files are read in blocks. The sidecar keeps filter state, a spectrum average, and the drawings, not the whole stem. Comparison, overlap, section energy, and the activity map are derived in the UI from those measurements. They do not start a separate analysis operation. Frequency overlap is the shared band energy. It is not a masking model.

A cache entry is current when the analysis version, file identity, and requested scope all match. Whole-stem cache is `cache/analysis/<trackId>.json`. A section uses `<trackId>__section-<sectionId>`. A time range uses `<trackId>__range`. The mix uses `cache/analysis/mix.json`. Changing a fader does not invalidate a measurement. Changing the stem file, the selected window, or the analysis version does. Drawings stay out of `project.amix`.

`analyze_audio` runs off the UI thread, so playback keeps the existing clock. The desktop app looks for `services/analysis/.venv/bin/python`, or `AUDIOSOUS_PYTHON`. A late result for a stem the user already left is ignored. The dev build is not yet a packaged sidecar.

## Tauri and Web Audio

The desktop shell owns the device. The webview does not stream PCM for playback. Header inspection still uses small ranged reads. Desktop waveform measurement reads each stem in Rust and reports progress while it runs. Absolute paths are resolved in the shell and are not written into `project.amix`.

The legacy webview clock remains for the browser preview and for `AUDIOSOUS_AUDIO_ENGINE=legacy`:

1. **Memory.** It must not decode every stem into one `AudioBuffer`.
2. **One clock.** Every stem shares one `AudioContext`. Independent `<audio>` elements are disallowed.
3. **Seek and loop.** Both restart against that context time.
4. **Sample rate.** That path low-pass filters each window before scheduling. It is not the production engine.

## Logging

Structured events for this slice: `project.create`, `project.open`, `project.save`, `track.import`, `track.decode.failure`. The desktop shell appends JSON lines to the application log directory. Playhead motion is not logged.

## Milestone 1

Included: the shell, schema version 1, WAV/AIFF import, waveform cache, one shared playback clock, mute/solo/gain/pan, manual sections, section and track × section intent, looping a range or a section, undo/redo, explicit save plus autosave after an edit settles, and experimental section suggestions from cached peaks.

Not included: spawning the Python sidecar, DSP, and every later item listed in `docs/milestones.md`. Source WAVs are never modified. A 32-stem project is read in short windows, not decoded into one buffer per stem.
