"use client";

import { KV } from "@/components/ui";

export type Definition = {
  key: string;
  label: string;
  description?: string;
  dataType: "STRING" | "TEXT" | "NUMBER" | "INTEGER" | "BOOLEAN" | "DATE" | "ENUM";
  enumValues: string[];
  unit: string;
  group: string;
  order: number;
  required?: boolean;
  requiredForRelease: boolean;
  owner: "plm" | "onshape";
  syncDirection?: "none" | "from-onshape" | "to-onshape" | "both";
  authority?: "plm" | "onshape";
  onshapePropertyName?: string;
  mapped?: boolean;
  editable: boolean;
  lockReason?: string | null;
};

/**
 * One attribute, rendered from its definition.
 *
 * Deliberately dumb about governance: whether a field may be edited, and why
 * not, is decided on the server and arrives on the definition. Working that
 * out here as well would be a second implementation of the rules, and the two
 * would drift the first time a rule changed.
 *
 * A locked attribute is shown as a value with its reason, not as a disabled
 * input. A greyed-out box invites people to try clicking it and says nothing
 * about why they cannot.
 */
export function AttributeInput({
  def, value, error, onChange,
}: {
  def: Definition;
  value: unknown;
  error?: string;
  onChange: (v: unknown) => void;
}) {
  const badges = (
    <span style={{ display: "inline-flex", gap: 5, marginLeft: 6, verticalAlign: "middle" }}>
      {def.requiredForRelease && (
        <span
          className="badge"
          title="Must hold a value before this object can be released"
          style={{ background: "var(--warn-soft)", color: "var(--warn)", borderColor: "var(--warn)" }}
        >
          release
        </span>
      )}
      {def.owner === "plm" ? (
        <span className="badge" title="PLM's own data — Onshape has no equivalent">PLM</span>
      ) : (
        <span
          className="badge"
          title={
            def.syncDirection === "both"
              ? `Mapped both ways to Onshape's "${def.onshapePropertyName}" — ${def.authority === "plm" ? "PLM" : "Onshape"} wins on conflict`
              : def.syncDirection === "to-onshape"
                ? `Written to Onshape's "${def.onshapePropertyName}"`
                : `Mirrored from Onshape's "${def.onshapePropertyName}"`
          }
        >
          {def.syncDirection === "both" ? "⇄" : def.syncDirection === "to-onshape" ? "→" : "←"} CAD
        </span>
      )}
      {def.owner === "onshape" && def.mapped === false && (
        <span
          className="badge"
          title={`No Onshape property named "${def.onshapePropertyName}" was found on this tenant. Run discovery in Settings.`}
          style={{ background: "var(--danger-soft)", color: "var(--danger)", borderColor: "var(--danger)" }}
        >
          unmapped
        </span>
      )}
    </span>
  );

  if (!def.editable) {
    return (
      <div>
        <KV k={def.label} v={display(def, value)} mono={def.dataType === "NUMBER"} />
        <p style={{ fontSize: 11, color: "var(--text-faint)", margin: "3px 0 0" }}>
          {def.lockReason}
          {badges}
        </p>
      </div>
    );
  }

  const common = { id: `attr-${def.key}`, "aria-invalid": error ? true : undefined };

  return (
    <div>
      <label className="label" htmlFor={`attr-${def.key}`}>
        {def.label}
        {def.unit ? <span style={{ color: "var(--text-faint)" }}> ({def.unit})</span> : null}
        {badges}
      </label>

      {def.dataType === "TEXT" ? (
        <textarea
          {...common}
          className="input"
          rows={3}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : def.dataType === "ENUM" ? (
        <select
          {...common}
          className="select"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">— not set —</option>
          {def.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      ) : def.dataType === "BOOLEAN" ? (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input
            {...common}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {value === true ? "Yes" : "No"}
        </label>
      ) : def.dataType === "DATE" ? (
        <input
          {...common}
          className="input"
          type="date"
          value={value ? String(value).slice(0, 10) : ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      ) : (
        <input
          {...common}
          className="input"
          type={def.dataType === "NUMBER" || def.dataType === "INTEGER" ? "number" : "text"}
          step={def.dataType === "INTEGER" ? 1 : "any"}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        />
      )}

      {error && (
        <p role="alert" style={{ fontSize: 11.5, color: "var(--danger)", margin: "4px 0 0" }}>
          {error}
        </p>
      )}
      {!error && def.description && (
        <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "4px 0 0" }}>
          {def.description}
        </p>
      )}
    </div>
  );
}

function display(def: Definition, value: unknown): string {
  if (value == null || value === "") return "";
  if (def.dataType === "BOOLEAN") return value ? "Yes" : "No";
  if (def.dataType === "DATE") return new Date(String(value)).toLocaleDateString();
  return def.unit ? `${value} ${def.unit}` : String(value);
}
