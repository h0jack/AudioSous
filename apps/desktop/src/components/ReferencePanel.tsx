import type { MixStrength, ReferenceComparison } from "@audiosous/mix-planner";
import type { ProjectDocument } from "@audiosous/project-model";
import { useEffect, useState } from "react";
import { deleteReference, importReference, loadReferences, measureMix, mixKeyOf, planTowardReference, referenceComparison, selectReference, selectedReference, setReferenceListening } from "../lib/reference";
import type { usePlayback } from "../lib/playback";
import { isTauri } from "../platform";
import { useAppStore } from "../state/app-store";
import { CurvePlot } from "./ChangesView";
import { PlannerStatus } from "./ProcessingStatus";
import { Button } from "./ui";

type Playback = ReturnType<typeof usePlayback>;

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
}

/**
 * A reference song: what your mix measures against it, an A/B on the playback clock at matched loudness, and a
 * plan of stem changes toward it that opens in Full Mix for review and Apply.
 */
export function ReferencePanel({ document, playback }: { document: ProjectDocument; playback: Playback }) {
  const reference = useAppStore((state) => state.reference);
  const fullMix = useAppStore((state) => state.fullMix);
  const [strength, setStrength] = useState<MixStrength>("normal");
  const [view, setView] = useState<"shapes" | "difference">("difference");
  useEffect(() => {
    if (reference.phase === "idle" && reference.references.length === 0 && isTauri()) void loadReferences();
    // Load once per project; a new project resets the session.
  }, [document.project.id]);
  const stale = reference.mixKey !== null && reference.mixKey !== mixKeyOf(document);
  useEffect(() => {
    if (stale && reference.selected && reference.phase === "idle") void measureMix();
  }, [stale, reference.selected, reference.phase]);
  const info = selectedReference(reference);
  const now = referenceComparison(reference, "mix");
  const after = referenceComparison(reference, "candidate");
  const busy = reference.phase === "importing" || reference.phase === "measuring" || reference.phase === "planning" || reference.phase === "checking" || reference.phase === "loading";
  const candidateOpen = Boolean(fullMix.plan && reference.planCreatedAt === fullMix.plan.createdAt && fullMix.phase === "ready");
  const plan = candidateOpen ? fullMix.plan : null;
  const matchDb = info && reference.mixProfile ? reference.mixProfile.loudness.integratedLufs - info.profile.loudness.integratedLufs : null;
  if (!isTauri()) return <p className="border-t border-line px-4 py-3 text-sm text-muted">Reference songs need the desktop app.</p>;
  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-line bg-panel" aria-label="Reference">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <h2 className="text-sm text-ink">Reference</h2>
        <select aria-label="Reference song" className="max-w-64 rounded-md border border-line bg-canvas py-1 pr-6 pl-2 text-xs text-ink" value={reference.selected ?? ""} disabled={busy} onChange={(event) => selectReference(event.target.value || null)}>
          <option value="">{reference.references.length ? "No reference" : "No reference yet"}</option>
          {reference.references.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
        <Button className="px-3 py-1.5 text-xs" disabled={busy} title="Add a song you want the mix to be like (WAV, AIFF, FLAC, or MP3). It is copied into the project; your file is not changed." onClick={() => void importReference()}>
          Add reference…
        </Button>
        {info ? (
          <button type="button" className="text-xs text-muted underline-offset-2 hover:underline" disabled={busy} onClick={() => void deleteReference(info.name)}>
            Remove
          </button>
        ) : null}
        {info ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-line p-0.5" role="radiogroup" aria-label="Listen to">
              {(["mix", "reference"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  role="radio"
                  aria-checked={(side === "reference") === reference.listening}
                  disabled={playback.engineKind !== "native"}
                  className={`rounded px-2.5 py-0.5 text-xs disabled:opacity-40 ${(side === "reference") === reference.listening ? "bg-accent text-accent-ink" : "text-muted hover:text-ink"}`}
                  onClick={() => setReferenceListening(side === "reference")}
                >
                  {side === "mix" ? "Your mix" : "Reference"}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-faint">{matchDb === null ? "Measuring loudness…" : `Reference played ${signed(matchDb)} dB to match your mix's loudness`}</span>
            <label className="flex items-center gap-1 text-xs text-muted">
              Strength
              <select aria-label="Reference plan strength" className="rounded-md border border-line bg-canvas py-1 pr-6 pl-2 text-xs text-ink" value={strength} onChange={(event) => setStrength(event.target.value as MixStrength)}>
                <option value="conservative">Conservative</option>
                <option value="normal">Normal</option>
                <option value="strong">Strong</option>
              </select>
            </label>
            <Button tone="accent" className="px-3 py-1.5 text-xs" disabled={busy || !reference.mixProfile} title="Plan stem EQ, level, and width changes that move your mix toward the reference. Opens in Full Mix; nothing is saved until you apply it." onClick={() => void planTowardReference(strength)}>
              Plan toward reference
            </Button>
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3 group-data-[collapsed=true]:hidden">
        <PlannerStatus kind="reference" />
        {reference.progress ? <p className="mt-1 text-sm text-muted">{reference.progress}</p> : null}
        {reference.error ? <p className="mt-1 text-sm text-danger">{reference.error}</p> : null}
        {!info ? (
          <p className="max-w-3xl text-sm text-muted">
            Add a finished song you want your mix to be like. Audiosous measures both the same way (tonal balance over the body of the song with loudness removed, width per region, low-end mono-ness, dynamics, loudness), lets you switch between them at the same playhead at matched loudness, and can plan stem changes toward it that you review and apply like any Full Mix plan.
          </p>
        ) : null}
        {info && now ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-[10px] tracking-wide text-faint uppercase">Tonal balance, loudness removed</p>
                <div className="flex rounded-md border border-line p-0.5" role="radiogroup" aria-label="Tonal view">
                  {(["difference", "shapes"] as const).map((value) => (
                    <button key={value} type="button" role="radio" aria-checked={view === value} className={`rounded px-2 py-0.5 text-[11px] ${view === value ? "bg-panel-2 text-ink" : "text-muted"}`} onClick={() => setView(value)}>
                      {value === "difference" ? "Difference" : "Both shapes"}
                    </button>
                  ))}
                </div>
              </div>
              <TonalPlot comparison={now} after={after} view={view} />
              <p className="text-[11px] text-faint">
                {view === "difference" ? "Filled: your mix minus the reference (above the line: more than the reference). Dashed: the planned candidate, measured." : "Solid: your mix. Dashed: the reference."} Both songs measured over their body (quiet intros and fades left out).
              </p>
            </div>
            <div className="flex flex-col gap-3">
              <RegionTable comparison={now} after={after} plan={plan} />
              <Findings comparison={now} />
              <Numbers comparison={now} after={after} />
            </div>
          </div>
        ) : null}
        {candidateOpen && plan ? (
          <div className="mt-3 rounded-md border border-accent/60 px-3 py-2 text-sm">
            <p className="text-ink">{plan.summary.headline}</p>
            <p className="mt-1 text-xs text-muted">The candidate is open in Full Mix: preview it against your mix, inspect each change, and apply it as one undo step.</p>
            <button type="button" className="mt-1 text-xs text-accent underline-offset-2 hover:underline" onClick={() => useAppStore.getState().setPlanTab("full")}>
              Open the candidate in Full Mix
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TonalPlot({ comparison, after, view }: { comparison: ReferenceComparison; after: ReferenceComparison | null; view: "shapes" | "difference" }) {
  if (view === "shapes") {
    const range = Math.max(12, Math.ceil(Math.max(...comparison.bands.flatMap((band) => [Math.abs(band.mixDb), Math.abs(band.referenceDb)])) / 6) * 6);
    return (
      <CurvePlot
        series={[
          { points: comparison.bands.map((band) => ({ hz: band.hz, db: band.referenceDb })), style: "dashed", label: "Reference (dashed)" },
          { points: comparison.bands.map((band) => ({ hz: band.hz, db: band.mixDb })), style: "solid", label: "Your mix (solid)" },
        ]}
        rangeDb={range}
        scaleLabel={`Shape scale ±${range} dB`}
        height={150}
      />
    );
  }
  const largest = Math.max(1, ...comparison.bands.map((band) => Math.abs(band.gapDb)), ...(after?.bands.map((band) => Math.abs(band.gapDb)) ?? []));
  const range = [2, 3, 6, 12, 24].find((value) => largest <= value * 0.92) ?? 24;
  return (
    <CurvePlot
      series={[
        { points: comparison.bands.map((band) => ({ hz: band.hz, db: band.gapDb })), style: "area", label: "Your mix minus the reference (filled)" },
        ...(after ? [{ points: after.bands.map((band) => ({ hz: band.hz, db: band.gapDb })), style: "dashed" as const, label: "Planned candidate minus the reference (dashed)" }] : []),
      ]}
      rangeDb={range}
      scaleLabel={`Difference scale ±${range} dB`}
      height={150}
    />
  );
}

function RegionTable({ comparison, after, plan }: { comparison: ReferenceComparison; after: ReferenceComparison | null; plan: { reference?: { regions: Array<{ id: string; gapAfterDb: number }> } } | null }) {
  return (
    <table className="text-left text-xs">
      <thead className="text-[10px] tracking-wide text-faint uppercase">
        <tr>
          <th className="pr-3 font-medium">Region</th>
          <th className="pr-3 font-medium">Your mix vs reference</th>
          {plan ? <th className="pr-3 font-medium">Planned (model)</th> : null}
          {after ? <th className="pr-3 font-medium">Candidate (measured)</th> : null}
          <th className="font-medium" />
        </tr>
      </thead>
      <tbody>
        {comparison.tonal.map((gap) => {
          const planned = plan?.reference?.regions.find((item) => item.id === gap.region.id)?.gapAfterDb ?? null;
          const measured = after?.tonal.find((item) => item.region.id === gap.region.id)?.gapDb ?? null;
          const notable = Math.abs(gap.gapDb) >= 1;
          return (
            <tr key={gap.region.id} className="border-t border-line">
              <td className="py-1 pr-3 text-muted">{gap.region.label}</td>
              <td className={`py-1 pr-3 font-mono ${notable ? "text-ink" : "text-faint"}`}>{signed(gap.gapDb)} dB</td>
              {plan ? <td className="py-1 pr-3 font-mono text-muted">{planned === null ? "—" : `${signed(planned)} dB`}</td> : null}
              {after ? <td className="py-1 pr-3 font-mono text-accent">{measured === null ? "—" : `${signed(measured)} dB`}</td> : null}
              <td className="py-1 text-faint">{notable ? (gap.gapDb > 0 ? gap.region.more : gap.region.less) : "close"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Findings({ comparison }: { comparison: ReferenceComparison }) {
  if (comparison.findings.length === 0) return <p className="text-xs text-muted">Your mix is within 1 dB of the reference in every region, with similar width and dynamics.</p>;
  return (
    <ul className="space-y-0.5 text-xs text-ink">
      {comparison.findings.map((line) => (
        <li key={line}>• {line}</li>
      ))}
    </ul>
  );
}

function Numbers({ comparison, after }: { comparison: ReferenceComparison; after: ReferenceComparison | null }) {
  const rows: Array<[string, string, string, string | null]> = [
    ["Loudness", `${comparison.loudness.mixLufs.toFixed(1)} LUFS`, `${comparison.loudness.referenceLufs.toFixed(1)} LUFS`, null],
    ["Peak to loudness", `${comparison.dynamics.mixPlrDb.toFixed(1)} dB`, `${comparison.dynamics.referencePlrDb.toFixed(1)} dB`, null],
    ["Loudness range", `${comparison.dynamics.mixLraLu.toFixed(1)} LU`, `${comparison.dynamics.referenceLraLu.toFixed(1)} LU`, null],
    ["Low-end correlation (under 120 Hz)", comparison.lowCorrelation.mix.toFixed(2), comparison.lowCorrelation.reference.toFixed(2), after ? after.lowCorrelation.mix.toFixed(2) : null],
    ...comparison.width.map((gap): [string, string, string, string | null] => [
      `Sides vs center, ${gap.region.label}`,
      `${gap.mixSideDb.toFixed(1)} dB`,
      `${gap.referenceSideDb.toFixed(1)} dB`,
      after ? `${after.width.find((item) => item.region.id === gap.region.id)!.mixSideDb.toFixed(1)} dB` : null,
    ]),
  ];
  return (
    <table className="text-left text-xs">
      <thead className="text-[10px] tracking-wide text-faint uppercase">
        <tr>
          <th className="pr-3 font-medium" />
          <th className="pr-3 font-medium">Your mix</th>
          <th className="pr-3 font-medium">Reference</th>
          {after ? <th className="font-medium">Candidate</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, mix, ref, candidate]) => (
          <tr key={label}>
            <td className="py-0.5 pr-3 text-muted">{label}</td>
            <td className="py-0.5 pr-3 font-mono text-ink">{mix}</td>
            <td className="py-0.5 pr-3 font-mono text-ink">{ref}</td>
            {after ? <td className="py-0.5 font-mono text-accent">{candidate ?? "—"}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
