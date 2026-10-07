import type { ProjectDocument } from "@audiosous/project-model";
import { useState, type ReactNode } from "react";
import { clock, closeExportDialog, decideExport, cancelExport, formatLabel, LOUDNESS_PRESETS, openCandidate, openExportDialog, rateOptions, setExportSettings, startExport, STREAMING_NOTE, type LoudnessPreset } from "../lib/export";
import { getPlatform, isTauri } from "../platform";
import type { ExportFormat, ExportReport, ExportSettings } from "../platform/types";
import { useAppStore, type ExportSession } from "../state/app-store";
import { useGate, TaskProgress } from "./ProcessingStatus";
import { HoverTip } from "./ui";

/** The header's Export action: what will be exported, and why it is not available yet when it is not. */
export function ExportButton({ disabled = false }: { disabled?: boolean }) {
  const gate = useGate("export");
  const job = useAppStore((state) => state.exportJob);
  const running = job?.phase === "running" || job?.phase === "deciding";
  const blocked = (gate.blocked && !running) || disabled || !isTauri();
  const label = !isTauri() ? "Export renders the original stems in the desktop app" : running ? "Show the export in progress" : gate.blocked ? (gate.reason ?? "Unavailable") : "Render the applied mix to WAV, FLAC, or MP3";
  return (
    <HoverTip label={label} className="inline-flex">
      <button type="button" disabled={blocked} className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-panel-2 disabled:opacity-40" onClick={() => openExportDialog()}>
        {running ? "Exporting…" : "Export"}
      </button>
    </HoverTip>
  );
}

export function ExportDialog() {
  const job = useAppStore((state) => state.exportJob);
  const document = useAppStore((state) => state.document);
  if (!job?.open || !document) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-auto bg-canvas/80 px-4 py-10" role="dialog" aria-modal="true" aria-label="Export mix">
      <div className="w-full max-w-2xl rounded-lg border border-line bg-panel px-6 py-5 shadow-xl">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-3xl">Export mix</h2>
          <button type="button" className="ml-auto text-sm text-muted hover:text-ink" onClick={() => closeExportDialog()}>
            {job.phase === "running" || job.phase === "deciding" ? "Hide (keeps running)" : "Close"}
          </button>
        </div>
        {job.phase === "setup" || job.phase === "cancelled" ? <Setup document={document} job={job} /> : null}
        {job.phase === "running" ? <Running job={job} /> : null}
        {job.phase === "deciding" ? <Deciding job={job} /> : null}
        {job.phase === "done" && job.report ? <Summary report={job.report} peakMemoryMb={job.status?.peakMemoryMb ?? null} /> : null}
        {job.phase === "failed" ? <Failed job={job} /> : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-[11px] tracking-wide text-muted uppercase">{label}</span>
      {children}
    </label>
  );
}

const SELECT = "w-full rounded-md border border-line bg-canvas py-1.5 pr-7 pl-2 text-sm text-ink";
const INPUT = "w-full rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-ink";

function formatValue(format: ExportFormat): string {
  return format.kind === "wav" ? `wav:${format.depth}` : format.kind === "flac" ? `flac:${format.bits}` : `mp3:${format.quality}`;
}

function parseFormat(value: string): ExportFormat {
  const [kind, option] = value.split(":");
  if (kind === "flac") return { kind: "flac", bits: option === "16" ? 16 : 24 };
  if (kind === "mp3") return { kind: "mp3", quality: option === "v0" ? "v0" : "cbr320" };
  return { kind: "wav", depth: option === "float32" ? "float32" : option === "pcm16" ? "pcm16" : "pcm24" };
}

function Setup({ document, job }: { document: ProjectDocument; job: ExportSession }) {
  const candidate = useAppStore((state) => openCandidate(state));
  const gate = useGate("export");
  const settings = job.settings;
  const rates = rateOptions(document, settings.format);
  const [custom, setCustom] = useState(() => (settings.loudness.mode === "target" ? { lufs: settings.loudness.integratedLufs, ceiling: settings.loudness.ceilingDbtp } : { lufs: -14, ceiling: -1 }));
  const referenceInfo = useAppStore((state) => state.reference.references.find((item) => item.name === state.reference.selected) ?? null);
  const referenceLufs = referenceInfo ? Math.round(Math.max(-30, Math.min(-5, referenceInfo.profile.loudness.integratedLufs)) * 10) / 10 : null;
  const choosePreset = (preset: LoudnessPreset) => {
    if (preset === "custom") setExportSettings({ loudness: { mode: "target", integratedLufs: custom.lufs, ceilingDbtp: custom.ceiling } }, "custom");
    else if (preset === "reference") {
      if (referenceLufs !== null) setExportSettings({ loudness: { mode: "target", integratedLufs: referenceLufs, ceilingDbtp: -1 } }, "reference");
    } else setExportSettings({ loudness: LOUDNESS_PRESETS[preset].target }, preset);
  };
  const updateCustom = (next: { lufs: number; ceiling: number }) => {
    setCustom(next);
    setExportSettings({ loudness: { mode: "target", integratedLufs: next.lufs, ceilingDbtp: next.ceiling } }, "custom");
  };
  const metadata = settings.metadata;
  const setMetadata = (patch: Partial<ExportSettings["metadata"]>) => setExportSettings({ metadata: { ...metadata, ...patch } });
  const mp3 = settings.format.kind === "mp3";
  const tags = settings.format.kind !== "wav";
  return (
    <div className="mt-3 space-y-4">
      <p className="text-sm text-muted">Renders the applied mix — every fader, section gain, EQ, space, and dynamics setting you have applied — from the original stems. Solo is for listening and is not part of the export.</p>
      {candidate ? (
        <div className="rounded-md border border-accent/60 bg-accent/10 px-3 py-2 text-sm" role="note">
          <p className="text-ink">A {candidate} is being previewed but has not been applied.</p>
          <p className="text-muted">Export uses the applied mix. Apply the candidate first if you want it in the file.</p>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Format">
          <select className={SELECT} value={formatValue(settings.format)} onChange={(event) => setExportSettings({ format: parseFormat(event.target.value) })}>
            <option value="wav:pcm24">WAV — 24-bit PCM</option>
            <option value="wav:float32">WAV — 32-bit float</option>
            <option value="wav:pcm16">WAV — 16-bit PCM</option>
            <option value="flac:24">FLAC — 24-bit (lossless)</option>
            <option value="flac:16">FLAC — 16-bit (lossless)</option>
            <option value="mp3:cbr320" disabled={Boolean(job.mp3Unavailable)}>
              MP3 — 320 kbps CBR
            </option>
            <option value="mp3:v0" disabled={Boolean(job.mp3Unavailable)}>
              MP3 — V0 (high-quality VBR)
            </option>
          </select>
          {job.mp3Unavailable ? <span className="mt-1 block text-xs text-faint">{job.mp3Unavailable}</span> : null}
        </Field>
        <Field label="Sample rate">
          <select className={SELECT} value={settings.sampleRate} onChange={(event) => setExportSettings({ sampleRate: Number(event.target.value) })}>
            {rates.map((rate) => (
              <option key={rate} value={rate}>
                {(rate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz{rate === Math.round(document.project.sampleRate) ? " (project)" : ""}
              </option>
            ))}
          </select>
          {mp3 ? <span className="mt-1 block text-xs text-faint">MP3 is 44.1 or 48 kHz.</span> : null}
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1 text-[11px] tracking-wide text-muted uppercase">Export loudness</legend>
        <div className="space-y-1.5">
          {(["preserve", "balanced", "loud", ...(referenceLufs !== null ? (["reference"] as const) : []), "custom"] as const).map((preset) => (
            <label key={preset} className="flex items-start gap-2 text-sm">
              <input type="radio" name="loudness" className="mt-1" checked={job.preset === preset} onChange={() => choosePreset(preset)} />
              <span>
                <span className="text-ink">{preset === "custom" ? "Custom" : preset === "reference" ? `Match reference loudness (${referenceLufs!.toFixed(1)} LUFS)` : LOUDNESS_PRESETS[preset].label}</span>
                <span className="block text-xs text-muted">
                  {preset === "custom"
                    ? "Your own integrated loudness and true-peak ceiling."
                    : preset === "reference"
                      ? `The loudness “${referenceInfo!.name}” measures, −1.0 dBTP ceiling. A dense reference can need heavy limiting on a more open mix; the export shows how much before writing.`
                      : LOUDNESS_PRESETS[preset].note}
                </span>
              </span>
            </label>
          ))}
        </div>
        {job.preset === "custom" ? (
          <div className="mt-2 grid max-w-sm grid-cols-2 gap-3">
            <Field label="Target (LUFS)">
              <input type="number" className={INPUT} step={0.5} min={-30} max={-5} value={custom.lufs} onChange={(event) => updateCustom({ ...custom, lufs: Math.min(-5, Math.max(-30, Number(event.target.value) || -14)) })} />
            </Field>
            <Field label="True-peak ceiling (dBTP)">
              <input type="number" className={INPUT} step={0.1} min={-6} max={0} value={custom.ceiling} onChange={(event) => updateCustom({ ...custom, ceiling: Math.min(0, Math.max(-6, Number(event.target.value) || -1)) })} />
            </Field>
          </div>
        ) : null}
        {job.preset !== "preserve" ? <p className="mt-2 text-xs text-faint">{STREAMING_NOTE}</p> : null}
        {mp3 && settings.loudness.ceilingDbtp > -1.5 ? <p className="mt-1 text-xs text-muted">MP3 encoding raises peaks slightly. For MP3, a −1.5 dBTP ceiling (Custom) keeps the decoded file under −1 dBTP.</p> : null}
        <p className="mt-1 text-xs text-faint">The loudness stage is one gain and, only where a true peak would pass the ceiling, a transparent limiter after the mix. Your saved mix is not changed.</p>
      </fieldset>
      {tags ? (
        <details>
          <summary className="cursor-pointer text-sm text-muted">Tags (optional)</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="Title">
              <input className={INPUT} value={metadata.title ?? ""} onChange={(event) => setMetadata({ title: event.target.value })} />
            </Field>
            <Field label="Artist">
              <input className={INPUT} value={metadata.artist ?? ""} onChange={(event) => setMetadata({ artist: event.target.value })} />
            </Field>
            <Field label="Album">
              <input className={INPUT} value={metadata.album ?? ""} onChange={(event) => setMetadata({ album: event.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Track">
                <input type="number" min={1} className={INPUT} value={metadata.trackNumber ?? ""} onChange={(event) => setMetadata({ trackNumber: event.target.value ? Math.max(1, Math.round(Number(event.target.value))) : null })} />
              </Field>
              <Field label="Year">
                <input type="number" min={1900} max={2200} className={INPUT} value={metadata.year ?? ""} onChange={(event) => setMetadata({ year: event.target.value ? Math.round(Number(event.target.value)) : null })} />
              </Field>
            </div>
          </div>
        </details>
      ) : (
        <p className="text-xs text-faint">WAV files are written without tags.</p>
      )}
      {job.error ? <p className="text-sm text-danger">{job.error}</p> : null}
      {job.phase === "cancelled" ? <p className="text-sm text-muted">The export was cancelled. Nothing was saved.</p> : null}
      <div className="flex items-center gap-2">
        <button type="button" disabled={gate.blocked} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-40" onClick={() => void startExport()}>
          {candidate ? "Export Applied Mix…" : "Export…"}
        </button>
        <button type="button" className="rounded-md border border-line px-4 py-2 text-sm text-muted hover:text-ink" onClick={() => closeExportDialog()}>
          Cancel
        </button>
        <span className="text-xs text-faint">
          {formatLabel(settings.format)} · {(settings.sampleRate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz · {settings.loudness.mode === "preserve" ? "mix level" : `${settings.loudness.integratedLufs} LUFS`} · ceiling {settings.loudness.ceilingDbtp.toFixed(1)} dBTP
        </span>
      </div>
      {gate.blocked ? <p className="text-xs text-muted">{gate.reason}</p> : null}
    </div>
  );
}

function Running({ job }: { job: ExportSession }) {
  const task = useAppStore((state) => state.tasks.export);
  const status = job.status;
  return (
    <div className="mt-4 space-y-3" role="status" aria-live="polite">
      <p className="text-lg text-ink">{task?.label ?? "Exporting"}</p>
      {task ? <TaskProgress task={task} /> : null}
      {task?.detail ? <p className="text-sm text-muted">{task.detail}</p> : null}
      <ol className="space-y-1 text-sm">
        {(task?.steps ?? []).map((step) => (
          <li key={step.id} className={step.status === "running" ? "text-ink" : step.status === "done" ? "text-muted" : "text-faint"}>
            <span aria-hidden="true" className="mr-2 inline-block w-4 font-mono">
              {step.status === "done" ? "✓" : step.status === "running" ? "→" : "○"}
            </span>
            <span className="sr-only">{step.status === "done" ? "Done: " : step.status === "running" ? "In progress: " : "Waiting: "}</span>
            {step.label}
          </li>
        ))}
      </ol>
      {status?.analysis ? (
        <p className="text-xs text-faint">
          Mix before the loudness stage: {status.analysis.loudness.integratedLufs.toFixed(1)} LUFS, true peak {status.analysis.loudness.truePeakDbtp.toFixed(1)} dBTP. Rendered at {status.analysis.renderSpeed.toFixed(1)}× real time.
        </p>
      ) : null}
      <button type="button" className="rounded-md border border-line bg-panel-2 px-4 py-2 text-sm text-ink" onClick={() => void cancelExport()}>
        Cancel export
      </button>
      <p className="text-xs text-faint">Playback stays available while exporting. Nothing is saved at the chosen location until the file has been verified.</p>
    </div>
  );
}

function Deciding({ job }: { job: ExportSession }) {
  const plan = job.plan;
  if (!plan) return null;
  const target = plan.targetLufs ?? 0;
  return (
    <div className="mt-4 space-y-3 rounded-md border border-accent/60 bg-accent/10 px-4 py-3" role="alertdialog" aria-label="Heavy limiting">
      <p className="text-lg text-ink">Reaching {target.toFixed(1)} LUFS would need heavy limiting</p>
      <p className="text-sm text-muted">
        The mix measures {job.status?.analysis?.loudness.integratedLufs.toFixed(1)} LUFS with a true peak of {job.status?.analysis?.loudness.truePeakDbtp.toFixed(1)} dBTP. To reach {target.toFixed(1)} LUFS under {plan.ceilingDbtp.toFixed(1)} dBTP, the limiter would reduce peaks by up to about {plan.estimatedMaxReductionDb.toFixed(1)} dB, and by more than 3 dB for about {Math.round(plan.estimatedShareOver3db * 100)}% of the song. That may change the mix significantly.
      </p>
      <div className="flex flex-wrap gap-2">
        {plan.saferTargetLufs !== null ? (
          <button type="button" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink" onClick={() => void decideExport("safer")}>
            Use safer level ({plan.saferTargetLufs.toFixed(1)} LUFS)
          </button>
        ) : null}
        <button type="button" className="rounded-md border border-line bg-panel-2 px-4 py-2 text-sm text-ink" onClick={() => void decideExport("continue")}>
          Continue anyway
        </button>
        <button type="button" className="rounded-md border border-line px-4 py-2 text-sm text-muted" onClick={() => void decideExport(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td className="py-0.5 pr-4 text-muted">{label}</td>
      <td className="py-0.5 font-mono text-ink">{value}</td>
    </tr>
  );
}

function Summary({ report, peakMemoryMb }: { report: ExportReport; peakMemoryMb: number | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 space-y-3">
      <p className="text-lg text-ok" role="status">
        ✓ Export completed
      </p>
      <table className="text-sm">
        <tbody>
          <Row label="Format" value={report.format} />
          <Row label="Sample rate" value={`${(report.sampleRate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz`} />
          {report.bitrateKbps !== null ? <Row label="Bitrate" value={`${report.bitrateKbps} kbps${report.format.includes("V0") ? " (average)" : ""}`} /> : <Row label="Bit depth" value={report.bitDepth === 32 ? "32-bit float" : `${report.bitDepth}-bit`} />}
          <Row label="Integrated loudness" value={`${report.integratedLufs.toFixed(1)} LUFS${report.targetLufs !== null ? ` (target ${report.targetLufs.toFixed(1)})` : ""}`} />
          <Row label="True peak" value={`${report.truePeakDbtp.toFixed(1)} dBTP (ceiling ${report.ceilingDbtp.toFixed(1)})`} />
          <Row label="Loudness range" value={`${report.loudnessRangeLu.toFixed(1)} LU`} />
          <Row label="Duration" value={clock(report.durationSeconds)} />
          <Row label="Level change" value={`${report.gainDb >= 0 ? "+" : "−"}${Math.abs(report.gainDb).toFixed(1)} dB${report.limiter.maxReductionDb > 0.05 ? `, limiter up to ${report.limiter.maxReductionDb.toFixed(1)} dB on ${(report.limiter.activeShare * 100).toFixed(1)}% of the song` : ", no limiting"}`} />
          <Row label="Mix before export stage" value={`${report.mix.integratedLufs.toFixed(1)} LUFS, ${report.mix.truePeakDbtp.toFixed(1)} dBTP`} />
          <Row label="Time" value={`${report.totalSeconds.toFixed(1)} s (render ${report.renderSpeed.toFixed(1)}× real time${peakMemoryMb !== null ? `, peak memory ${peakMemoryMb.toFixed(0)} MB` : ""})`} />
        </tbody>
      </table>
      {report.warnings.map((warning) => (
        <p key={warning} className="text-sm text-danger">
          {warning}
        </p>
      ))}
      <details>
        <summary className="cursor-pointer text-xs text-muted">Verification</summary>
        <ul className="mt-1 space-y-0.5 text-xs text-muted">
          {report.verification.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
      <p className="font-mono text-xs break-all text-faint">{report.output}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink" onClick={() => void getPlatform().revealExport(report.output).catch(() => undefined)}>
          Show in folder
        </button>
        <button
          type="button"
          className="rounded-md border border-line px-4 py-2 text-sm text-ink"
          onClick={() => {
            void navigator.clipboard?.writeText(report.output).then(() => setCopied(true)).catch(() => undefined);
          }}
        >
          {copied ? "Copied" : "Copy path"}
        </button>
        <button type="button" className="rounded-md border border-line px-4 py-2 text-sm text-muted" onClick={() => closeExportDialog()}>
          Done
        </button>
      </div>
    </div>
  );
}

function Failed({ job }: { job: ExportSession }) {
  return (
    <div className="mt-4 space-y-3">
      <p className="text-lg text-danger" role="alert">
        The export could not finish
      </p>
      <p className="text-sm text-muted">{job.error ?? "Unknown error."} Nothing was saved at the chosen location.</p>
      <button type="button" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink" onClick={() => useAppStore.getState().setExportJob({ phase: "setup", error: null })}>
        Back to settings
      </button>
    </div>
  );
}
