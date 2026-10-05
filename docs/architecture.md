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
│   ├── analysis-contract/ Versioned JSON DTOs for the analysis sidecar
│   └── balance-planner/   Deterministic gain-only AutoBalance. No DSP and no network.
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
  → balance-planner

balance-planner → project-model, analysis-contract
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

Four reader threads fill one `rtrb` ring per stem. Each ring holds about 5 seconds; playback starts after about 1 second is buffered, and readers keep about 3 seconds filled. Proxies are built one stem at a time. One builder keeps the machine responsive: it does not saturate the CPU or the disk, and Play waits until every required proxy is ready before the transport advances. Stems do not fade in one by one.

The device callback reads the ring consumers, an atomic mix snapshot, and the smoothed gain atomics. It ramps gain over about 10 ms, applies pan or balance, honors mute and solo, sums, and copies the block. A dry ring writes silence for that stem only and counts one underrun for the block. The callback does not allocate, free, lock, read disk, resample, log, or call JavaScript, Tauri, or Python. It does read the clock once so the diagnostics panel can show callback time. The cpal error callback stores an atomic flag and does not allocate either.

The control thread publishes mixer state by writing atomics between an odd and even sequence, so the callback copies a consistent snapshot or retries. Ring consumers are not behind a mutex. The callback and the device-rate mixer set `in_callback` or `mixer_busy` before touching them and leave immediately when playback is not consuming. The control thread clears that flag, waits until both are idle, and only then replaces or flushes rings. Seek bumps a generation so an in-flight read cannot enter the new rings, then flushes every ring before readers continue.

Loop wrap is the same frame on every stem. The reader reaches the loop end and continues from the loop start in the same fill, so a primed ring has no intentional gap. An empty ring at the wrap is an underrun, not a silent skip of the transport.

A mono stem uses equal-power pan. A stereo stem uses the same coefficients as a balance control: the left sample is scaled by the left coefficient and the right sample by the right coefficient, with no crossfeed. The lane calls that control Balance on stereo stems and Pan on mono stems. A later mixer can add a true stereo panner.

If the device is not 48 kHz float, a mixer thread outside the callback does the rate conversion. Its stereo, planar, and interleaved buffers are allocated once and reused. The callback only copies from that device ring, or converts float to 16-bit from a buffer allocated when the stream opened.

Steady-state playback memory is the rings plus a small scratch buffer per reader. A 5-second stereo float ring is about 1.9 MB, so 11 stems are about 21 MB, 32 stems about 61 MB, and 64 stems about 123 MB. The proxy file stays on disk. The reader never loads it whole.

The mix order is read, then a per-track process stage that is currently identity, then gain, pan, sum, then a mix-bus stage that is currently identity. Later EQ, dynamics, and sidechain can sit in those stages without replacing the clock. Tracks are pulled into the same callback block, so a later sidechain can read another stem.

Loudness, RMS, correlation, width, onsets, and spectrum inside the audible band can later be measured from the 48 kHz proxy. True peak, crest factor, the source-mix sum, and anything above 20 kHz stay on the original file. Playback does not call Python.

The project screen's Audio engine disclosure shows the engine kind, device format, output rate, callback size, proxy progress, buffer minimum and average, reader backlog, underruns, seek prime time, and callback time against the callback budget. A line in that panel notes when callback time exceeds 70% of the budget. It is not a user-facing alarm.

`npm run stress:audio` runs the ignored release tests: synthetic 32×48 kHz, 32×96 kHz, 11×192 kHz, and 64×48 kHz mixes, then a 5-minute offline soak of Generated 5 and Generated2 when those projects are on disk. CI runs `cargo test --workspace` and does not open a sound device. The soak and the synthetic stress tests are marked ignored so CI stays short. Compare a debug run with `cargo test -p audiosous-audio --lib -- --ignored --nocapture` only when investigating; acceptance numbers come from the release command.

## Test assets

Commit small deterministic sources, `project.amix`, generator code, and a golden file only when a test reads those exact bytes. Do not commit playback proxies, waveform caches, analysis cache output, or user-sized stems. `test-assets/**/cache/` is ignored. Generated2 and Generated 5 stay as local regression projects: 11 stereo 192 kHz 32-bit stems, about 141 seconds and 217 MB each. Their caches are rebuilt by the app.

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

## AutoBalance

Milestone 3 is gain-only automatic mixing. It is not a mix agent, and it does not add EQ, compression, limiting, panning, or a loudness target.

```text
analysis cache
    → measured facts
    → balance planner
    → mix plan
    → candidate overlay
    → native playback
    → apply into project gain
```

The analysis sidecar still only reports measurements. `@audiosous/balance-planner` decides what those measurements imply. The plan is a versioned JSON document (`planVersion` 1, `plannerVersion` 3.1.0): anchor, per-row confidence, reasons, global gain, and section gain offsets. It is deterministic for the same project, analysis, roles, intent, gains, and strength. It does not call a model.

### Levels

The planner compares the active part of each stem, taken from the cached loudness timeline: points within 18 dB of the stem's own loudest point and above −55 dBFS. Sparse stems are not turned up to match a full-song number.

That timeline is unweighted RMS. Unweighted RMS ranks a sub-heavy bass far above a bright lead that sounds as loud. On the Sub Operator stems the gap between K-weighted loudness and active RMS ranged from −5.1 dB to +7.5 dB per stem. So each stem's active level is shifted by its own offset, integrated LUFS minus whole-file active RMS, clamped to ±8 dB. The section shape still comes from the timeline. Without a measured LUFS the raw active RMS is used.

### References and hierarchy

- The anchor is the first active Primary in the order kick, vocal, lead, bass, drums. It is not moved.
- A Primary element is compared with the anchor in the same section. Primaries are not compared with each other. Otherwise two of them would chase each other and swap places. Where the anchor is not playing, Primaries get no section opinion.
- Supporting, Background, and Focal elements are compared with the loudest Primary or Focal element in that section.
- A peer only counts as a section's reference when it is established there: at least 35% active and no more than 6 dB under its own song level. A lead fading in under an intro pad is not the intro's reference. Without one, the anchor's song level is used.
- A Primary element playing more than 6 dB under its own song level in a section (a fade-in, a quiet passage) is treated as an arrangement choice, not a balance error.
- Two Primaries within the Primary tolerance (2 dB on Normal) are left alone. The correction ramps to full at twice the tolerance.
- A Primary that reads louder than a kick anchor gets a wider window (6 dB on Normal). Integrated loudness reads a sustained bass or synth several LU hotter than a transient kick that sounds as loud.
- Supporting elements are kept about 2.5 dB under the reference, and Background elements about 9 dB under it. These are ceilings, not targets. A quiet supporting stem is not raised to the ceiling.
- Focal elements are lifted to about 1 dB over the reference.

The plan always covers the whole song. The timeline selection does not narrow it, and the AutoBalance panel says so along with how much of the song the sections cover. Time outside every section (gaps of 1 s or more) is still measured. It feeds the track-wide decision only and never gets a section row of its own. When sections cover less than 95% of the song, the plan summary says how much they cover.

One follow-up pass checks supporting and background rows against the same reference and deepens a cut by up to 1 dB if the first pass left the stem too loud. Global changes are preferred. A section row is added when that section's tier differs from the track's default, or when one section disagrees with the others by more than the section residual.

### Intent

Intent is read by a fixed phrase table in `packages/balance-planner/src/intent.ts`. It is not language understanding. Only level and prominence are read. Tone words such as big, punchy, warm, airy, wide, aggressive, tight, crunchy, and smooth never change gain on their own.

A note is split into clauses at `.`, `!`, `?`, `;`, and line breaks. Each clause is read on its own, so in "Big and punchy. Trumpets should dominate." only the second clause counts.

| Reading | Phrases |
| --- | --- |
| Focal | dominate, dominant, more dominant, prominent, more prominent, stand out, more present, louder, focal, feature, featured, foreground, up front, take the lead, solo, and bring / push / pull / turn / move … forward or up |
| Background | less prominent (also less dominant / present / loud / forward / featured), quieter, softer, lower in the mix, recede, receding, recessed, underneath, behind, tuck, tucked, subtle, background, sit back, out of the way, and pull / push / sit / set / move / turn / bring / tuck / ease … back, down, or away |
| Primary | primary, foundation, front and center |
| Supporting | supporting, support, accompaniment |

A clause with a negation (don't, do not, not, never, no longer, shouldn't, isn't, aren't) is ignored. A clause with two different readings is ignored. A note whose clauses disagree is ignored.

**Track × Section note.** The note on one stem inside one section. A clause that clearly names a different stem is skipped, so "Let the lead dominate" written on the pad row does not lift the pad.

**Section note.** A clause counts only if it carries a level reading and names a stem. Stems are matched by name, custom label, role label, and a few role aliases (brass: trumpet, horn, trombone, sax; strings: violin, viola, cello; vocal: vox, voice, singer; and similar). Words are compared lowercase with a simple plural strip, so "Trumpets" matches "Trumpet". The longest match wins, so "Trumpet 2" names one stem. A name match beats a role match for the same word. The words after than / behind / under / below / over / above / against / relative to / compared to name the reference, not the target, so in "Make the pad quieter than the lead" only the pad moves. "take the lead" is not read as the Lead stem. Section names such as drop, verse, or build never identify a stem on their own.

If a word matches more than one stem, for example "Trumpet" with stems Trumpet 1 and Trumpet 2, the instruction is not applied. The plan summary says which stems it could mean and asks for the stem name or a prominence setting.

**Precedence**, highest first:

1. Track × Section prominence (Primary, Focal, Supporting)
2. Track × Section note
3. Section note naming that stem
4. Track role

**Confidence.** A row starts from the role, activity, and agreement of its level figures. Explicit prominence adds 0.08, a Track × Section note 0.06, and a section note 0.04. A row read from a Track × Section note is capped at 0.90 and one read from a section note at 0.85, so a phrase match never reads as certain as a structured setting. A track that an ambiguous section note might have meant loses 0.08 in that section. Rows read from a note quote the clause in their reasons.

Intent sets a relationship, not a fixed move. "Make the pad quieter" makes the pad a Background element in that section. If the pad already sits 9 dB under the reference, nothing changes. A section row never pushes against its own intent: a quieter section is not held up against a track-wide cut, and a Focal section is not held down.

### Apply, preview, and stale plans

The plan is ephemeral. Applying it writes `track.gainDb` and, where a section offset remains, `sectionTrackSettings.overrides.gainDb`. That is one undo step. Source files and playback proxies are not rewritten. Apply all takes proposed and accepted rows. Apply accepted takes only accepted rows. Rejected and needs-review rows stay out unless accepted.

Preview is a candidate overlay on the saved mix. The native engine keeps the base fader and a lock-free list of up to 96 section gain windows. A window sets the target of the existing per-sample gain slew, so its edges ramp over at most 10 ms instead of stepping. Changing the preview does not reload proxies or restart the device. The browser preview follows the playhead in the UI and ramps gain over about 20 ms. Single-row A/B plays that stem at its saved gain or its recommended gain with everything else at the saved mix and no trim. Cancel discards the overlay.

A plan is marked out of date when gain, role, mute, sections, section intent, track × section intent or prominence, settings, or source identity change. A stale plan cannot be previewed or applied. Selecting a row (track, section, playhead) does not make the plan stale. Strength is Conservative (±2 dB), Normal (±4 dB), or Strong (±6 dB). Moves past ±6 dB before the cap are marked for review and are not part of Apply all until accepted.

### Headroom trim

The candidate trim is a separate gain added to every stem, so the relative balance stays. It is computed from each stem's cached peak and the rows that would actually play: a power sum of the stem peaks plus 1 dB. If that estimate for the candidate is hotter than the current mix's estimate, or than −1 dBFS when the current mix is under that, the trim brings it back, up to −6 dB. Accepting, rejecting, or editing a row recomputes it, and Apply accepted recomputes it for the accepted rows only. It is an estimate, not a rendered true-peak pass. It is not a limiter, not a loudness target, and not mastering.

### Known limitations

- Gain only. No EQ, compression, masking, stereo, pan, or reverb decisions.
- Levels come from loudness readings. They are not a model of perceived loudness in the mix, and they do not account for masking.
- The hierarchy rules are ceilings. A supporting or background stem that is too loud but still under its ceiling is not pulled back. In the acceptance run a +5 dB atmosphere error was only caught in the intro.
- The kick allowance is a fixed window, not a measurement of transient loudness.
- Intent is a phrase table. Anything outside it is ignored rather than guessed. Notes about tone, space, or dynamics are ignored by Milestone 3.
- The desktop run loads whole-stem measurements. Section levels come from the stem's loudness timeline, not from dedicated section measurements.
- The headroom trim is an estimate from per-stem peaks. Stems that already clip together before AutoBalance still clip.
- The native overlay holds 96 section windows. A larger plan would drop windows past that.

### Acceptance harness

`packages/balance-planner/scripts/plan-project.ts` runs the planner on a project folder and its analysis cache, with roles, gains, sections, and intent edited in memory from a scenario file. It prints the plan and its timing. `render-audition.py` bounces Current and AutoBalance to WAV with the same section windows and a 10 ms ramp, for listening.

```sh
npx vite-node packages/balance-planner/scripts/plan-project.ts -- scenario.json
services/analysis/.venv/bin/python packages/balance-planner/scripts/render-audition.py OUT_DIR
```

## Tauri and Web Audio

The desktop shell owns the device. The webview does not stream PCM for playback. Header inspection still uses small ranged reads. Desktop waveform measurement reads each stem in Rust and reports progress while it runs. Absolute paths are resolved in the shell and are not written into `project.amix`.

The legacy webview clock remains for the browser preview and for `AUDIOSOUS_AUDIO_ENGINE=legacy`:

1. **Memory.** It must not decode every stem into one `AudioBuffer`.
2. **One clock.** Every stem shares one `AudioContext`. Independent `<audio>` elements are disallowed.
3. **Seek and loop.** Both restart against that context time.
4. **Sample rate.** That path low-pass filters each window before scheduling. It is not the production engine.

## Logging

Structured events include `project.create`, `project.open`, `project.save`, `track.import`, `track.decode.failure`, the analysis cache events, and `autobalance.start`, `autobalance.complete`, `autobalance.apply`, `autobalance.cancel`, and `autobalance.stale`. `autobalance.complete` records `analysisMs` (loading or measuring every stem) and `durationMs` (the planner alone) separately. The desktop shell appends JSON lines to the application log directory. Playhead motion is not logged, and AutoBalance logs do not include the plan body.

## Milestone 1

Included: the shell, schema version 1, WAV/AIFF import, waveform cache, one shared playback clock, mute/solo/gain/pan, manual sections, section and track × section intent, looping a range or a section, undo/redo, explicit save plus autosave after an edit settles, and experimental section suggestions from cached peaks.

Not included: spawning the Python sidecar, DSP, and every later item listed in `docs/milestones.md`. Source WAVs are never modified. A 32-stem project is read in short windows, not decoded into one buffer per stem.
