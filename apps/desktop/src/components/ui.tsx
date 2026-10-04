import type { ButtonHTMLAttributes, CSSProperties, ReactNode, SelectHTMLAttributes } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TRACK_ROLE_IDS, TRACK_ROLE_LABELS, type TrackRole } from "@audiosous/project-model";

export function HoverTip({
  label,
  children,
  className = "",
  style,
}: {
  label: string | ((host: HTMLElement) => string);
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const [tip, setTip] = useState<{ x: number; y: number; above: boolean; text: string } | null>(null);
  return (
    <span
      className={className}
      style={style}
      onMouseEnter={(event) => {
        const text = typeof label === "function" ? label(event.currentTarget) : label;
        if (!text) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const above = rect.top > 40;
        setTip({
          x: Math.min(window.innerWidth - 12, Math.max(12, rect.left + rect.width / 2)),
          y: above ? rect.top - 6 : rect.bottom + 6,
          above,
          text,
        });
      }}
      onMouseLeave={() => setTip(null)}
    >
      {children}
      {tip
        ? createPortal(
            <span
              role="tooltip"
              className={`pointer-events-none fixed z-50 max-w-xs -translate-x-1/2 rounded bg-ink px-2 py-1 text-center text-[11px] leading-snug text-canvas shadow ${tip.above ? "-translate-y-full" : ""}`}
              style={{ left: tip.x, top: tip.y }}
            >
              {tip.text}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

export function Truncated({ text, className = "" }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setOverflows(node.scrollWidth > node.clientWidth + 1);
  }, [text]);
  const body = (
    <span ref={ref} className={`block min-w-0 truncate ${className}`}>
      {text}
    </span>
  );
  if (!overflows) return body;
  return (
    <HoverTip label={text} className="block min-w-0">
      {body}
    </HoverTip>
  );
}

export function Button({
  tone = "ghost",
  className = "",
  title,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "accent" | "ghost" }) {
  const colors =
    tone === "accent"
      ? "bg-accent text-accent-ink hover:brightness-105"
      : "border border-line bg-panel-2 text-ink hover:bg-panel";
  const button = (
    <button
      {...props}
      disabled={disabled}
      className={`rounded-md px-3.5 py-2 text-sm font-medium disabled:opacity-40 ${disabled ? "pointer-events-none" : ""} ${colors} ${className}`}
    />
  );
  if (!title) return button;
  return (
    <HoverTip label={title} className={`inline-flex ${disabled ? "cursor-not-allowed" : ""}`}>
      {button}
    </HoverTip>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs tracking-wide text-muted uppercase">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-line bg-canvas px-3 py-2 text-ink"
      />
    </label>
  );
}

export function RoleSelect({
  value,
  onChange,
  className = "",
  ...props
}: {
  value: TrackRole;
  onChange: (role: TrackRole) => void;
  className?: string;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">) {
  return (
    <select
      {...props}
      value={value}
      onChange={(event) => onChange(event.target.value as TrackRole)}
      className={`w-full rounded-md border border-line bg-canvas pr-7 pl-2 text-sm text-ink ${className.includes("py-") ? "" : "py-2"} ${className}`}
    >
      {TRACK_ROLE_IDS.map((role) => (
        <option key={role} value={role}>
          {TRACK_ROLE_LABELS[role]}
        </option>
      ))}
    </select>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-line bg-panel ${className}`}>{children}</section>;
}
