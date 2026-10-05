# Milestones

The product target is an AI-assisted visual mixer. Processing is out of scope until the project, the clock, and the selection context exist.

## Milestone 1 slices

| Slice | Status |
| --- | --- |
| 1. Repository and application shell | Done |
| 2. Project schema | Done |
| 3. Stem import | Done |
| 4. Waveform cache | Done. Peaks are measured per stem and stored in `cache/waveforms/` |
| 5. Timeline | Shared scale, zoom, scroll, vertical scale, playhead, section boundaries, and selected range |
| 6. Audio engine implementation | Done. One clock schedules short PCM windows |
| 7. Synchronized transport | Play, pause, stop, and seek share that clock |
| 8. Mixer controls | Mute, solo, gain, and pan are on each lane |
| 9. Selection model editing | A lane click selects the track. A drag selects a time range. A section mark selects that section |
| 10. Manual sections | A selected range becomes a named section. Name, type, bounds, and deletion are saved with the project |
| 11. Section and track intent editing | A section and the selected stem inside it store natural-language intent. Prominence is primary, focal, or supporting |
| 12. Looping | A selected range or a selected section loops on the shared clock. Moving that section moves the loop |
| 13. Undo / redo | Ctrl+Z and Ctrl+Shift+Z. A slider drag or a typed phrase is one step |
| 14. Save / reopen | Explicit save and the recovery copy remain. An edit saves after it settles, not while a control is still moving |
| 15. Experimental section detection | Suggest sections reads cached peaks and adds dashed automatic sections. Editing one makes it solid. Python is not spawned |
| 16. Performance pass | 32 stems share one short read window. Peaks stay in the cache |
| 17. Broader automated tests | History, intent, suggestions, peak energy, and the 32-stem clock are covered |

Import is not real until a project can be opened again, so this slice includes create, explicit save, the recovery copy, and reopen. It does not autosave while a control is being dragged.

## Milestone 2

Milestone 2 measures and draws analysis. It does not change the mix.

| Slice | Status |
| --- | --- |
| 1. Track measurement sidecar | Done. Peak, RMS, LUFS, crest factor, and band energy for the selected stem, cached in `cache/analysis/` |
| 2. Spectrum, loudness timeline, and spectrogram | Done. Drawn from the same measurement as the levels |
| 3. Section, time-range, and source-mix scopes | Done. A section or range measures that window. Source mix is the raw sum of the stem files, before faders, mute, and pan. It is not the audible mix |
| 4. Comparison, overlap, and the activity map | Done. Stem comparison, section comparison, and band overlap use measurements. The activity map is each stem's loudness timeline. Charts follow the shared playhead and can seek |

## Milestone 2.5

Milestone 2.5 moves the playback clock into Rust. The desktop app plays 48 kHz float proxies through `cpal`. The browser preview keeps the Web Audio engine. `AUDIOSOUS_AUDIO_ENGINE=legacy` selects that engine in the desktop app too.

| Slice | Status |
| --- | --- |
| 1. Playback proxy | Done. `cache/playback/<trackId>.proxy`, rebuilt when the source identity or resampler id changes |
| 2. Native transport | Done. One clock, four reader threads, gain, pan, mute, solo, seek, and loop |
| 3. Device output | Done. 48 kHz float when the device allows it. Otherwise a mixer thread converts before the callback |
| 4. Diagnostics | Done. The Audio engine panel reports fill, underruns, seek prime, callback time, and a budget warning |
| 5. Real-time callback | Done. The device callback does not lock, allocate, or read disk |

`npm run stress:audio` is the release check. It mixes synthetic 32- and 64-stem loads and plays five minutes of Generated 5 and Generated2 offline. Those soaks had 0 underruns. A release build also played Generated 5 through the laptop speaker for the whole 141.4 seconds, including seeks, a loop, mute, solo, gain, Balance, and the timeline and Analysis views. That run had 0 underruns. Blocking the React thread for one second did not stop the audio. CI does not open a device.

Milestone 2.5 is complete.

## Milestone 3

Milestone 3 is gain-only AutoBalance. It proposes track gain and section gain offsets, previews them on the existing clock, and applies the accepted rows as one undo step. It does not EQ, compress, limit, pan, or master. See [AutoBalance](architecture.md#autobalance) for the rules.

| Slice | Status |
| --- | --- |
| 1. Mix plan contract | Done. Versioned plan, confidence, reasons, and stale identity |
| 2. Deterministic balance planner | Done. Roles, anchors, loudness-weighted active level, deadband, caps |
| 3. Section-aware planning | Done. Global changes are preferred unless a section disagrees |
| 4. Candidate preview | Done. Overlay audition, whole-plan A/B, and single-track A/B |
| 5. Evaluation | Done. One correction pass and a separate headroom trim |
| 6. Mix view, undo, and stale plans | Done |
| 7. Intent | Done. Track × Section and section notes are read for level and prominence only, with a fixed precedence. An ambiguous stem reference is not applied |
| 8. Acceptance | Automated and offline checks done. Listening and a GUI walk-through are still open |

### Acceptance run

The planner ran on the cached analysis of two projects with `scripts/plan-project.ts`. Current and AutoBalance were bounced with `scripts/render-audition.py`.

**Sub Operator (Generated 5), 11 real stems, 141 s.** Sections were set from the stem timelines: Intro, Break, Drop, Drop 2, Outro. Roles: PunchBox Kick, Bass Bus Bass, Bleeps Bus Lead, MasterEQ Pad, Skimming Air Atmosphere, Phase Plant 2 Brass with custom label "Trumpets", Stutter Expression and Subway Synth, CZ V FX. SideKick6 and 2nd BD are silent. There are no real trumpets. Phase Plant 2 stands in because it only plays in Drop 2, well under the lead.

The stems at their exported levels are the producer's balance, so that is the already-good case.

| Case | Rows | Largest | Section rows | Confidence | Trim |
| --- | --- | --- | --- | --- | --- |
| Already good, Normal | 2 | −0.9 dB | 0 | 0.92 | 0 |
| Already good, Conservative | 2 | −1.0 dB | 0 | 0.88 | 0 |
| Already good, Strong | 3 | −2.2 dB | 1 | 0.92 | 0 |
| Already good, Normal, MasterEQ as Lead and Bleeps as Synth | 1 | −0.9 dB | 0 | 0.92 | 0 |
| Case A, no intent | 4 | ±4.0 dB | 1 | 0.92 | 0 |
| Case A, Drop 2 note "Big and punchy. Trumpets should dominate." | 5 | ±4.0 dB | 2 | 0.91 | 0 |
| Case A, Trumpets Focal in Drop 2 | 5 | ±4.0 dB | 2 | 0.92 | 0 |

Case A added deliberate errors to the good mix: Lead −4 dB, Atmosphere +5 dB, Pad +3 dB, Bass +2 dB. The plan put the lead back to 0.0, the bass from +2.0 to −0.9, and the pad from +3.0 to +1.6. The atmosphere error was only caught in the Intro (+5.0 to +3.3). Elsewhere it stays under the Background ceiling, so it was left alone. The Drop 2 note and explicit Focal prominence gave the same +4.0 dB Drop 2 row on the stand-in, capped and marked for review because the gap to the bass is 20.6 dB. The note row reads confidence 0.85 and the prominence row 0.90. "Big and punchy." on its own changed nothing.

The bounces are not loudness-matched. Case A current peaks at +1.8 dBFS with 287 samples over full scale, and the candidate at +0.5 dBFS with 7. The already-good candidate peaks at −0.5 dBFS against +0.05 dBFS current. No trim was needed in either.

**Night Drive, 6 synthetic stems, 80 s.** The generator makes a 50 ms, 55 Hz kick blip every half second under a constant 55 Hz bass and a full-scale lead, so it is badly unbalanced on purpose. The plan cut the lead and the bass 4 dB each toward the kick and marked both for review, because the uncapped moves were 20 dB and 14 dB. It cut the pad 0.4 dB. With "Bring the lead forward. Make the pad quieter." on Drop 2, Drop 2 keeps the lead 2.3 dB over the rest of the lead, and the plan adds a −0.6 dB trim. The pad was already far enough under the reference, so the "quieter" note had nothing left to do. The raw stems sum to +8.6 dBFS before AutoBalance, and that does not change.

The first run of the already-good case proposed 5 to 6 rows of up to 4 dB. Five planner faults caused that, and all five are fixed and covered by tests:
- unweighted RMS across different spectra;
- a fading-in lead used as a section reference;
- a primary's quiet passages judged as errors;
- primaries compared with each other instead of the anchor;
- a follow-up pass that checked against a different reference than the first pass.

**Timing.** For 11 stems and 5 sections, reading the analysis cache took 35 to 75 ms and planning took 10 to 47 ms. The desktop log records `analysisMs` and `durationMs` separately.

**UX flow.** `apps/desktop/src/lib/autobalance-flow.test.ts` drives the store with the real apply, cancel, and audition functions:
- edit, reject, and accept rows;
- Current vs AutoBalance;
- single-row original vs recommended;
- Apply accepted (only accepted rows land);
- one undo step back to the full pre-plan mix;
- a fader move making the plan stale and refusing to apply;
- row focus not making the plan stale;
- cancel leaving the saved project untouched.

The native preview path was checked by reading it. Section windows are published to a lock-free schedule and set the target of the existing 10 ms gain slew. Proxies are not rebuilt and the device is not restarted.

**Review fixes after the first hands-on run.** Generated 5 as saved reported no changes. Its three sections cover only the first 24 s, and the planner used to skip time outside sections, so the drops were never checked. Unmarked time is now planned, and the panel states the scope. The timeline also gained:
- icon Play/Pause, Stop, and Loop buttons;
- Clear selection, also on Esc;
- Section at playhead, which splits the section under the playhead, or else adds one from the end of the previous section (or the song start) to the playhead.

The Generated 5 stems are still mostly marked Bass. The import role guess reads "Sub" in "Sub Operator" as bass.

**Still open before Milestone 3 is complete:**
- a listening pass on the Current and AutoBalance bounces;
- a manual walk-through of the review panel in the desktop app: row click selection and seek, the A/B buttons, Apply accepted, Ctrl+Z, and stale and cancel.

## Milestone 4

Milestone 4 is static EQ planning: frequency interaction between stems, then conservative, explainable EQ moves that improve separation and hierarchy. It previews on the existing clock and applies as one undo step. It does not compress, use dynamic EQ or sidechain, pan, widen, add effects, limit, master, or host plugins. See [Frequency interaction and EQ](architecture.md#frequency-interaction-and-eq).

| Slice | Status |
| --- | --- |
| 1. EQ contract | Done. Schema v2 with a v1 migration: typed EQ nodes on every track and Track × Section, additive inheritance, node limits, stale identity, versioned `frequency-balance` plan |
| 2. Native DSP | Done. RBJ responses in SVF form, 6 track + 4 section slots per stem, 30 ms ramps, lock-free publish, no allocation in the callback (tested) |
| 3. Interaction analysis | Done. Time-aware pairwise competition per scope, role-weighted regions, stereo discount, priority, confidence. Proxy band frames (Rust, 5.9 Hz bins) because the sidecar spectrogram is too coarse below a few hundred Hz |
| 4. EQ planner | Done. Who yields, center, gain, Q, global vs section, kick/bass, lead/supporting, measured high-pass, rare low-pass, tone words, saved-boost reduction, level-problem notes, regularization, confidence |
| 5. Candidate preview | Done. Overlay through one monitor path with AutoBalance, Current vs EQ Candidate, single-filter Bypassed / With filter, curve editor, accept, reject |
| 6. Evaluation | Done. Spectral transfer per move (pairwise and in context), a second correction pass, a whole-plan check, and a proxy check with the native filters |
| 7. Hardening | Partly. Undo, stale plans, performance, real-music runs, and docs are done. CI has not run on these changes, and the listening pass and GUI walk-through are open |

### Tests

- `packages/eq-planner` (46). Spec fixtures A–F: Lead Focal vs Pad, Kick Primary vs Bass Supporting, Kick vs Bass both Primary (with and without transient evidence), never simultaneous, already separated, sparse Focal in Drop 2 from prominence and from a section note. Also global preferred over section, measured high-pass (and none without low end), fader state and saved EQ heard, a saved node replaced rather than stacked, layering, stereo discount, tone words confirmed and refused, an already-good mix, determinism, strength limits, filter caps, staleness, a 32-stem timing check, proxy bands over a smeared spectrogram, the plan contract (edit, reset, misplaced filter, clamps, audition, apply, Apply all vs Apply accepted, safety trim, HPF evaluation, proxy-check merge), and the response math.
- `packages/project-model` (29). v1 → v2 migration, the inheritance order, rows kept for filters only, node limits and ids, clamping, and processing identity.
- `apps/desktop` (32, 9 new). The EQ review flow drives the store with the real functions: the acceptance plan shape, whole-plan and single-filter A/B through the monitor, EQ audition stopping a gain audition, edit + reject + accept + Apply accepted + one undo step, stale refusal after a fader or prominence change, cancel, saved section gain reaching the engine, and saved EQ reaching the engine.
- `crates/audio-engine` (Rust, 15 new). Bell, HPF, LPF, low shelf, and high shelf against the cookbook formula, multiple filters, bypass bit-exactness, every legal parameter combination finite and bounded, ramped parameter update, section fade in and out, retargeting between sections, a seek into a section, table round trip, track and section EQ through the real offline engine, the allocation counter, the proxy check, and band frames (Parseval and no low-end smear).
- `npm run stress:audio` adds `stress_eq_callback_cost`.

### Acceptance run

Planned from the cached analysis plus proxy band frames with `plan-eq-project.ts`. Bounced from the proxies with `render-eq-audition.py`. Generated 5 used the same sections and roles as the Milestone 3 run: Intro 0–17.7 s, Break –33.6 s, Drop –86.6 s, Drop 2 –123.7 s, Outro –141.4 s. Roles: PunchBox Kick, Bass Bus Bass, Bleeps Bus Lead, MasterEQ Pad, Skimming Air Atmosphere, Phase Plant 2 Brass "Trumpets", Stutter Expression and Subway Synth, CZ V FX. All faders at 0 dB.

**Already-good mix (the producer's stems).**

| Case | Filters | Largest | Section | Notes |
| --- | --- | --- | --- | --- |
| Conservative | 1 | Subway −1.3 dB at 2.2 kHz | 0 | Kick/Bass both Primary: overlap 36–63 Hz, no change. Bleeps 10 dB under MasterEQ in its range: level, not EQ |
| Normal | 2 | MasterEQ −2.3 dB at 1.6 kHz, Subway −1.7 dB at 2.2 kHz | 0 | Kick/Bass no change |
| Strong | 3 | adds Stutter Expression −3.3 dB at 1.6 kHz (second pass) | 0 | |
| Normal, Drop 2 note "Trumpets should be more prominent." | 2 | same as Normal | 0 | The stand-in sits 20 dB under the mix in Drop 2: level, not EQ |
| Normal, Bass Bus Supporting in every section | 3 | Bass Bus −2.9 dB at 46 Hz, Q 2, at PunchBox's strongest low band | 0 | |

None of the 11 stems got more than one filter. The first calibration run on this mix proposed 9 cuts with 5 section filters, 5 of them on Skimming Air. Five faults caused that, and all five are fixed and covered:
- Supporting parts were protected.
- Moves were judged against one competitor instead of everything playing.
- Gaps no conservative cut can close were attempted.
- Section filters were allowed without a stated reason.
- The severity scale saturated.

A sixth fault was in the data: the sidecar spectrogram has 187 Hz bins at 192 kHz, so the low end was unresolved and kick/bass read "150–200 Hz". The proxy band frames fixed that.

**Deliberately problematic mix.** The good mix with bad EQ and gain saved on it:
- MasterEQ +3 dB, a +6 dB bell at 2.5 kHz, and a +5 dB low shelf at 120 Hz.
- Stutter Expression with a +6 dB bell at 1.8 kHz.
- Skimming Air +5 dB with a +8 dB low shelf at 150 Hz.
- Bass Bus +2 dB with a +5 dB bell at 60 Hz.
- Phase Plant 2 Focal in Drop 2.

- Top conflicts: MasterEQ over Bleeps Bus at 1.1–3.6 kHz (+11 dB), Stutter Expression over Bleeps Bus at 1.1–2.7 kHz (+7 dB), PunchBox and Bass Bus at 36–63 Hz (both Primary), and Phase Plant 2 under MasterEQ in Drop 2 (24 dB, level).
- Proposed: reduce MasterEQ's saved +6 dB bell to −1.0 dB, and on the second pass reduce Stutter Expression's +6 dB bell to +1.1 dB. Both Global, confidence 0.93 and 0.92.
- Not proposed: the two low shelves. The producer had already high-passed MasterEQ and Skimming Air, so the shelves boost almost nothing and sit about 20 dB under the bass. Kick/Bass had no stated priority. Phase Plant 2 is a level problem.
- Review in the harness: accept both, then edit MasterEQ to −0.9 dB. A Bass Bus reject was scripted but there was no Bass Bus row to reject.
- Bounce peaks: current +1.2 dBFS (clipping), candidate −1.5 dBFS, reviewed −1.2 dBFS.

**Prediction vs audio.** The independent Python filters on the proxies measured each filter's change inside its conflict range over the overlap windows:

| Filter | Predicted | Measured |
| --- | --- | --- |
| Stutter Expression bell 1.8 kHz, 1.1–2.7 kHz | −3.25 dB | −3.62 dB |
| MasterEQ bell 2.5 kHz, 1.1–3.6 kHz | −3.41 dB | −2.84 dB |
| MasterEQ −2.3 dB at 1.6 kHz | −1.11 dB | −1.33 dB |
| Bass Bus −2.9 dB at 46 Hz, 36–63 Hz | −2.10 dB | −1.70 dB |
| Subway −1.7 dB at 2.2 kHz | −1.24 dB | −1.27 dB |

**Night Drive (synthetic, 6 stems, 80 s).** A 55 Hz kick blip sits under a constant 55 Hz bass, both Primary. The plan is one review-only Bass cut at 53 Hz, −1.1 dB, confidence 0.48, and nothing automatic.

**Timing.** For 11 stems and 5 sections: band frames 0.86 s for all stems from existing proxies (cached afterwards), cache load 15–55 ms, and planning 50–90 ms including both passes and the whole-plan check.

**Audio engine.** Release build, same machine, same tests, before and after EQ:
- Synthetic, 256-frame callbacks: 32×48 kHz 0.047 → 0.048 ms, 32×96 kHz 0.037 → 0.041, 11×192 kHz 0.015 → 0.021, 64×48 kHz 0.062 → 0.086 (budget 5.33 ms).
- Soaks: Generated 5 0.146 → 0.143 ms, Generated2 0.125 → 0.162 ms, both with seeks, a loop, mute, and solo.
- EQ loads, 512-frame callbacks: 32 stems with HPF + 2 bells + a section bell, 0.30–0.40 ms of 10.67 ms. 64 stems, 0.69–0.81 ms.
- Every run had 0 underruns.

**Fixed along the way.**
- Milestone 3 Track × Section gain written by Apply was saved but never sent to either engine outside a preview. Both engines now play it.
- AutoBalance's apply dropped Track × Section rows that held only filters.

**Still open before Milestone 4 is complete:**
- a listening pass on the Current, EQ Candidate, and reviewed bounces of both mixes;
- a GUI walk-through: the EQ tab, the curve editor (drag, wheel, keys), Bypassed / With filter, Current / EQ Candidate, Apply accepted, Ctrl+Z, a stale plan after a fader move, the Frequency interaction view, and the lane EQ badge;
- GitHub Actions on these changes.

## Explicitly later

Dynamic EQ, compression, sidechain, multiband, transient shaping, de-essing, automatic stereo width or panning, saturation, reverb, delay, limiting, mastering, final render, VST hosting, reference matching, LLM mixing, preference learning, accounts, collaboration, and source separation.
