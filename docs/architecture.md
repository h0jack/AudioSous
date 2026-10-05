# Architecture

Audiosous is a local desktop application. Milestone 1 did not mix, host plugins, or call a model. It exists so later analysis and DSP can sit on a stable project, a single playback clock, and a selection context.

## Repository layout

```text
Audiosous/
├── apps/desktop/          React + Vite UI and the Tauri shell
├── crates/audio-engine/   Native playback clock, proxies, and device output
├── packages/
│   ├── project-model/     Versioned .amix schema, migrations, roles, import checks
│   ├── audio-files/       WAV and AIFF header inspection (no full decode)
│   ├── audio-engine/      Playback interface. Desktop uses the Rust engine; the browser preview uses Web Audio.
│   ├── analysis-contract/ Versioned JSON DTOs for the analysis sidecar and the EQ band cache
│   ├── balance-planner/   Deterministic gain-only AutoBalance. No DSP and no network.
│   ├── eq-planner/        Frequency interaction analysis and deterministic static-EQ planning. No network.
│   ├── spatial-planner/   Stereo-field interaction analysis and deterministic pan/width planning. No network.
│   └── dynamics-planner/  Time-domain dynamics analysis and deterministic compressor/duck/transient/dynamic-EQ planning. No network.
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
  → eq-planner
  → spatial-planner
  → dynamics-planner

balance-planner → project-model, analysis-contract
eq-planner → project-model, analysis-contract, balance-planner (tiers, intent, headroom)
spatial-planner → project-model, analysis-contract, balance-planner (tiers, intent, headroom), eq-planner (spectral model, pairs)
dynamics-planner → project-model, analysis-contract, balance-planner (tiers, intent clauses), eq-planner (spectral model, pairs, responses)
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

The on-disk document is schema version 4. The shape is **song → sections → tracks → track × section**. Tracks, manual sections, section intent, and track × section intent can be edited.

Persisted now:

- sections, including source, confidence, and `structuralGroupId`
- a per-track processing graph of static EQ nodes (schema v2, see [Frequency interaction and EQ](#frequency-interaction-and-eq)) and dynamics nodes (schema v4, see [Dynamics planning](#dynamics-planning))
- per-track pan and stereo width (schema v3, see [Stereo and spatial planning](#stereo-and-spatial-planning))
- track × section intent, optional prominence (`primary` / `focal` / `supporting`), gain/pan/width overrides, and a Track × Section EQ graph that adds to the track's own
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

The device callback reads the ring consumers, an atomic mix snapshot, and the smoothed gain atomics. It ramps gain over about 10 ms, applies width and pan or balance (ramped over 30 ms since Milestone 5), honors mute and solo, sums, and copies the block. A dry ring writes silence for that stem only and counts one underrun for the block. The callback does not allocate, free, lock, read disk, resample, log, or call JavaScript, Tauri, or Python. It does read the clock once so the diagnostics panel can show callback time. The cpal error callback stores an atomic flag and does not allocate either.

The control thread publishes mixer state by writing atomics between an odd and even sequence, so the callback copies a consistent snapshot or retries. Ring consumers are not behind a mutex. The callback and the device-rate mixer set `in_callback` or `mixer_busy` before touching them and leave immediately when playback is not consuming. The control thread clears that flag, waits until both are idle, and only then replaces or flushes rings. Seek bumps a generation so an in-flight read cannot enter the new rings, then flushes every ring before readers continue.

Loop wrap is the same frame on every stem. The reader reaches the loop end and continues from the loop start in the same fill, so a primed ring has no intentional gap. An empty ring at the wrap is an underrun, not a silent skip of the transport.

A mono stem uses equal-power pan. A stereo stem uses the same coefficients as a balance control: the left sample is scaled by the left coefficient and the right sample by the right coefficient, with no crossfeed. The lane calls that control Balance on stereo stems and Pan on mono stems. Milestone 5 adds stereo width before it; see [Stereo and spatial planning](#stereo-and-spatial-planning).

If the device is not 48 kHz float, a mixer thread outside the callback does the rate conversion. Its stereo, planar, and interleaved buffers are allocated once and reused. The callback only copies from that device ring, or converts float to 16-bit from a buffer allocated when the stream opened.

Steady-state playback memory is the rings plus a small scratch buffer per reader. A 5-second stereo float ring is about 1.9 MB, so 11 stems are about 21 MB, 32 stems about 61 MB, and 64 stems about 123 MB. The proxy file stays on disk. The reader never loads it whole.

The mix order is read, then the per-track process stage (static EQ since Milestone 4: track filters, then the filters of the section under the playhead; dynamics since Milestone 6: dynamic EQ, compressor, transient, ducking; then width since Milestone 5), then pan or balance, gain, sum, then a mix-bus stage that is still identity. EQ sits before the fader so a fader move never changes what the filter sees, and before pan so both channels are filtered the same. Since Milestone 6 every track's frame is pulled before any track is processed, so a sidechain key exists for the frame whatever the track order.

Loudness, RMS, correlation, width, onsets, and spectrum inside the audible band can later be measured from the 48 kHz proxy. True peak, crest factor, the source-mix sum, and anything above 20 kHz stay on the original file. Playback does not call Python.

The project screen's Audio engine disclosure shows the engine kind, device format, output rate, callback size, proxy progress, buffer minimum and average, reader backlog, underruns, seek prime time, and callback time against the callback budget. A line in that panel notes when callback time exceeds 70% of the budget. It is not a user-facing alarm.

`npm run stress:audio` runs the ignored release tests one at a time: synthetic 32×48 kHz, 32×96 kHz, 11×192 kHz, and 64×48 kHz mixes, the EQ, EQ + spatial, and EQ + spatial + dynamics callback cost, then a 5-minute offline soak of Generated 5 and Generated2 when those projects are on disk. Running them in parallel skews each other's timing, and the 64-stem stereo test writes about 450 MB of synthetic stems to the temp directory (set `TMPDIR` to put them elsewhere). CI runs `cargo test --workspace` and does not open a sound device. The soak and the synthetic stress tests are marked ignored so CI stays short. Compare a debug run with `cargo test -p audiosous-audio --lib -- --ignored --nocapture` only when investigating; acceptance numbers come from the release command.

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

Saved Track × Section gain plays in both engines. Before Milestone 4 the engines only received section windows while an AutoBalance preview was running, so a section gain written by Apply was saved but not heard. The shared monitor path in `apps/desktop/src/lib/monitor.ts` now sends saved section gain, the AutoBalance audition, saved EQ, and the EQ audition together.

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

## Frequency interaction and EQ

Milestone 4 is static EQ planning. It finds where two stems compete for the same frequencies while they play together and proposes conservative, explainable filters. It does not compress, use dynamic EQ, pan, widen, add effects, limit, or master. It does not call a model.

```text
playback proxy ──► EQ band frames (Rust) ─┐
analysis cache ───► measurements ─────────┼─► spectral model ─► pairwise interactions ─► EQ planner
project ──────────► faders, section gain, ┘        (current mix state)                     │
                    saved EQ, roles, intent                                                 ▼
                                               versioned EQ plan ◄── evaluation (2 passes + whole plan)
                                                      │
                                                      ├─► proxy check (native filters on the proxies)
                                                      ├─► candidate overlay ─► native engine ─► A/B
                                                      └─► apply ─► processing graph nodes (one undo step)
```

### Spectral data

EQ needs low-frequency resolution that the sidecar spectrogram does not have. That spectrogram is drawn for the eye with 1024-point FFTs per column, so at 192 kHz its bins are 187 Hz wide and everything under about 280 Hz lands in one band. On Generated 5 that put the kick/bass overlap at "150–200 Hz".

So EQ planning reads **EQ band frames**, measured in Rust (`crates/audio-engine/src/bands.rs`) from the 48 kHz playback proxy. The measurement uses 8192-point Hann FFTs with 50% overlap (5.9 Hz bins), the mono mid, and one-sided power scaled so the bins of a segment sum to its mean square. It averages into the planner's 24 log bands, 20 Hz to 20 kHz, on frames of `max(0.25 s, duration / 360)`. A 96-bin whole-file spectrum is kept for placing a filter inside a band. Each stem is read once, in blocks, and the result is cached as `cache/analysis/<trackId>__eqbands.json`. The cache identity is the band measurement version (1), the source size and modification time, the proxy version, and the resampler id. The sidecar's `analysisVersion` did not change, so no existing measurement was invalidated. A 141 s stem takes about 65 ms in a release build.

If a stem has no band frames, the planner falls back to the sidecar spectrogram and the plan summary says the low end is less certain.

The **spectral model** (`packages/eq-planner/src/spectra.ts`) puts every unmuted, measured stem on one project time grid. Each band power is shifted by the current fader, the Track × Section gain override where one applies, and the averaged power response of the saved EQ (track nodes plus the section's nodes). That analyzes the mix as it is now. If AutoBalance was applied, its gains are used. Adding a gain in dB to a power in dB is exact. Multiplying a band power by a static filter's band-averaged power response is close for a spectrum that is smooth inside the band. A step counts as active when it is within 30 dB of the stem's loudest step, above −65 dB before the fader, and above −80 dB after it.

### Interaction analysis

Overlap is not masking. The existing band overlap (shared band-energy share) is still reported, but the planner works from a narrower question:

> Of the energy that defines the more important stem, weighted by what matters for its role, how much sits in bands where the other stem is at a comparable or louder level, during the time both play?

For each pair and each scope (the whole song, each section, and each unmarked gap):

1. **Simultaneous activity.** Only steps where both are active count. A pair that shares fewer than 2 steps, or less than 10% of the sparser stem's activity, is not an interaction, whatever its spectra look like.
2. **Band levels.** The mean band power of each stem over those shared steps.
3. **Competition per band.** victim share × role weight × `1 / (1 + e^-(Δ+4)/2.5)`, where Δ is the competitor's level minus the victim's in dB. That is 0.5 when the competitor is 4 dB under, about 0.83 at equal level, and near 0 at 12 dB under.
4. **Role weights** (`regionWeight`) say which ranges matter for a role. Kick: 40–120 Hz, plus click at 2–6 kHz. Bass: 35–250 Hz. Snare: 150–300 Hz and 1–6 kHz. Hi-hat: 5–14 kHz. Lead, vocal, and melodic parts: 1–5 kHz first, then 300 Hz–1 kHz. Pads and atmospheres: broad and low. A stem marked Focal in a section also counts as melodic there.
5. **Masked fraction.** The weighted competition divided by the victim's weighted identity, 0 to 1.
6. **Severity.** `1 − e^(−masked/0.5)`, times an activity factor (√simultaneity × coverage), times a stereo factor that lowers concern by up to 35% when the two stems sit apart (pan plus measured balance, discounted by width). Both centered and simultaneous keeps full concern. Severity is an Audiosous decision heuristic, not a masking percentage.
7. **Regions.** Up to two broad regions of at most seven bands (about three octaves) are grown around the peak of the competition. Each has its range, center, shared energy, masked share, level difference, severity, and persistence (the share of the shared time the competitor stays within 6 dB).
8. **Confidence** rises with simultaneity, shared seconds, and persistence, and falls for unlabeled roles and for equal or layered pairs.

**Priority.** Tiers come from the same resolution AutoBalance uses (`balance-planner/src/tiers.ts`). The highest precedence is Track × Section prominence, then a Track × Section note, then a section note naming the stem, then the role. The whole-song tier is the tier that holds for most of the stem's active time. Kinds:

| Kind | When | Priority |
| --- | --- | --- |
| kick-bass | the roles are Kick and Bass | 1.0 |
| lead-support | a lead, vocal, or Focal stem over a pad, synth, keys, guitar, strings, brass, backing vocal, or atmosphere | 1.0 |
| hierarchy | different tiers | 0.85 under Primary, 1.0 under Focal, 0.6 Primary over Background, 0.45 between lower tiers |
| equal | same tier | no automatic yielder |
| layered | same role, or names that differ only by a number or side (Gtr L / Gtr R) | halved, and no move without a stated hierarchy |

Work is bounded. Muted stems, stems more than 36 dB under the loudest stem, and Background/Background pairs are skipped. 32 stems is at most 496 pairs × scopes, each 24 bands over the grid. Generated 5 (11 stems, 5 sections) analyzes 33 pairs and plans in 50–90 ms.

### Who yields

- Only a **Primary or Focal** stem makes another stem give way. Supporting parts share their space; that is the arrangement.
- The **lower tier yields**. A Supporting pad is cut for a Focal lead; the lead is never cut for the pad.
- **Equal tiers** have no automatic yielder. Kick and Bass are both Primary by role. The plan says so in words ("Kick and Bass overlap strongly from 36–63 Hz, but both are Primary and neither has a clear priority. No automatic EQ change was proposed.") unless the kick is clearly the transient owner of a concentrated fundamental: crest ≥ 10 dB, ≥ 0.8 hits a second, at least 30% of its level at 40–150 Hz, and the bass sustaining over it. In that case a small bass cut at the kick's strongest low bin is offered for **review only** (confidence 0.48). Marking Bass Supporting (or Kick Focal) in the sections turns that into a normal recommendation. Marking Bass Focal makes the kick yield.
- **Layered** parts are left alone unless the user has stated a hierarchy.
- A pair is never cut both ways in the same place.

### Filters

- **Separation cut.** A bell on the yielding stem. The center comes from the competition-weighted center of the region, refined with the fine spectra toward where both stems are strongest. For kick/bass it sits on the kick's strongest bin under 200 Hz. Frequencies are rounded to two significant figures (82 Hz, 2.4 kHz). Q comes from the region width (0.6–2.0, 0.9–2.0 for kick/bass). The size targets a gap after the move read off the competition curve: 6 dB under a Focal stem or over a Background yielder, 4 dB otherwise, 3 dB for kick/bass. It takes 40/50/60% of that (Conservative/Normal/Strong) scaled by severity, then caps it.
- **Saved boosts first.** If a saved, enabled boost on the yielding stem adds at least 1.5 dB in the conflict range, the recommendation reduces that node instead of stacking a cut on it ("Reduce MasterEQ's saved bell +6.0 dB at 2.5 kHz to −1.0 dB because …"). Undoing a boost may go past the cut limit, stops at −1 dB, and is not capped as a loss of identity. A saved node of the same kind within half an octave is also replaced rather than duplicated (`replacesNodeId`).
- **Level, not EQ.** If the competing level would still be more than 6 dB over the protected stem after the largest allowed correction, no filter is planned. The plan says the gap is a level or arrangement problem.
- **High-pass** only from measurements: a Supporting or Background stem (and, with less confidence, a lead or vocal) whose energy below a corner is at least 2% of its level and at most 15%, with Kick and Bass at least 6 dB louder there while they play together, persistently. The corner is the highest point where that holds, under a role cap (300 Hz hi-hat, 140 Hz pad, 90 Hz vocal, …). Kick, bass, drums, and unlabeled stems never get one. There is no preset.
- **Low-pass** is rare and always for review: a Background stem or pad that keeps at least 10% of its level above 8 kHz and sits within 3 dB of a hi-hat, lead, vocal, or snare up there.
- **Presence boost** only for a lead, vocal, or Focal stem crowded in its presence range by the rest of the mix when no single lower-tier stem is responsible (if one were, cutting it is the better move). It is at most +1.5 dB at Q 0.8, and dropped if it makes the lifted stem crowd an equal or higher-tier stem more.
- **Tone words** in section and Track × Section notes come from a short table (harsh, muddy, boomy, boxy, nasal, too bright / darker, thin, dull / brighter). A word only proposes where to look: harsh means 2–5 kHz, muddy 200–500 Hz, and so on. The stem's band levels during that section must confirm it against a straight-line fit of its own spectrum (±1.5 dB) before a filter is planned. The move is sized from the measured excess. Negated clauses, clauses naming no single stem, and level words ("Trumpets should dominate") are not tone requests. When the measurement disagrees, the plan says so and changes nothing.

### Global or section

Global filters are preferred. A conflict becomes one track-wide filter when the agreeing scopes (region centers within ¾ octave) cover at least half of the time the yielding stem plays. Otherwise a section filter is planned. It needs a reason the rest of the song does not have: prominence or a note in that section, or a protected stem that plays mostly (≥ 70%) there. A section filter runs after the track's filters, so it only adds what the track-wide filter leaves. When the track-wide filter already covers it, none is added. Track-wide and section cuts together never pass the strength's cut limit at one frequency.

### Regularization and limits

| Strength | Max cut | Max boost | New filters per track (global / section) | Min severity | Max own-level loss |
| --- | --- | --- | --- | --- | --- |
| Conservative | 2 dB | 1 dB | 2 / 1 | 0.50 | 0.6 dB |
| Normal | 3.5 dB | 2 dB | 3 / 2 | 0.40 | 1.0 dB |
| Strong | 6 dB | 3 dB | 3 / 2 | 0.33 | 1.5 dB |

Planner output stays within Q 0.4–4. Broad moves use at most Q 2. Moves under 0.5 dB are not made. Each move has a cost (base, gain, Q above 1.5, section scope, boost, a Primary or Focal target) and a benefit (severity × priority × how far it actually pulls the competition down). A move survives only when its benefit beats its cost. Two cuts on one track less than 0.6 octave apart merge into one broader cut. At most two stems are carved for one protected stem at one place. A track that wants more filters than its limit keeps the best ones and loses confidence on them. Saved nodes count toward the engine's 6 track and 4 section slots.

A recommendation goes to review, and stays out of Apply all until it is accepted, when confidence is under 0.55, a cut is deeper than 4 dB, a boost is over 2 dB (taking back a saved boost counts as a cut), Q is over 2.5, or the move is a low-pass, a kick/bass call between equal priorities, a large tone boost, or a filter the proxy check could not confirm.

### Evaluation

Every move is checked before it is shown. There are at most two planning passes and no open-ended loop.

1. **Spectral transfer, pass 1.** The filter's response (divided by the response of a node it replaces) is applied to the band levels the move was planned from. Two numbers decide. First, how far it pulls the competitor under the protected stem inside the conflict, weighted by where the conflict is (`gapReductionDb`). Second, the same against everything else playing at that time (`contextGapReductionDb`). A move must pull the competitor at least 0.4 dB and 30% of its own peak gain further under, and the whole competing mix at least 0.5 dB and 20% of its gain. Otherwise it is dropped. That is what stops the planner from carving one of four pads for a lead buried in a dense arrangement, and from keeping a filter that sits off the conflict. A cut that would take more than the strength's limit from its own stem overall is scaled down and checked once more.
2. **Correction pass.** The spectral model is rebuilt with the first-pass filters in place. Separation conflicts are looked for once more, only on stems and ranges the first pass did not touch, within the remaining limits. On the problem mix below, this is how the second of two boosted synths was found.
3. **Whole plan.** Every kept filter is applied to the model at once and each targeted conflict is measured again. The summary reports how much further under the protected stems the competitors sit. A boost that makes its stem crowd others is dropped.
4. **Proxy check (desktop).** Each filter runs through the native filter code over the 48 kHz proxy, for up to 20 s of the windows where the stems overlap (`crates/audio-engine/src/verify.rs`, Tauri `eq_check`). The check measures the level inside the conflict range (fourth-order band edges) and overall, with and without the filter. A filter whose measured in-range change is much smaller than predicted, or under 0.3 dB, goes to review with the numbers in its reasons.

Editing a recommendation reruns step 1 for that row from the band levels stored in the plan, and recomputes the headroom trim. It does not rerun the planner, and it does not reread audio.

### Plan contract

`packages/eq-planner/src/plan.ts`: `planVersion` 1, `plannerVersion` 4.0.0, `kind: "frequency-balance"`. The plan has the same envelope as the AutoBalance plan (`kind: "auto-balance"`): version, project id, analysis version, settings, state identity, summary, a headroom trim, and per-stem levels. A later combined mix plan can hold both. Each recommendation has the track, the scope (`global` or `section`), `processing: { type: "eq", filter }`, the filter as planned, the node it replaces, the protected stems, the interaction ids, the purpose (separation, low-end, high-end, intent, presence), confidence, status, an edited flag, 1–6 reasons, the evaluation, and the band levels it was judged on (for drawing and re-checking). The plan also carries the top 40 interactions with their regions, outcome, and explanation. Everything is plain JSON validated with zod.

**Stale identity** covers the project id, analysis version, planner version, strength, and each stem's id, name, label, role, gain, pan, mute, duration, and file identity. It also covers sections (bounds, type, intent), Track × Section prominence, notes, and gain and pan overrides, and every saved EQ node (enabled, kind, frequency, gain, Q). A stale plan cannot be previewed or applied. Selecting a row is not an edit.

### Preview, A/B, apply, undo

The candidate is an overlay: saved processing plus the included filters, through the same monitor path that carries the AutoBalance audition. **Current** plays the saved mix. **EQ Candidate** plays the proposed and accepted rows, plus a safety trim when boosts need one. **Bypassed / With filter** on a row plays the whole mix with only that filter switched, without the trim. Starting an EQ audition stops a gain audition, so one comparison plays at a time. Edits are heard on the next publish. The engine ramps each changed band over 30 ms, and nothing reloads.

**Apply all** writes proposed and accepted rows. **Apply accepted** writes accepted rows. Each becomes an `eq-plan` node with its reason, in the track graph or the Track × Section graph, replacing a node where the row says so. The safety trim, if any, is added to every fader and section gain. That is one `replaceDocument` with history, so Ctrl+Z restores the whole pre-plan processing graph and gains. Preview never enters history. Source files, proxies, and analysis caches are not touched.

**Headroom.** Cuts are not counted, so the estimate never under-reads. For a boost, the largest band gain it puts where the stem has at least 3% of its level is added to that stem's cached peak in the same power-sum estimate AutoBalance uses. If the candidate sum would get hotter than the current mix or −1 dBFS, a uniform trim (up to −6 dB) is proposed. It is labeled as a safety trim, not an EQ decision.

### Native EQ

`crates/audio-engine/src/eq.rs`. Each band is a second-order section with the RBJ cookbook responses (high-pass, low-pass, bell, low shelf, high shelf), run in Andrew Simper's trapezoidal state-variable form. The magnitude response equals the cookbook biquad's: both are bilinear transforms prewarped at the band frequency, and the tests hold the filter to the cookbook formula within 0.1 dB from 30 Hz to 18 kHz. The SVF form was chosen over a direct-form biquad because its coefficients can move sample by sample without the state blowing up (g and k stay positive along a linear path). So a parameter edit, a section boundary, a seek, or a loop wrap ramps the band over 30 ms (1440 samples) instead of switching it. A band that turns on fades in from bypass at its own frequency and damping, and a band that turns off fades out the same way, so its state is never cold at full mix.

Each track has 10 slots: 6 for track filters and 4 for the section under the playhead. The control thread designs coefficients at 48 kHz from `set_eq` and publishes them through a sequence-locked table of atomics (`PublishedEq`), exactly like the mix snapshot. The audio thread copies the table only when its sequence changes, into memory allocated when the engine was created. It keeps per-track filter state, ramps, and the current section span, and it re-resolves the section only when the playhead leaves that span. A track with no bands is skipped entirely. A bypassed band is bit-exact. Parameters are sanitized (finite, 20 Hz to 0.45 × rate, ±24 dB, Q 0.1–10), and every legal combination is tested for finite, bounded output on noise.

The callback still does not lock, allocate, free, read files, or call JavaScript, Tauri, or Python. `callback_with_eq_does_not_allocate` counts allocations on the audio thread with a counting global allocator through 60 callbacks, an EQ table change, and section boundaries, and expects 0. The probe in that test proves the counter counts. Filter memory lives beside the ring consumers and follows the same ownership handoff. The control thread resets it only while both audio paths are idle.

Callback cost, release build, 512-frame callback (10.67 ms budget), stereo noise stems, paced in real time:

| Stems | No EQ | 1 bell per track | HPF + 2 bells per track + a section bell |
| --- | --- | --- | --- |
| 11 | 0.03 ms | 0.06 ms | 0.11–0.31 ms |
| 32 | 0.13–0.14 ms | 0.20–0.22 ms | 0.30–0.40 ms (2.8–3.8%) |
| 64 | 0.26–0.36 ms | 0.46–0.51 ms | 0.69–0.81 ms (6.5–7.6%) |

Ranges are two runs. All runs had 0 underruns. That leaves headroom for later dynamics.

### Export

There is no final render yet. When export is built, it has to run the same nodes on the original source at its own sample rate, not on the 48 kHz proxy. The response formulas are rate-independent and the planner stores frequencies, gains, and Q, not coefficients. Above about 0.45 × the playback rate the proxy and a high-rate source differ, and the planner never places a filter there.

### Legacy engine

The browser preview and `AUDIOSOUS_AUDIO_ENGINE=legacy` play without EQ. The EQ panel says so. Planning and the proxy check need the desktop app.

### Known limitations

- Severity is a heuristic on 24 bands (about 0.4 octave each). It is not a psychoacoustic masking model and ignores temporal masking.
- Band levels are mono mid. Stereo position is only a discount on severity. Width, pan, and phase are never changed, and correlation is not analyzed per band.
- A filter's effect is predicted from band-averaged responses. The independent Python bounce check and the Rust proxy check agree with the prediction within about 0.6 dB on Generated 5, not exactly.
- Kick/bass priority without a stated hierarchy is a review-only call from crest and onset rate. It does not detect sidechain ducking already in the stems.
- Resonance hunting is out of scope. No narrow (Q > 2) cut is planned except on a low-end fundamental.
- Tone words are a short table. A word outside it is ignored. Confirmation compares a stem with its own spectral tilt, not with a genre reference.
- The level-problem rule hands large gaps to AutoBalance or the arrangement. On Generated 5 the Phase Plant 2 stand-in for trumpets sits 20 dB under the mix in Drop 2, so "Trumpets should be more prominent" plans no EQ.
- The legacy and browser engines ignore EQ.
- The proxy check reads up to 20 s per filter from the 24 longest overlap windows. It confirms the filter's effect on its own stem, not a listening result.

### Acceptance harness

`packages/eq-planner/scripts/plan-eq-project.ts` runs the planner on a project folder with roles, gains, saved EQ, sections, prominence, and notes edited in memory from a scenario file (`EQ_TRACE=1` prints every stage). `crates/audio-engine/examples/eq_bands.rs` fills the band cache the desktop app would. `render-eq-audition.py` bounces Current, EQ Candidate, and the reviewed plan from the proxies with an independent Python implementation of the same filters, and measures each filter's in-range change for comparison with the prediction.

```sh
cargo run --release -p audiosous-audio --example eq_bands -- "test-assets/Generated 5"
npx vite-node packages/eq-planner/scripts/plan-eq-project.ts -- scenario.json
services/analysis/.venv/bin/python packages/eq-planner/scripts/render-eq-audition.py OUT_DIR
```

## Stereo and spatial planning

Milestone 5 is pan, balance, and width planning. It finds stems that compete for the same frequencies while they also sit in the same place in the stereo field, and proposes conservative, explainable moves. It does not use delay, reverb, chorus, decorrelation, or any other way of making stereo out of mono, and it has no frequency-dependent width. It does not compress, EQ, limit, or master, and it does not call a model.

```text
playback proxy ──► stereo frames (Rust) ──┐
playback proxy ──► EQ band frames (Rust) ─┼─► stereo model ─► spatial pairs ─► spatial planner
analysis cache ───► measurements ─────────┤   (current mix:      (M4 pairs +      │
project ──────────► faders, saved EQ, ────┘    fader, EQ, pan,     field overlap)   ▼
                    pan, width, roles, intent   width)            versioned plan ◄── evaluation (2 passes + whole plan)
                                                                       │
                                                                       ├─► proxy check (native spatial stage on the proxies)
                                                                       ├─► candidate overlay ─► native engine ─► A/B
                                                                       └─► apply ─► track pan/width, section overrides (one undo step)
```

### Pan, balance, and width

Three controls, not one:

- **Pan** (mono stem): equal-power position, −1 left … +1 right. The engine's law splits power linearly, `left = √(1 − p)`, `right = √p`, `p = (pan + 1) / 2`, so a centered stem is −3 dB in each channel and a stem panned to `x` has energy balance exactly `x`.
- **Balance** (stereo stem): the same coefficients scale each channel. Nothing is crossfed, so a stereo image moves as a whole and keeps its width.
- **Width** (stereo stem): `M = (L + R) / 2`, `S = (L − R) / 2`, `S ← S · width`, `L = M + S`, `R = M − S`. 0 is mono, 1 is as recorded, 2 is the technical cap. A mono stem ignores width.

The per-track order is:

```text
source → EQ (track, then section) → width → pan / balance → gain → sum
```

Width runs after EQ so a filter sees the stem as recorded, and before pan so balance moves the finished image. Gain and pan are both linear, so their order does not matter; gain stays last, as before.

**No level compensation.** Width never touches the mid, so the mono fold-down of a stem is the same at every width and 100% skips the matrix entirely (bit-exact). Narrowing only removes side energy. Widening adds it: a stem's stereo level changes by `10·log10((M + w²S) / (M + S))`, at most ×2 in amplitude for fully anti-phase material. That change is bounded and deterministic, the planner predicts it from the stem's own mid/side levels and reports it on every row (about +1 dB for a typical 140% widening), and the candidate headroom estimate covers the peaks. A signal-dependent gain inside the DSP would have made the engine's output depend on analysis that might be missing.

### Native spatial stage

`crates/audio-engine/src/spatial.rs`. The control thread publishes a table of whole-song pan and width per track index plus up to 128 section windows (start frame, end frame, pan, width) through a sequence-locked table of atomics, like the mix snapshot and the EQ table. The audio thread copies it only when the sequence moves, into memory allocated when the engine was created. Each track keeps its current and target values, a ramp counter, and the frame span over which its section assignment holds; it re-resolves the section only when the playhead leaves that span.

- Every change, including a section boundary, ramps linearly over 30 ms (1440 frames), whatever its size. Pan coefficients are recomputed only while pan moves.
- At the start of each block, a track that is not ramping and stays inside one section span for the whole block (no loop wrap) gets its width and pan coefficients once, and the inner loop only multiplies. Without that, per-frame bookkeeping made the plain mix 2–3× slower in the throughput test.
- A seek snaps: the control thread marks every track while the audio thread is idle, so playback starts at the new section's values instead of ramping from the old ones. A loop wrap inside one section is not a change.
- Values are sanitized (finite, pan −1…1, width 0…2).
- `set_track` pan still works and feeds the same table, so the lane control and the plan cannot disagree.

The callback still does not lock, allocate, free, read files, or call JavaScript, Tauri, or Python. `callback_with_eq_and_spatial_does_not_allocate` runs 8 stereo stems with EQ, pan, width, and section windows through a spatial table change and expects 0 allocations, with the counter proven by a probe. Tests cover the pan law, balance without crossfeed, width 0/100/150/200%, the mono fold-down at every width, correlation against `(1 − w²)/(1 + w²)` on decorrelated noise, every legal setting finite and bounded, the 30 ms ramp with no step, section windows and their edges, a seek into a section, several tracks and windows, table limits, and the engine end to end.

### Stereo frames

The sidecar reports one balance, correlation, and mid/side figure per stem. Spatial planning needs to know where a stem sits while it plays against another, and in which frequency range, so `crates/audio-engine/src/stereo.rs` measures the 48 kHz playback proxy with 8192-point Hann FFTs on both channels and keeps, per frame and per band, left power, right power, and the left/right correlation. Bands are the EQ grid's 24 log bands taken three at a time (8 bands, 20 Hz–20 kHz); frames use the EQ band grid (`max(0.25 s, duration / 360)`). The cache is `cache/analysis/<trackId>__stereo.json` with the same identity rule as the EQ bands (version 1, source size and modification time, proxy version, resampler id). A 141 s stem takes about 100 ms in a release build.

Without stereo frames the planner shapes each stem's measured band levels with its whole-file balance and mid/side levels, so position and width are the same at every step, and the plan summary says so.

### Stereo statistics

A stem in one band over a stretch of time is three numbers: `E[L²]`, `E[R²]`, and `E[L·R]`. Width and pan are linear and static between ramps, so their effect on these averages is exact: width scales the side power by `w²` and the mid/side cross term by `w`; pan or balance scales each channel's power by its coefficient squared and the cross term by both. That lets the planner simulate any candidate on the cached statistics without touching audio. The Rust test `measures_correlation_and_mono_loss_before_and_after_a_width_change` holds the native DSP to these formulas on real proxy audio, and the acceptance bounce below reproduces them on Generated 5 within about 0.02 in correlation and 0.1 dB in mono loss.

The stereo model (`packages/spatial-planner/src/model.ts`) puts every stem on the EQ planner's time grid as heard: the stem's raw statistics scaled by the fader or section gain and the band-averaged power response of its saved EQ, then placed with the pan and width in effect at each step (section overrides included). From the statistics:

| Reading | Definition | Meaning |
| --- | --- | --- |
| position | `(R − L) / (R + L)` | where the stem sounds; equals the pan value for a panned mono stem |
| correlation | `C / √(L·R)` | +1 mono, 0 decorrelated, < 0 anti-phase |
| spread | `1 − correlation`, clamped 0…1 | half-width of the image; balance does not change it, width does |
| M/S ratio | side minus mid level, dB | |
| mono loss | `10·log10((L + R)/2 ÷ ((L + R)/2)²)` | how much quieter the stem is folded to mono; 0 for mono, 3 dB for decorrelated noise, more for anti-phase |

Spread comes from correlation, not from the side share, because a mono part panned off center has side energy without being wide.

**Occupancy.** Where a stem lives across the field is a distribution over 41 positions: a point part (`1 − spread`) with a 0.08 localization blur at its position, and a diffuse part (`spread`) spread evenly over the image span. From it: center, left, and right shares (center is |x| ≤ 0.25), and the overlap of two stems (histogram intersection). Two point sources 25% apart overlap about 0.12. This is an Audiosous description for comparing stems, not a model of binaural localization.

### Spatial interaction

The spatial pairs (`interaction.ts`) start from Milestone 4's pairs: the same scopes (the whole song, each section, each unmarked gap), the same rule for playing together (stems that never or barely overlap in time have no pair), the same tiers (prominence, notes, role), and the same frequency competition, measured on the mix as it is now: faders, section gain, and saved EQ. The spatial planner adds where each stem sits in the bands where they compete.

```text
severity = frequency competition × localizable field overlap × activity
```

- **Frequency competition** is M4's masked fraction of the more important stem (saturated, 0…1). For two stems of the same tier it is the larger direction. If an EQ cut already separated two stems, this is small and no spatial move follows.
- **Field overlap** is computed per stereo band and weighted by that band's share of the frequency competition, so two stems that collide at 2–5 kHz are compared where they sit at 2–5 kHz.
- **Localizable**: each band's overlap is weighted by how well position separates parts there (0.1, 0.2, 0.45, 0.75, then 1 from 632 Hz up). A conflict that lives under ~250 Hz is not a spatial problem; panning cannot separate it and low end stays centered.
- **Activity** is M4's activity factor (simultaneity and coverage).

Each pair also reports center competition (√ of the two center shares, weighted the same way), plain field overlap, both images, the competing range, and the level gap.

**Who moves.**

- Kick, bass, snare, lead, vocal, and drum-bus stems are never moved automatically, whatever their tier. An explicit note can still move them.
- A Primary or Focal stem is never the one moved. The lower tier moves.
- Two stems of the same Supporting or Background tier compete for space only when they are within 6 dB of each other while both play; then the quieter one moves. Two Primary or Focal stems have no automatic mover.
- **Level, not space.** If the stem that should move is more than 6 dB louder than the one it would protect (in the competing bands or overall), the pair is a level problem, and the plan says so instead of panning it away.
- **Priority**: 1 under a Primary or Focal stem, 0.6 for a Background stem under one (as in EQ, a background bed rarely hides a lead), 0.8 between Supporting peers, 0.7 for Supporting over Background.

### Planner

`planner.ts`, `plannerVersion` 5.0.0. Same project, gains, EQ, spatial state, analysis, roles, sections, intent, and settings give the same plan. No randomness.

1. **Notes that pin a stem** ("keep the vocal centered", "push the guitar left") are read first; the stem's pan is held there.
2. **Separation pass.** Each stem that should move in a pair over the threshold is searched, strongest conflict first. The search is a bounded grid: pan moves in 5% steps up to the strength's limit, width changes in 5-point steps, at least 10% or 10 points, coarse (10%) first and then the neighbours of the best. Every candidate is scored by the same evaluator the review panel uses:
   - **benefit**: how much it relieves the conflicts this stem should give way in, read where those conflicts happen (a Chorus-only clash counts in full), minus any conflict it adds to other pairs by moving into their space;
   - **cost**: grows with the square of the move, so a modest move wins unless the cap clearly helps more; narrowing back toward 100% costs half (it undoes a widening); pan and width together cost a little extra (the last step of the hierarchy); a level rise from widening and a mono-loss increase past 0.5 dB cost;
   - **hard limits**: never widen a stem with correlation under 0.2, never take correlation under 0.2 by widening, never add more than 1.5 dB of mono loss, never push the mix's left/right lean past 30%, never pan past ±80%, never widen a stem that is mostly low end, never pan it.
   A move is kept when its benefit and its net gain both clear the strength's minimum.
3. **Global or section.** A whole-song move is tried first. It is allowed only when the conflict covers at least half of the stem's playing time. A section move needs a reason the rest of the song does not have: prominence or a note in that section, or a protected stem that plays mostly (≥ 70%) there.
4. **Other reasons to move** (no pair needed):
   - *Mono safety*: a stem that is out of phase (correlation under −0.1), or that someone widened past 105% and left under 0.2 correlation, is narrowed. It may go all the way back to 100%, past the strength's step, because that undoes a widening. A narrowing below 100% of a stem that is out of phase as recorded goes to review.
   - *Surround*: a Background stem that is mostly mono (spread under 0.3), with healthy recorded correlation (≥ 0.4), where the mix center is crowded (center load ≥ 50%), may be widened.
5. **Correction pass.** The model is rebuilt with the first-pass moves; stems not yet moved whose conflicts remain are searched once more.
6. **Notes.** Section and Track × Section notes are read last, against the whole-song moves, and merged into any section row the stem already has, so a note's row never undoes a whole-song row. A note asking for "wider" never produces a narrowing: a stem already at or past the limit is left alone and the plan says so.
7. **Whole plan.** Every kept move is re-read with all the others in place. A separation move that no longer relieves enough, or one that now breaks a safety limit, is dropped.

| Strength | Max pan move | Max width change | Min conflict | Min benefit | Note step (width / pan) |
| --- | --- | --- | --- | --- | --- |
| Conservative | 15% | 20 points | 0.38 | 0.11 | 10 / 15 |
| Normal | 25% | 30 points | 0.30 | 0.08 | 20 / 25 |
| Strong | 40% | 40 points | 0.24 | 0.05 | 30 / 35 |

Automatic width stays within 60–140%. Anything outside the automatic range or larger than these moves, a confidence under 0.55, or a row whose proxy check disagrees goes to review and stays out of Apply all until accepted. Editing a row so that it trips a safety check also sends it to review.

**Confidence** starts from the pairs' confidence (simultaneity, shared time, roles) and moves with the share of the conflict the move removes, the stereo source (proxy frames or whole-file figures), an unlabeled role, peers of equal tier, section scope, and the second pass. A row from a Track × Section note starts at 0.88, a section note naming the stem at 0.84, and a whole-section note at 0.80.

### Intent

Spatial words are read by a fixed phrase table in `intent.ts`, not by language understanding:

| Reading | Phrases |
| --- | --- |
| wider | wide, wider, widen, spread, spread out, surround |
| narrower | narrow, narrower, narrow down, focused, intimate |
| center | centered, center, centre, in the middle, down the middle |
| left / right | left, right (not "right now", "right after", and similar) |

Tone words (warm, punchy, bright, aggressive, big) never move anything. A negated clause is ignored. A clause with two different readings is ignored. Direction words are removed before stem names are matched, so a track called "Gtr Left" is not named by "push the guitar left". A word that could mean two stems is not applied, and the summary says which stems it could mean.

- A **whole-section** instruction ("Make the breakdown wider.") applies width to eligible Supporting and Background stems in that section. "Surround" applies to Background stems only. A whole-section side ("move everything left") is not read.
- A **named** instruction applies to that stem: width, centering, or a side, by the strength's note step.

Precedence, highest first: a saved Track × Section pan or width override (structured beats inferred; the note is reported, not applied), a Track × Section note, a section note naming the stem, a whole-section instruction, the role prior.

### Evaluation

Every row carries its evaluation, and the review panel recomputes it on every edit from the evidence stored with the row (no planner, no audio):

- the conflict it addresses and any conflict it adds elsewhere, before and after;
- field overlap where they compete, and the stem's share in the center;
- the stem's correlation and mono fold-down loss, before and after;
- the mix's center load, left/right lean, correlation, and mono loss where the stem plays;
- the stem's level change from width.

The plan also reports the mix before and after the proposed rows.

**Proxy check (desktop).** Each row's stem runs through its saved EQ and the native spatial stage over the 48 kHz proxy, for up to 20 s of the windows where it competes, at its current and proposed pan and width (`crates/audio-engine/src/verify.rs`, Tauri `spatial_check`). A row whose measured correlation or mono loss moves much further than predicted, or past a safety limit, goes to review with the numbers in its reasons.

**Headroom.** Pan moves energy between channels and widening raises the side, so a peak can rise when no gain moves. Each channel gets its own power-sum estimate from each stem's cached peak and its statistics under the current and the candidate setting. If the louder channel would get hotter than now or than −1 dBFS, a uniform trim (up to −6 dB) is proposed and labeled as a safety trim. It is an estimate, not a rendered true-peak pass, and not a limiter.

### Plan contract

`packages/spatial-planner/src/plan.ts`: `planVersion` 1, `plannerVersion` 5.0.0, `kind: "spatial-balance"`, the same envelope as the AutoBalance and EQ plans. Each recommendation has the track, the scope (`global` or `section`), `processing: { type: "spatial", pan, width }` (null leaves that control alone), the saved values in that scope (`current`), the values as planned, whether it edits a saved section override, the related stems and interactions, the purpose (separation, widen, narrow, mono-safety, intent), confidence, status, an edited flag, 1–6 reasons, safety warnings, the evaluation, and the evidence it was judged on. The plan also carries the top 40 interactions, where every stem sits in each scope (for the field view), the mix before and after, a headroom trim, and per-stem levels. Everything is plain JSON validated with zod.

**Stale identity** covers the project id, analysis version, stereo frames version, planner version, strength, each stem's id, name, label, role, gain, mute, duration, and file identity, every pan and width (track and section), sections (bounds, type, intent), Track × Section prominence, notes, and gain overrides, and every saved EQ node: an EQ change can change which conflict remains. Selecting a row or moving the playhead is not an edit.

### Preview, A/B, apply, undo

The candidate is an overlay through the same monitor path as the AutoBalance and EQ auditions: saved pan and width plus the included rows. **Current** plays the saved mix. **Spatial Candidate** plays the proposed and accepted rows (plus a safety trim if needed). **Bypassed / Recommended** on a row plays the whole mix with only that row switched. Starting any audition stops the others, so one comparison plays at a time. An edit is heard on the next publish; nothing reloads and the device does not restart.

**Apply all** writes proposed and accepted rows, **Apply accepted** accepted rows: a global row into `track.pan` and `track.width`, a section row into `overrides.pan` and `overrides.width` (whole-song rows first, and only the controls a row sets). That is one `replaceDocument` with history, so Ctrl+Z restores the whole previous mix. Source files, proxies, and analysis caches are not touched.

A newer run, a cancel, or another project bumps the session's generation, and every later step of an older run is discarded. A plan that went stale while it was planned or checked is refused.

### Review UI

Plans has three tabs: Gain, EQ, and Space, with the same Current / Candidate / Apply all / Apply accepted / Cancel and per-row Accept / Reject / Edit / Bypassed / Recommended. While a plan is open, Plans is a drawer under the timeline: drag its handle (or use the arrow keys on it) to trade height with the timeline, which always keeps at least 200 px, and "Hide details" collapses it to the tabs and the A/B and Apply bar so the tracks, loop, and transport stay in view while you listen. The size is remembered per viewer. The header says what is playing (Current, the Candidate, or one row with or without its change). Editing a row in Space or EQ makes it heard: if the whole Candidate is playing and includes the row nothing changes, otherwise that row's single-row audition starts. Each row shows current → proposed → change for pan or balance and for width. The detail shows the stereo field for that scope: every stem at its position with a band as wide as its image, the moving stem's current image dashed and the proposed one solid. Dragging moves its pan; Shift-drag, the wheel, or Shift+arrows change its width; sliders and number fields do the same. Correlation is drawn on a −1…+1 scale with what it means here (+1 is not "good" and 0 is not "bad"; what matters is whether the part survives a mono fold-down). Analysis → Spatial interaction lists the pairs with both images, their numbers, and the explanation. A lane shows a SPACE badge when the track has a width other than 100% or a section pan or width, and stereo lanes have a width slider (double-click resets 100%).

### Legacy engine

The browser preview and `AUDIOSOUS_AUDIO_ENGINE=legacy` play pan and section pan (by polling the playhead) but not width. The Space panel says so.

### Known limitations

- The field model (position, a fixed localization blur, spread from correlation, localizability per band) is an Audiosous heuristic on 8 bands. It is not a binaural or psychoacoustic model, and it does not model depth, precedence, or reverb.
- Stems are assumed uncorrelated with each other when the mix's statistics are summed.
- Two fully decorrelated layers are hard to separate by position in this model; a wide layer that was widened past 100% is narrowed back for mono, and what remains is left to EQ.
- Width has no level compensation by design; widening raises a stem's level (reported per row).
- No frequency-dependent width, no mono-low-end processing, and no M/S EQ.
- Stem roles drive who moves. A mislabeled role (Generated 5 imports most stems as Bass) changes the plan.
- The legacy and browser engines ignore width.
- The proxy check confirms the stem's own correlation and mono loss on the proxy; it is not a listening result.

### Acceptance harness

```sh
cargo run --release -p audiosous-audio --example eq_bands -- "test-assets/Generated 5"
cargo run --release -p audiosous-audio --example stereo_frames -- "test-assets/Generated 5"
npx vite-node packages/spatial-planner/scripts/plan-space-project.ts -- scenario.json
services/analysis/.venv/bin/python packages/spatial-planner/scripts/render-space-audition.py OUT_DIR [--wav]
```

The scenario edits roles, gains, pan, width, saved EQ, sections, prominence, notes, and section overrides in memory, and can script a review. The render script is an independent NumPy implementation of the spatial stage; it measures Current, Spatial Candidate, and the reviewed plan in stereo and folded to mono, cross-checks each row's predicted correlation and mono loss, and with `--wav` writes the bounces for listening.

## Dynamics planning

Milestone 6 plans the time-varying dynamics of the mix: compression, sidechain ducking, transient shaping, and dynamic EQ, only where a problem changes over time and only as far as the measurements support. It does not limit, maximize loudness, use multiband compression, add reverb, delay, saturation, or any effect, host plugins, match a reference, or call a model. Compression never adds makeup to win a comparison.

```text
playback proxy ──► envelope frames (Rust, 10 ms) ─┐
playback proxy ──► EQ band frames (Rust) ─────────┼─► mix as heard ─► classify ─► choose the least invasive tool ─► size it on the envelopes
analysis cache ───► measurements ─────────────────┤  (fader, section      (level, attack/body,        (do nothing, compression, transient,       (adjust once)
project ──────────► faders, saved EQ, space, ─────┘   gain, saved EQ,       low-end collision,          duck, dynamic EQ; static EQ is
                    saved dynamics, roles, intent      saved dynamics)      event vs persistent         named when it is the right tool)
                                                                            masking)                               │
                                                                                                                   ▼
                                                                versioned plan ◄── regularization, global before section, confidence
                                                                       │
                                                                       ├─► proxy check (native dynamics on the proxies)
                                                                       ├─► candidate overlay (level-matched) ─► native engine ─► A/B
                                                                       └─► apply ─► dynamics nodes in the processing graphs (one undo step)
```

### Processing order

```text
source → static EQ (track, then section) → dynamic EQ → compressor → transient → ducking → width → pan / balance → gain → mix
```

The order is fixed by stage, never by a node's position in a list. Inside a stage the track's own nodes run before the section's. Dynamic EQ comes first so a band that only dips while a lead plays is gone before the compressor reacts to it; the compressor sees the stem after its EQ, as one would set it by ear; ducking is last, so a compressor never recovers gain underneath a duck.

**Sidechain keys** are the key track's own source: the mono mid of its ring sample, before its EQ, dynamics, fader, mute, and solo. The callback pulls every track's frame first and processes any track only after that, so every key for a frame exists before a target reads it and nothing depends on track order (`sidechain_ducking_plays_through_the_mix_whatever_the_track_order` renders both orders and expects the same output to 1e-6). A muted kick still ducks the bass, the way a pre-fader send does, and a fader move on the key never changes when the target ducks. Routing is track → track; a node may not key its own track and keys may not form a loop.

### Native dynamics

`crates/audio-engine/src/dynamics.rs`. Each track has fixed slots per stage: 3 dynamic EQ, 1 compressor, 1 transient, 2 ducking for the whole song, and 2, 1, 1, 1 more for the section under the playhead. The control thread publishes a sequence-locked table of atomics (`PublishedDynamics`), like the EQ and spatial tables; the audio thread copies it only when the sequence moves, into memory allocated when the engine was created, and resolves the section only when the playhead leaves the current span.

- **Compressor.** Stereo-linked RMS detector, `(L² + R²) / 2` through a 5 ms one-pole. The usual soft-knee static curve: nothing below `threshold − knee/2`, `(1 − 1/ratio)·over` above `threshold + knee/2`, the quadratic between. Attack and release act on the gain reduction in dB (smooth branching), so the detector itself never pumps. Reduction is capped at 30 dB. Makeup is added after and is 0 unless someone sets it.
- **Ducking.** The key level is a peak follower (instant rise, 30 ms fall) for a transient key such as a kick, or a 50 ms RMS for a smooth key such as a lead. The duck reaches its full range when the key is 6 dB over threshold and grows in proportion from the threshold; attack and release smooth it in dB.
- **Dynamic EQ.** A bell that dips by `range × activation`. The detector is the key track (or the track itself) through a constant-peak band-pass at the bell's frequency and Q, as an RMS (10 ms for a transient key, 50 ms for a smooth one), with the same 6 dB span and attack/release smoothing. It is the static EQ's SVF, so at 0 dB it is exactly the input.
- **Transient shaper.** The level is `max(|L|, |R|)` held over the last 12 ms (1 ms block peaks in a ring), so a steady tone down to 40 Hz is a flat level and is left alone. Fast (0.5 ms rise, 20 ms fall), slow-rising (12 ms rise, 20 ms fall), and slow-falling (0.5 ms rise, 300 ms fall) envelopes follow it; fast over slow-rising is a hit's attack, slow-falling over fast its tail, each 0–12 dB and scaled by its amount. A −15% clap attack drops 1.7 dB while its body moves 0.24 dB.

Gains and the dynamic bell's coefficients are computed every 16 frames (0.33 ms) and gains are interpolated per sample. A node that appears, disappears, or starts at a section edge fades its effect over 30 ms behind a cold detector; an edit applies at the next control step, smoothed by attack and release; a seek snaps (full effect, fresh detectors) because the output was silent. Per-track meters (compressor, duck, dynamic EQ reduction, |transient gain|) are written once per block, falling by at most 0.5 dB per block, and read with `Engine::dynamics_meter`.

The callback still does not lock, allocate, free, read files, or call JavaScript, Tauri, or Python. `callback_with_eq_spatial_and_dynamics_does_not_allocate` runs 8 stereo stems with EQ, pan, width, section windows, and every dynamics processor (a dynamic EQ and a duck keyed from track 0, a compressor, a transient shaper, a section compressor) through a dynamics table change and expects 0 allocations.

Tests (Rust): the static curve, steady signals at the curve, ratio and makeup, attack and release time constants, a transient through a slow attack, the threshold crossing, bypass bit-exactness (an untriggered dynamic EQ is the input), every legal setting finite and bounded, a key pulse ducking and the target recovering, a smooth key riding a phrase without pumping, a dynamic EQ dipping only its band and only while the key plays (and not for an off-band key), a self-keyed dynamic EQ, transient attack and sustain up and down and 0% as bypass, a steady tone left alone and a spike shaped without its body, a section node fading in and out, a seek into a section, the runtime reading its key and leaving other tracks alone, a missing key dropped, an edit in place and a removal fading out, meters, table round trip and stage placement, ducking through the real engine in both track orders with a muted key, section dynamics and a seek through the real engine, the allocation counter, and the offline bounce against the engine.

### Envelope frames

EQ band frames (about 0.4 s) suit phrase-level masking but not a kick against a bass. `crates/audio-engine/src/envelope.rs` reads each proxy once and keeps, every 10 ms, the stereo-linked RMS, the peak, and the RMS of the mono mid through a fourth-order Butterworth low-pass at 150 Hz. Values are quantized to 0.5 dB in one byte (`dB = byte / 2 − 100`) and stored base64, so a 141 s stem is 57 KB and a 6-minute song about 140 KB. The cache is `cache/analysis/<trackId>__envelope.json` with the band and stereo frames' identity rule (version 1). The 11 Generated 5 stems take 2.3 s from existing proxies.

### The mix as heard

`packages/dynamics-planner/src/envelope.ts` puts every unmuted stem on one 10 ms grid with per-segment offsets (each section and the time between sections): the fader or section gain, the saved EQ's change of the broadband level (weighted by the stem's own band spectrum) and of the 40–150 Hz level. Saved compressors and ducks are simulated on top (keys from the raw key envelopes). A compressor row is sized on the stem as its compressor would hear it (after EQ, before the fader); keyed rows are judged on the mix as heard. The second pass rebuilds this with the first pass's compressors in place, so a duck is sized on the compressed bass.

### Problems and tools

| Problem | Measured as | Tool |
| --- | --- | --- |
| level inconsistency | sustained level swings, irregularly, past the role's threshold | compressor |
| transient excess | attacks far over their body and over the rest of the mix | transient shaping (attack down) |
| transient weakness | a Focal drum whose soft attack sits under the mix | transient shaping (attack up) |
| low-end collision | the bass's low band within 3 dB of the kick's on its hits | duck from the kick |
| event masking | a supporting part masks a lead only while the lead plays | dynamic EQ (concentrated) or a smooth duck (broad) |
| persistent masking | the same, but the lead plays nearly all the time | none: static EQ is the right class of tool, and the plan says so |

The order of preference is: do nothing; let existing gain, EQ, space, or dynamics stand; compression for broad instability; transient shaping for attack/body; a duck for a cross-track, time-specific conflict; dynamic EQ for a frequency-specific, time-varying one. A consistently loud stem is AutoBalance's, a persistent frequency conflict is static EQ's, and a crowded center is space's; none of those are read as dynamics.

**Level inconsistency.** The sustained level is the median 50 ms RMS inside each 400 ms window (windows where most cells play); its spread is p90 − p10 and its swing rate the share of neighbouring windows that jump more than 3 dB. A stem is unstable only when the spread passes its role's threshold (bass 5 dB; synth, pad 6; keys, guitar 6.5; brass, backing vocal, vocal, lead 7; strings 7.5; atmosphere, drum bus 8; FX 9), at least 20% of steps swing, and the swing does not repeat with the music. That last test is the one that matters on real music: the first already-good run proposed six compressors because stutters, gated or pumped pads, and sequenced bass lines swing by design. Self-similarity on the 400 ms moving average at 10 ms resolution compares the level with itself at lags of 0.4–8 s; the self-difference at the best lag over the self-difference at a typical lag is 0.37–0.67 on every Generated 5 stem and 0.72–0.85 for uneven playing, and 0.7 is the threshold. A Supporting or Background part must also rise ahead of the loudest Primary or Focal stem playing with it (within 2.5 or 9 dB) in at least 10% of windows: a swing that stays under the lead does not disturb the hierarchy. Single drums (kick, snare, hats, percussion) are not compressed for level; attack/body is the transient planner's.

**Compressor settings** come from a bounded search on the envelope simulation: ratios 1.5–4 (capped by strength; 2 when a note asks for natural), thresholds from 6 dB under the detector's median sustained level to its 90th percentile. A candidate must narrow the spread by at least 1 dB, reduce the loudest passages within the strength's target (Normal 2–4 dB; down to 60% of the minimum), and not cut the crest by more than 3 dB. The score is the share of the spread removed minus costs for ratio, depth, distance from the target's middle, and level lost. Attack is 30 ms for sustained parts (a note's start passes), 15 ms for voices and leads, 25 ms for drum buses, 40 ms for atmospheres and FX, plus 10 ms when a note asks for natural; release is half the median time between onsets, 60–300 ms (200 ms for a sustained part); knee 6 dB; makeup 0.

**Transients.** Onsets come from the 10 ms peak (9 dB over the quietest of the previous 30 ms, within 40 dB of the stem's loudest, 60 ms apart). At each: attack energy (the onset frame and the next) over body energy (40–140 ms), and the attack over the rest of the mix at that moment. Excess: a Supporting drum whose attacks sit ≥ 3 dB over the mix and ≥ 12 dB over their body, a Primary one at ≥ 6 and ≥ 14 dB, or a note asking for softer at ≥ 0 and ≥ 10 dB. Weakness: a Focal drum (or one asked to punch) whose attacks sit ≤ 8 dB over their body (10 with the note) and ≥ 2 dB under the mix. Amounts are 5–15% down or 5–20% up, scaled by how far past the line the stem is. A stem that gets a compressor does not also get a transient shaper.

**Kick/bass collision.** For each kick and each low-end stem (role Bass, or a synth or keys part whose low band is within 3 dB of its level), the kick's onsets where the bass plays are compared over 80 ms: the bass's low band minus the kick's, as heard. A duck is considered when at least 40% of hits collide (within 3 dB or over; 30% when a note asks the kick to punch through) and the average is no worse than −4 dB; under 20% is "already separated". The threshold is the kick's median hit (its raw source) minus 10 dB, attack 5 ms, release about 1.2 × the kick's low-end decay inside 80–180 ms and inside 60% of the time between hits, depth enough to bring the bass about 3 dB under the kick on a typical hit within the strength's cap. Adjusted once: a shorter release if the bass is back at full level less than 60% of the time between hits or loses more than 0.6 dB there, a shallower duck if the bass's average level drops more than 1.5 dB. A requested pump allows up to 1.5 dB more and a 1.5× release, and goes to review past 3 dB.

**Event masking.** From the EQ planner's pairs (the mix as heard, saved EQ included), a lead, vocal, or Focal melodic stem protected from a supporting part. Drum and bass stems are not part of this. Under the strength's severity it is left alone (and "solved" when saved EQ is why). If the lead plays during more than 65% of the part's time, the conflict is persistent: static EQ is the right tool and no dynamic move is planned. If the part already sits ≥ 6 dB under the lead in the region, or ≥ 8 dB under it across the lead's defining range while it plays, the competition is weak and nothing is planned. Otherwise: a dynamic EQ bell when one region carries at least half the masking and spans at most about three octaves (frequency at the region's center, Q from its width, 0.7–2), else a smooth duck. The depth aims for the part 6 dB under a Focal or lead stem (4 otherwise) and takes the strength's share (40/50/60%) of that, 1 dB to the cap. The threshold is the lead's median detector level while it plays minus 8 dB; attack 20 ms and release 250 ms for the bell, 40 and 300 ms for the duck. A move must pull the part at least 0.4 dB and 30% of its depth further under the lead.

**Existing processing** is part of the mix as heard, and a saved node of the same kind is edited, never stacked: a saved compressor on the track is replaced by the row (or left alone, with a note, when it is already within 0.3 of the ratio and 1.5 dB of the threshold), a saved duck from the same key is replaced, and a saved dynamic EQ keyed from the same stem within half an octave is replaced.

**Global or section.** A compressor is global when the problem covers at least two thirds of the stem's playing time, or when the song reads uneven and no section is clearly calm. A section compressor needs a section with severity ≥ 0.5, at least 15 windows, a spread 1 dB past the threshold, and another section clearly calm (1 dB under the threshold); never on top of a saved whole-song compressor. A duck is global when collisions cover two thirds of the hits; a section duck needs its section past the threshold and another section clearly not colliding. Keyed dynamic EQ and smooth ducks are whole-song: they only act while the key plays.

### Regularization, limits, confidence

Each processor has a base cost (compressor and transient 0.06, duck 0.08, dynamic EQ 0.10, section scope +0.04, plus depth) and a row survives only when its benefit (severity × how much of the problem it removes × the tier or pair priority) beats its cost. Automatic graphs stay small: one compressor, one transient shaper, one duck, and two dynamic EQs per track; a track that wants more keeps the strongest.

| Strength | GR target | Max ratio | Max duck | Max dynamic EQ | Max transient | Spread allowance | Min severity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Conservative | 1–2.5 dB | 2.5:1 | 1.5 dB | 1.5 dB | 12% | +1 dB | 0.45 |
| Normal | 2–4 dB | 3:1 | 2.5 dB | 2.5 dB | 20% | 0 | 0.35 |
| Strong | 2.5–6 dB | 4:1 | 4 dB | 4 dB | 30% | −1 dB | 0.28 |

Automatic values stay within ratio 1.2–4, attack 3–80 ms, release 40–500 ms, knee ≤ 12 dB, makeup 0, duck and dynamic EQ 0.5–4 dB, Q 0.5–3, transient attack ±20% and sustain ±15%. A row goes to review, and stays out of Apply all until accepted, when its confidence is under 0.55, a duck is deeper than 3 dB, a dynamic dip deeper than 3 dB, a compressor reduces the loudest passages by more than 6 dB or 1.5 dB past its target, the ratio passes 4, makeup is set, attack or release leave the automatic range, Q leaves 0.5–3, a transient attack passes 20% or its sustain 15%, the stem's average level moves more than 3 dB, a requested pump passes 3 dB, or the proxy check disagrees. Editing a row into any of these sends it to review too.

**Confidence** starts at 0.5 and adds for a labeled role, the amount of evidence (windows or hits), how repeatable the problem is (swing rate or collision share), how much the move removes, and an explicit note or prominence; it loses for section scope.

### Intent

Dynamics words are read by a fixed phrase table (`intent.ts`). A word only biases a decision the measurements already support.

| Reading | Phrases | Effect |
| --- | --- | --- |
| control | controlled, control, even, consistent, steady, stable, smooth, glue, compress | spread threshold −1.5 dB, half the swing-rate requirement |
| natural | natural, dynamic, expressive, breathe, open, alive, uncompressed, raw | spread threshold +3 dB, ratio ≤ 2:1, GR target −1 dB, attack +10 ms |
| punch | punchy, punch, snappy, snap, crisp, attack, transients | a drum may count as weak with attacks ≤ 10 dB over body |
| soften | soft, softer, gentle, tame, rounder, less spiky, less clicky | a drum may count as spiky at ≥ 0 dB over the mix and ≥ 10 dB over body |
| duck | duck, sidechain, make room for, out of the way of, punch through, cut through, behind, under | a pair instruction: lowers the collision (or masking) threshold |
| pump | pump, pumping | an audible duck is allowed, and reviewed |

"Make the kick punch through the bass" names the key first; "Keep the pad behind the vocal" and "Duck the bass under the kick" name it second; on a Track × Section note the note's own stem is the target. Punchy alone never adds a duck. A negated clause, or one asking for both control and natural, is ignored, and a word that could mean two stems is not applied.

### Evaluation

There are at most two planning passes (each stem on its own, then relationships on the mix with the first pass in place), and every design adjusts once. Every row carries its evaluation, recomputed on every edit from the evidence stored with it (no planner, no audio):

- compressor: reduction p50/p95/max where the stem plays, sustained-level spread and crest before and after, peak and average level change;
- duck: reduction during the hits, the bass's low end against the kick at the hits before and after, share of hits that still collide, recovery between hits, the price between hits, average level change;
- dynamic EQ or smooth duck: the dip while the key plays, the protected stem's masked share and gap before and after, the part's change while the key rests, average level change;
- transient: attack over body and attack over the mix before and after, per-hit change, average level change;
- a reduction timeline over the scope (largest per bucket, up to 400 points) for drawing.

**Proxy check (desktop).** Each row's stem runs through its saved EQ and its scope's native dynamics, with and without the row, over up to 30 s of the windows where the problem happens (`crates/audio-engine/src/verify.rs`, Tauri `dynamics_check`): the sustained-level distribution, crest, attack over body at the unprocessed audio's onsets (1 ms resolution), the reduction the row actually applies (over key-on time for keyed rows), and for keyed rows the conflict band and level while the key plays and while it rests, and how much of key-off time the target is back at full level. A compressor that overshoots its target, barely engages, or does not narrow the spread; a duck that changes the target by less than 0.5 dB while the key plays or recovers less than half of key-off time; a dynamic EQ that dips less than 0.3 dB while the key plays or more than 0.75 dB while it rests; or a transient row that moves attack over body the wrong way or by less than 0.3 dB, goes to review with the numbers in its reasons.

### Plan contract

`packages/dynamics-planner/src/plan.ts`: `planVersion` 1, `plannerVersion` 6.0.0, `kind: "dynamics-balance"`, the same envelope as the other plans. Each recommendation has the track, the scope, the problem class, `processing` (the node's values: `compressor`, `ducking`, `transient`, or `dynamic-eq`), the values as planned, the saved node it edits, the target reduction (compressors), related stems and interactions, confidence, status, an edited flag, 1–6 reasons, warnings, the evaluation, and the evidence (base64 envelope series or per-step band levels, the check windows, and the conflict band). The plan also carries the dynamics interactions (key and target, onset overlap, low-band competition, level masking, free share, the recommended tool, confidence, outcome, explanation) and per-stem readings, for the review panel and for later planning. Everything is plain JSON validated with zod.

**Stale identity** covers the project id, the analysis, EQ band, and envelope versions, the planner version, strength, every stem's id, name, label, role, gain, mute, duration, and file identity, sections (bounds, type, intent), Track × Section prominence, notes, and gain overrides, and every saved EQ node, pan and width, and dynamics node. Selecting a row or moving the playhead is not an edit.

### Preview, A/B, apply, undo

The candidate is an overlay through the shared monitor path: saved dynamics plus the included rows, as the engine plays them. **Current** plays the saved mix. **Dynamics Candidate** plays the proposed and accepted rows. **Bypassed / Recommended** on a row plays the whole mix with only that row switched. Starting any audition stops the others. An edit is heard on the next publish (the row's own audition starts unless the candidate already includes it); nothing reloads and the device does not restart.

**Level match.** Compression makes a stem quieter, and louder usually sounds better, so the A/B is level-matched by default: each processed stem's fader is raised by the average level its row is predicted to remove (up to 3 dB), whole-song or inside the row's section, in the audition only. It is a simple, transparent match on the predicted average active level (an estimate of short-term loudness), not a peak match; the dynamics themselves are unchanged. The panel's "Level-match A/B" box turns it off. Nothing is level-matched when the plan is applied: makeup stays 0.

**Apply all** writes proposed and accepted rows, **Apply accepted** accepted rows, as `dynamics-plan` nodes with their first reason, into the track or Track × Section graph, replacing the node a row edits. One `replaceDocument` with history, so Ctrl+Z restores the whole previous dynamics state. Source files, proxies, and caches are not touched.

### Review UI

Plans has four tabs: Gain, EQ, Space, and Dynamics. The Dynamics table shows Track, Scope, Processor, Key, Amount / GR (the compressor's predicted reduction range, a duck's or dip's maximum, a transient amount), and Confidence, with Accept / Reject / Edit / Bypassed / Recommended. The detail shows the problem, the predicted reduction over time against the target band, the predicted and proxy-measured numbers (labeled when an edit has changed the row since the check), the live reduction from the engine while it plays, and editors with safe bounds: threshold, ratio, attack, release, knee, and makeup for a compressor; key track, key detector, maximum reduction, threshold, attack, and release for a duck; frequency, Q, maximum dip, key track (or its own signal), threshold, and release for a dynamic EQ, with the bell at rest and fully dipped over the two stems' band levels; attack and sustain for a transient shaper. "Relationships and readings" lists every pair and stem that was read, including why nothing was done. A lane shows a DYN badge when the track has saved dynamics.

### Legacy engine

The browser preview and `AUDIOSOUS_AUDIO_ENGINE=legacy` do not play dynamics. The Dynamics panel says so. Planning and the proxy check need the desktop app.

### Known limitations

- Everything is read from 10 ms envelopes (and 0.25–0.4 s band frames for masking). Inside 10 ms nothing is resolved: a fast attack's effect on a hit's first milliseconds is predicted coarsely, and the transient model is a fit to the native envelopes, not a simulation of them.
- The regularity test is a heuristic. On Generated 5 the patterned stems and uneven playing sit 0.05 apart around the threshold; a stem that is both patterned and uneven can read either way, and a level pattern that repeats with the music is always read as arrangement, even if a producer would call it a mistake.
- Keyed detection reads the key's source, so a key's EQ and fader never change a duck. That is predictable, but it is not "duck from what you hear".
- The kick/bass test does not know about ducking baked into the stems except through its measured effect (a pre-ducked bass reads as separated).
- Event masking inherits the EQ planner's spectral model and its limits; a masking dynamic EQ is sized on band levels, not on audio.
- No multiband compression, no de-essing, no lookahead (a 0.1 ms attack still lets the first samples through), no gain-reduction automation editor.
- The legacy and browser engines ignore dynamics.
- The proxy check measures each row on its own stem, on the proxy; it is not a listening result.

### Acceptance harness

```sh
cargo run --release -p audiosous-audio --example eq_bands -- "test-assets/Generated 5"
cargo run --release -p audiosous-audio --example envelope_frames -- "test-assets/Generated 5"
npx vite-node packages/dynamics-planner/scripts/plan-dynamics-project.ts -- scenario.json
cargo run --release -p audiosous-audio --example bounce_mix -- OUT_DIR [--wav]
services/analysis/.venv/bin/python packages/dynamics-planner/scripts/make-problem-mix.py "test-assets/Generated 5" "target/acceptance/Generated 5 Dynamics"
```

The scenario edits roles, gains, saved EQ and dynamics, sections, prominence, and notes in memory and can script a review; it writes the plan, the proxy-check requests, and engine settings for Current, Dynamics Candidate, the level-matched candidate, and the reviewed plan. `bounce_mix` runs every row's proxy check and bounces each variant through an offline mixer that drives the engine's own runtimes (`bounce.rs`, tested equal to the engine within 1e-4), so the bounces are the playback DSP. `make-problem-mix.py` builds the deliberately problematic project from the Generated 5 proxies.

## Tauri and Web Audio

The desktop shell owns the device. The webview does not stream PCM for playback. Header inspection still uses small ranged reads. Desktop waveform measurement reads each stem in Rust and reports progress while it runs. Absolute paths are resolved in the shell and are not written into `project.amix`.

The legacy webview clock remains for the browser preview and for `AUDIOSOUS_AUDIO_ENGINE=legacy`:

1. **Memory.** It must not decode every stem into one `AudioBuffer`.
2. **One clock.** Every stem shares one `AudioContext`. Independent `<audio>` elements are disallowed.
3. **Seek and loop.** Both restart against that context time.
4. **Sample rate.** That path low-pass filters each window before scheduling. It is not the production engine.

## Logging

Structured events include `project.create`, `project.open`, `project.save`, `track.import`, `track.decode.failure`, the analysis cache events, `autobalance.start`, `autobalance.complete`, `autobalance.apply`, `autobalance.cancel`, `autobalance.stale`, and `eqplan.start`, `eqplan.complete`, `eqplan.verify`, `eqplan.preview`, `eqplan.apply`, `eqplan.cancel`, and `eqplan.stale`, and `spatialplan.start`, `spatialplan.complete`, `spatialplan.verify`, `spatialplan.preview`, `spatialplan.apply`, `spatialplan.cancel`, and `spatialplan.stale`, and `dynamicsplan.start`, `dynamicsplan.complete`, `dynamicsplan.verify`, `dynamicsplan.preview`, `dynamicsplan.apply`, `dynamicsplan.cancel`, and `dynamicsplan.stale`. `dynamicsplan.complete` records `analysisMs`, `durationMs`, and `verifyMs` like the other plans. `spatialplan.complete` records `analysisMs`, `durationMs`, and `verifyMs` like the EQ plan. `eqplan.complete` records `analysisMs`, `durationMs` (the planner alone), and `verifyMs` (the proxy check). No log line carries PCM, band frames, stereo frames, envelopes, or a plan body. `autobalance.complete` records `analysisMs` (loading or measuring every stem) and `durationMs` (the planner alone) separately. The desktop shell appends JSON lines to the application log directory. Playhead motion is not logged, and AutoBalance logs do not include the plan body.

## Milestone 1

Included: the shell, schema version 1, WAV/AIFF import, waveform cache, one shared playback clock, mute/solo/gain/pan, manual sections, section and track × section intent, looping a range or a section, undo/redo, explicit save plus autosave after an edit settles, and experimental section suggestions from cached peaks.

Not included: spawning the Python sidecar, DSP, and every later item listed in `docs/milestones.md`. Source WAVs are never modified. A 32-stem project is read in short windows, not decoded into one buffer per stem.
