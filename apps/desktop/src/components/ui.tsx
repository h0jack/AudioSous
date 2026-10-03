import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { TRACK_ROLE_IDS, TRACK_ROLE_LABELS, type TrackRole } from "@audiosous/project-model";

export function Button({
  tone = "ghost",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "accent" | "ghost" }) {
  const colors =
    tone === "accent"
      ? "bg-accent text-accent-ink hover:brightness-105"
      : "border border-line bg-panel-2 text-ink hover:bg-panel";
  return (
    <button
      {...props}
      className={`rounded-md px-3.5 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${colors} ${className}`}
    />
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
  ...props
}: {
  value: TrackRole;
  onChange: (role: TrackRole) => void;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">) {
  return (
    <select
      {...props}
      value={value}
      onChange={(event) => onChange(event.target.value as TrackRole)}
      className="w-full rounded-md border border-line bg-canvas px-2 py-2 text-sm"
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
