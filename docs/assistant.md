# Assistant

The assistant lets you describe what you hear or want in your own words. It checks the mix with Audiosous's planners, explains what it finds, and builds a candidate you can preview, adjust, and apply. It never changes the saved mix unless you tell it to, and it never decides a processor value itself: Level, EQ, Space, Dynamics, and Full Mix calculate every change, and the assistant chooses which of them to run and explains the result.

Everything else in Audiosous works without it.

## Connecting a provider

Open a project, click **Assistant** in the header, then **Settings**.

- **Provider**: Anthropic, or None to turn the assistant off.
- **Model**: `claude-opus-5-5` by default.
- **Effort**: how long the model may think. Medium keeps a typical diagnostic to a few seconds; Low is faster, High slower.
- **API key**: an Anthropic API key. It is stored in the app's settings folder with owner-only permissions and is never shown again. If the `ANTHROPIC_API_KEY` environment variable is set when Audiosous starts, it is used instead and nothing needs to be stored. **Remove stored key** deletes the stored one.

Settings are stored with the app, not in any project, so sharing a project never shares them.

## Privacy

Nothing is sent until you send a message. When you do, Audiosous sends the provider structured information about the project:

- stem names and roles, section names, times, and notes, and the prominence and notes you set per section;
- faders, pan, width, mute, and the processing on each stem;
- measurements and summaries from the planners (levels, masking regions, stereo and dynamics readings, problems and their evidence);
- the candidate being discussed, and the recent conversation.

It never sends audio, waveforms, playback proxies, analysis frames, file names or folder paths, environment variables, or your API key. Requests go from the desktop shell to the Anthropic Messages API only; the shell refuses any other destination. Logs record what kind of request was made and how long it took, never what you wrote or what the assistant answered.

The conversation lives only while the project is open. It is not saved in the project file.

## What to ask

Describe a problem, a goal, or a change:

- "The chorus feels weak." · "The kick is getting lost under the bass." · "Make the vocal clearer." · "This feels crowded."
- "Make the drop wider, but don't touch the vocal." · "No compression." · "Only change the breakdown." · "Keep it subtle."
- "Pan the guitar 20% left." · "Make the bass 1 dB quieter." (carried out exactly, as one undo step)

Ask why:

- "What's wrong with Drop 2?" · "Should the bass be louder?" · "Why did you cut the pad instead of panning it?" · "What processing is on the bass?"

Refine the current candidate:

- "A little less." · "Make that 25% weaker." · "Keep the EQ but lose the width change." · "Try it without the sidechain." · "Give me another option." · "What's the difference between these two?" · "Go back to the first one." · "This is too processed."

Act on it:

- "Let's hear it" plays the candidate (it does not apply it).
- "Apply it" writes it to the project as one undo step, and the reply lists what changed. So does the card's **Apply** button.
- "Undo that" undoes the assistant's last apply, if nothing else has changed since; otherwise use Undo (Ctrl+Z), which steps back one edit at a time.

When a reference could mean more than one stem ("the trumpet" with two trumpet tracks), the assistant asks which one. With a stem and a section selected, "make this stand out more here" means that stem in that section.

## How candidates work

A candidate opens in **Plans → Full Mix**, the same review the Full Mix button uses: problems with their evidence, the alternatives that were considered and why they lost, each change with Accept, Reject, Edit, Only this, and Without, and the A/B (loudness-matched by default). Edits you make there are what the assistant works from next. If you change the mix while a candidate is open (a fader, an EQ, a section), the candidate is marked out of date and cannot be applied until it is rebuilt.

## When something goes wrong

- If the provider is unreachable, rejects the key, or is rate-limiting, the panel says so. The mix is not changed, and the planners still work.
- If a stem has no analysis yet, the assistant says what it could not judge rather than guessing.
- Cancel stops a request; nothing it was doing is kept.
