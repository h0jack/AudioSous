import type { AgentCard, TranscriptEntry } from "@audiosous/mix-agent";
import type { ProjectDocument } from "@audiosous/project-model";
import { useEffect, useRef, useState } from "react";
import { applyAssistantCandidate, applyFocus, cancelAssistant, refreshAssistantSettings, resetAssistantConversation, saveAssistantSettings, sendAssistantMessage } from "../lib/assistant";
import { fullMixPlanFresh, setFullMixPreview } from "../lib/full-mix";
import { getPlatform } from "../platform";
import type { AgentSettingsInfo } from "../platform/types";
import { useAppStore, type AssistantState, type FullMixSession } from "../state/app-store";
import { Button } from "./ui";

/**
 * The conversational assistant in the Mix workspace. It is a way to drive the mix tools, not a separate chat: its
 * candidates open in Plans → Full Mix, its cards play and apply through the same A/B and apply, and it points the
 * timeline and the review at what it is talking about. Nothing is applied unless the person says so or clicks Apply.
 */
export function AssistantPanel() {
  const assistant = useAppStore((state) => state.assistant);
  const document = useAppStore((state) => state.document);
  const fullMix = useAppStore((state) => state.fullMix);
  if (!document) return null;
  return <AssistantPanelView assistant={assistant} document={document} fullMix={fullMix} />;
}

export function AssistantPanelView({ assistant, document, fullMix }: { assistant: AssistantState; document: ProjectDocument; fullMix: FullMixSession }) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const session = assistant.session && document && assistant.session.projectId === document.project.id ? assistant.session : null;
  const entries = session?.transcript ?? [];
  const settings = assistant.settings;
  const configured = Boolean(settings && settings.provider !== "none" && settings.keySource);
  const desktop = getPlatform().kind === "tauri";

  useEffect(() => {
    if (!assistant.settings) void refreshAssistantSettings();
  }, [assistant.settings]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [entries.length, assistant.pending, assistant.activity]);

  const currentId = session?.currentCandidateId ?? null;
  const candidateFresh = fullMixPlanFresh(document, fullMix);

  const send = (text: string) => {
    if (!text.trim()) return;
    setDraft("");
    void sendAssistantMessage(text);
  };

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-line bg-panel" aria-label="Assistant">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="text-sm text-ink">Assistant</h2>
        <span className="truncate text-[11px] text-faint" title="Which AI provider answers">
          {configured ? `${settings!.provider === "anthropic" ? "Anthropic" : settings!.provider} · ${settings!.model}` : "Not connected"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="rounded px-1.5 py-0.5 text-xs text-muted hover:text-ink" onClick={() => useAppStore.getState().setAssistant({ showSettings: !assistant.showSettings })} aria-pressed={assistant.showSettings}>
            Settings
          </button>
          <button type="button" className="rounded px-1.5 py-0.5 text-xs text-muted hover:text-ink disabled:opacity-40" disabled={entries.length === 0 && !assistant.busy} onClick={() => resetAssistantConversation()} title="Start a new conversation. Candidates already in the review stay there.">
            New
          </button>
          <button type="button" className="rounded px-1.5 py-0.5 text-xs text-muted hover:text-ink" onClick={() => useAppStore.getState().setAssistant({ open: false })} aria-label="Close the assistant">
            ✕
          </button>
        </div>
      </div>

      {assistant.showSettings || (!configured && desktop) ? <ProviderSettings settings={settings} /> : null}

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-3" aria-live="polite">
        {entries.length === 0 && !assistant.pending ? <Intro configured={configured} desktop={desktop} /> : null}
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} currentCandidateId={currentId} candidateFresh={candidateFresh} onOption={send} busy={assistant.busy} fullMix={fullMix} />
        ))}
        {assistant.pending ? (
          <>
            <UserBubble text={assistant.pending} />
            <div className="flex items-center gap-2 text-xs text-accent" role="status">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
              <span className="truncate">{assistant.activity ?? "Working…"}</span>
              <button type="button" className="ml-auto text-muted underline-offset-2 hover:underline" onClick={() => cancelAssistant()}>
                Cancel
              </button>
            </div>
          </>
        ) : null}
        {assistant.error ? <p className="text-xs text-danger">{assistant.error}</p> : null}
      </div>

      <form
        className="border-t border-line p-2"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <textarea
          aria-label="Message the assistant"
          rows={2}
          value={draft}
          disabled={!desktop}
          placeholder={desktop ? "Describe what you hear or want: “the chorus feels weak”, “the kick gets lost under the bass”…" : "The assistant needs the desktop app."}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send(draft);
            }
          }}
          className="w-full resize-none rounded-md border border-line bg-canvas px-2 py-1.5 text-sm text-ink placeholder:text-faint"
        />
        <div className="mt-1 flex items-center gap-2">
          <p className="text-[11px] leading-snug text-faint">Nothing is applied until you say so. Audio never leaves this computer.</p>
          <Button type="submit" tone="accent" className="ml-auto px-3 py-1 text-xs" disabled={!draft.trim() || !desktop}>
            Send
          </Button>
        </div>
      </form>
    </aside>
  );
}

function Intro({ configured, desktop }: { configured: boolean; desktop: boolean }) {
  if (!desktop) return <p className="text-sm text-muted">The assistant reads the desktop analysis cache and plans with the playback proxies. Open this project in the desktop app.</p>;
  if (!configured) return <p className="text-sm text-muted">Connect an AI provider to use conversational mixing. Level, EQ, Space, Dynamics, and Full Mix work without it.</p>;
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>Tell me what you hear or what you want. I'll check the mix with Audiosous's planners, explain what I find, and build a candidate you can preview, adjust, and apply.</p>
      <p className="text-xs text-faint">Try: “What's wrong with the chorus?” · “The kick is getting lost under the bass.” · “Make the drop wider, but don't touch the vocal.” · “Less aggressive.” · “Why did you cut the pad?”</p>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return <p className="ml-8 rounded-lg bg-panel-2 px-3 py-2 text-sm whitespace-pre-wrap text-ink">{text}</p>;
}

function Entry({ entry, currentCandidateId, candidateFresh, onOption, busy, fullMix }: { entry: TranscriptEntry; currentCandidateId: string | null; candidateFresh: boolean; onOption: (text: string) => void; busy: boolean; fullMix: FullMixSession }) {
  if (entry.role === "user") return <UserBubble text={entry.text} />;
  return (
    <div className="space-y-2">
      {entry.activity?.length ? (
        <details className="text-[11px] text-faint">
          <summary className="cursor-pointer select-none">{entry.activity.length} {entry.activity.length === 1 ? "step" : "steps"}</summary>
          <ul className="mt-1 list-disc pl-4">
            {entry.activity.map((line, index) => (
              <li key={`${index}-${line}`}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className={`text-sm whitespace-pre-wrap ${entry.error ? "text-danger" : "text-ink"}`}>{entry.text}</p>
      {entry.cards?.map((card, index) => (
        <Card key={`${entry.id}-${index}`} card={card} current={card.kind === "candidate" && card.candidateId === currentCandidateId} fresh={candidateFresh} fullMix={fullMix} />
      ))}
      {entry.options?.length ? (
        <div className="flex flex-wrap gap-1">
          {entry.options.map((option) => (
            <button key={option} type="button" disabled={busy} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink hover:bg-panel-2 disabled:opacity-40" onClick={() => onOption(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Card({ card, current, fresh, fullMix }: { card: AgentCard; current: boolean; fresh: boolean; fullMix: FullMixSession }) {
  if (card.kind === "candidate") {
    const live = current && fresh;
    return (
      <div className="rounded-md border border-line bg-canvas px-3 py-2">
        <div className="flex items-baseline gap-2">
          <p className="text-xs font-medium text-ink">{card.label}</p>
          {current && !fresh ? <span className="text-[11px] text-danger">Out of date: the mix changed. Ask me to rebuild it.</span> : !current ? <span className="text-[11px] text-faint">Not the current candidate</span> : null}
        </div>
        <p className="mt-0.5 text-[11px] text-muted">{card.headline}</p>
        {card.changes.length ? (
          <ul className="mt-1 list-disc pl-4 text-xs text-ink">
            {card.changes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        {live ? (
          <div className="mt-2 flex flex-wrap gap-1">
            <Button className="px-2 py-1 text-xs" tone={fullMix.preview && !fullMix.focus ? "accent" : "ghost"} title="Hear this candidate (loudness-matched by default)" onClick={() => setFullMixPreview(true)}>
              Preview
            </Button>
            <Button className="px-2 py-1 text-xs" tone={!fullMix.preview && !fullMix.focus ? "accent" : "ghost"} title="Hear the saved mix" onClick={() => setFullMixPreview(false)}>
              Current
            </Button>
            <Button className="px-2 py-1 text-xs" title="Open it in Plans → Full Mix: evidence, alternatives, per-change A/B and editors" onClick={() => applyFocus({ tab: "full" })}>
              Inspect
            </Button>
            <Button className="px-2 py-1 text-xs" title="Write the candidate as shown (proposed and accepted changes) into the project as one undo step" onClick={() => applyAssistantCandidate("all")}>
              Apply
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  if (card.kind === "problem") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-1.5">
        <p className="min-w-0 flex-1 truncate text-xs text-ink">{card.title}</p>
        <span className="font-mono text-[11px] text-faint">{card.severity.toFixed(2)}</span>
        <button type="button" className="text-xs text-accent underline-offset-2 hover:underline" onClick={() => applyFocus({ problemId: card.problemId, tab: "full" })}>
          Inspect
        </button>
      </div>
    );
  }
  if (card.kind === "change") return null;
  return (
    <div className="rounded-md border border-line bg-canvas px-3 py-2">
      <p className="text-xs font-medium text-ink">{card.kind === "applied" ? "Applied" : "Candidate updated"}</p>
      <ul className="mt-1 list-disc pl-4 text-xs text-ink">
        {card.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {card.kind === "applied" ? <p className="mt-1 text-[11px] text-faint">One undo step restores the previous mix.</p> : null}
    </div>
  );
}

/** Provider setup and the privacy disclosure. The key goes to the desktop shell and is never shown again. */
function ProviderSettings({ settings }: { settings: AgentSettingsInfo | null }) {
  const [provider, setProvider] = useState<"none" | "anthropic">(settings?.provider ?? "anthropic");
  const [model, setModel] = useState(settings?.model || "claude-opus-5-5");
  const [effort, setEffort] = useState<"low" | "medium" | "high">(settings?.effort ?? "medium");
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const desktop = getPlatform().kind === "tauri";
  useEffect(() => {
    if (!settings) return;
    setProvider(settings.provider === "none" && !settings.keySource ? "anthropic" : settings.provider);
    setModel(settings.model || "claude-opus-5-5");
    setEffort(settings.effort);
  }, [settings]);
  if (!desktop) return null;
  const save = async (clearKey = false) => {
    const error = await saveAssistantSettings({ provider, model: model.trim(), effort, apiKey: key.trim() || null, clearKey });
    setKey("");
    setMessage(error ?? (clearKey ? "Stored key removed." : "Saved."));
  };
  return (
    <div className="space-y-2 border-b border-line bg-canvas px-3 py-3 text-xs">
      <p className="text-muted">
        <span className="text-ink">Privacy.</span> When a provider is connected, each message sends structured project information to it: stem names and roles, section names and notes,
        fader, pan, width, and processing settings, measured levels and problem summaries from the planners, and the conversation. Audio, waveforms, file paths, and your API key are never
        sent. Nothing is sent until you send a message. Settings are stored with the app, not in the project.
      </p>
      <label className="flex items-center gap-2">
        <span className="w-16 text-muted">Provider</span>
        <select value={provider} onChange={(event) => setProvider(event.target.value as "none" | "anthropic")} className="rounded-md border border-line bg-panel px-2 py-1 text-ink">
          <option value="anthropic">Anthropic</option>
          <option value="none">None (assistant off)</option>
        </select>
      </label>
      {provider === "anthropic" ? (
        <>
          <label className="flex items-center gap-2">
            <span className="w-16 text-muted">Model</span>
            <input value={model} onChange={(event) => setModel(event.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 font-mono text-ink" />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-16 text-muted">Effort</span>
            <select value={effort} onChange={(event) => setEffort(event.target.value as "low" | "medium" | "high")} className="rounded-md border border-line bg-panel px-2 py-1 text-ink">
              <option value="low">Low (fastest)</option>
              <option value="medium">Medium</option>
              <option value="high">High (slowest)</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-16 text-muted">API key</span>
            <input type="password" autoComplete="off" value={key} placeholder={settings?.keySource === "environment" ? "From ANTHROPIC_API_KEY" : settings?.keySource === "settings" ? "Stored (enter a new one to replace)" : "sk-ant-…"} onChange={(event) => setKey(event.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 font-mono text-ink" />
          </label>
        </>
      ) : null}
      <div className="flex items-center gap-2">
        <Button tone="accent" className="px-3 py-1 text-xs" onClick={() => void save()}>
          Save
        </Button>
        {settings?.keySource === "settings" ? (
          <Button className="px-3 py-1 text-xs" onClick={() => void save(true)}>
            Remove stored key
          </Button>
        ) : null}
        {message ? <span className="text-faint">{message}</span> : null}
        <button type="button" className="ml-auto text-muted underline-offset-2 hover:underline" onClick={() => useAppStore.getState().setAssistant({ showSettings: false })}>
          Close
        </button>
      </div>
    </div>
  );
}
