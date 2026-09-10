"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Field, Spinner } from "@/components/ui";

type Def = {
  id: string;
  objectType: "PART" | "DRAWING";
  key: string;
  label: string;
  description: string;
  dataType: string;
  enumValues: string[];
  unit: string;
  defaultValue: unknown;
  required: boolean;
  requiredForRelease: boolean;
  editableInStates: string[];
  frozenAtRelease: boolean;
  owner: "plm" | "onshape";
  onshapePropertyName: string;
  onshapePropertyId: string;
  syncDirection: "none" | "from-onshape" | "to-onshape" | "both";
  authority: "plm" | "onshape";
  order: number;
  group: string;
  system: boolean;
};

const DIRECTION_LABEL: Record<string, string> = {
  none: "PLM only",
  "from-onshape": "Read from Onshape",
  "to-onshape": "Written to Onshape",
  both: "Both ways",
};

export function AttributesClient({ isAdmin }: { isAdmin: boolean }) {
  const [defs, setDefs] = useState<Def[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [dataTypes, setDataTypes] = useState<string[]>([]);
  const [available, setAvailable] = useState<{ propertyId: string; name: string; valueType: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [objectType, setObjectType] = useState<"PART" | "DRAWING">("PART");
  const [editing, setEditing] = useState<Def | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, m] = await Promise.all([
        fetch("/api/attributes").then((r) => r.json()),
        fetch("/api/onshape/properties").then((r) => r.json()),
      ]);
      if (a.error) throw new Error(a.error);
      setDefs(a.definitions);
      setStates(a.states);
      setDataTypes(a.dataTypes);
      setAvailable(m.available ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function seed() {
    setBusy("seed");
    try {
      const r = await fetch("/api/attributes", { method: "PUT" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not work");
      setNotice(j.message);
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function save(d: Partial<Def>, id?: string) {
    setBusy("save");
    setError(null);
    try {
      const r = await fetch(id ? `/api/attributes/${id}` : "/api/attributes", {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(d),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not work");
      setNotice(j.warning ?? (id ? "Saved." : `Added "${d.label}".`));
      setEditing(null);
      setAdding(false);
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(d: Def) {
    if (!confirm(
      `Remove "${d.label}"? Values already stored against "${d.key}" are left alone — ` +
      `re-adding an attribute with the same key would show them again.`
    )) return;
    setBusy(d.id);
    try {
      const r = await fetch(`/api/attributes/${d.id}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not work");
      setNotice(j.message);
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const shown = defs.filter((d) => d.objectType === objectType);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 19 }}>Attribute schema</h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)", maxWidth: 780 }}>
          What makes these PLM attributes rather than mirrored CAD properties: each one declares
          its type, whether it must hold a value to release, which lifecycle states it may be
          edited in, whether it freezes once released, and which system is allowed to author it.
        </p>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 3 }}>
          {(["PART", "DRAWING"] as const).map((t) => (
            <button
              key={t}
              className="btn btn-sm"
              onClick={() => setObjectType(t)}
              style={{
                borderColor: objectType === t ? "var(--accent)" : undefined,
                color: objectType === t ? "var(--accent)" : undefined,
              }}
            >
              {t === "PART" ? "Parts and assemblies" : "Drawings"} (
              {defs.filter((d) => d.objectType === t).length})
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {isAdmin && (
          <>
            <button className="btn btn-sm" onClick={seed} disabled={busy != null}>
              {busy === "seed" ? <Spinner /> : "Add the starting schema"}
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => { setAdding(true); setEditing(null); }}>
              Add an attribute
            </button>
          </>
        )}
      </div>

      {!isAdmin && (
        <Alert kind="info">
          Only an admin can change the schema. You can see how each attribute behaves here.
        </Alert>
      )}

      {(adding || editing) && (
        <Editor
          def={editing}
          objectType={objectType}
          states={states}
          dataTypes={dataTypes}
          available={available}
          busy={busy === "save"}
          onCancel={() => { setAdding(false); setEditing(null); }}
          onSave={(d) => save(d, editing?.id)}
        />
      )}

      {loading ? (
        <div className="card" style={{ padding: 40, textAlign: "center" }}><Spinner size={20} /></div>
      ) : shown.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <p style={{ margin: "0 0 12px", color: "var(--text-muted)" }}>
            No attributes defined for this object type yet — nothing will be shown on a part, and
            nothing can be required to release.
          </p>
          {isAdmin && (
            <button className="btn btn-primary" onClick={seed} disabled={busy != null}>
              Add the starting schema
            </button>
          )}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Attribute</th>
                <th style={{ width: 90 }}>Type</th>
                <th style={{ width: 120 }}>Onshape</th>
                <th style={{ width: 150 }}>Direction</th>
                <th>Behaviour</th>
                <th style={{ width: 100 }} />
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      {d.label}
                      {d.system && (
                        <span className="badge" style={{ marginLeft: 6 }} title="Part of the base schema; the sync engine reads it by key">
                          base
                        </span>
                      )}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                      {d.key}{d.group ? ` · ${d.group}` : ""}
                    </div>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {d.dataType}
                    {d.unit ? <div style={{ color: "var(--text-faint)", fontSize: 11 }}>{d.unit}</div> : null}
                    {d.dataType === "ENUM" && (
                      <div style={{ color: "var(--text-faint)", fontSize: 11 }} title={d.enumValues.join(", ")}>
                        {d.enumValues.length} value{d.enumValues.length === 1 ? "" : "s"}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {d.onshapePropertyName ? (
                      <>
                        {d.onshapePropertyName}
                        {!d.onshapePropertyId && (
                          <div style={{ color: "var(--danger)", fontSize: 11 }} title="No property with that name was found on this tenant. Run discovery in Settings.">
                            not found
                          </div>
                        )}
                      </>
                    ) : (
                      <span style={{ color: "var(--text-faint)" }}>—</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {DIRECTION_LABEL[d.syncDirection]}
                    {d.syncDirection === "both" && (
                      <div style={{ color: "var(--text-faint)", fontSize: 11 }}>
                        {d.authority === "plm" ? "PLM" : "Onshape"} wins on conflict
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 11.5, display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {d.required && <span className="badge">required</span>}
                    {d.requiredForRelease && (
                      <span className="badge" style={{ background: "var(--warn-soft)", color: "var(--warn)", borderColor: "var(--warn)" }}>
                        required to release
                      </span>
                    )}
                    {d.frozenAtRelease && <span className="badge">frozen at release</span>}
                    {d.editableInStates.length > 0 && (
                      <span className="badge" title={`Editable only in: ${d.editableInStates.join(", ")}`}>
                        editable in {d.editableInStates.length} state
                        {d.editableInStates.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {!d.required && !d.requiredForRelease && !d.frozenAtRelease && !d.editableInStates.length && (
                      <span style={{ color: "var(--text-faint)" }}>no constraints</span>
                    )}
                  </td>
                  <td>
                    {isAdmin && (
                      <div style={{ display: "flex", gap: 5 }}>
                        <button
                          className="btn btn-sm"
                          onClick={() => { setEditing(d); setAdding(false); }}
                        >
                          Edit
                        </button>
                        {!d.system && (
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => remove(d)}
                            disabled={busy === d.id}
                          >
                            {busy === d.id ? <Spinner /> : "×"}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Editor({
  def, objectType, states, dataTypes, available, busy, onCancel, onSave,
}: {
  def: Def | null;
  objectType: "PART" | "DRAWING";
  states: string[];
  dataTypes: string[];
  available: { propertyId: string; name: string; valueType: string }[];
  busy: boolean;
  onCancel: () => void;
  onSave: (d: Partial<Def>) => void;
}) {
  const [f, setF] = useState<Partial<Def>>(
    def ?? {
      objectType,
      key: "",
      label: "",
      description: "",
      dataType: "STRING",
      enumValues: [],
      unit: "",
      required: false,
      requiredForRelease: false,
      editableInStates: [],
      frozenAtRelease: false,
      owner: "plm",
      onshapePropertyName: "",
      syncDirection: "none",
      authority: "onshape",
      order: 100,
      group: "",
    }
  );
  const set = (k: keyof Def, v: unknown) => setF((prev) => ({ ...prev, [k]: v }));

  return (
    <div className="card" style={{ display: "grid", gap: 12, borderColor: "var(--accent)" }}>
      <h2 style={{ margin: 0, fontSize: 15 }}>
        {def ? `Edit "${def.label}"` : `Add a ${objectType === "PART" ? "part" : "drawing"} attribute`}
      </h2>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        <Field label="Label">
          <input className="input" value={f.label ?? ""} onChange={(e) => set("label", e.target.value)} />
        </Field>
        <Field
          label="Key"
          hint={def ? "Cannot change — values are stored against it" : "lowerCamelCase, never renamed afterwards"}
        >
          <input
            className="input mono"
            value={f.key ?? ""}
            disabled={Boolean(def)}
            onChange={(e) => set("key", e.target.value)}
          />
        </Field>
        <Field label="Type">
          <select className="select" value={f.dataType} onChange={(e) => set("dataType", e.target.value)}>
            {dataTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Group" hint="Heading it appears under on a part">
          <input className="input" value={f.group ?? ""} onChange={(e) => set("group", e.target.value)} />
        </Field>
        {(f.dataType === "NUMBER" || f.dataType === "INTEGER") && (
          <Field label="Unit" hint="Display only">
            <input className="input" value={f.unit ?? ""} onChange={(e) => set("unit", e.target.value)} />
          </Field>
        )}
        <Field label="Order" hint="Lower numbers appear first">
          <input
            className="input"
            type="number"
            value={f.order ?? 100}
            onChange={(e) => set("order", Number(e.target.value))}
          />
        </Field>
      </div>

      {f.dataType === "ENUM" && (
        <Field label="Permitted values" hint="One per line. Removing one leaves existing values in place but they will no longer save.">
          <textarea
            className="input"
            rows={4}
            value={(f.enumValues ?? []).join("\n")}
            onChange={(e) => set("enumValues", e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))}
          />
        </Field>
      )}

      <Field label="Description" hint="Shown under the field on a part">
        <input className="input" value={f.description ?? ""} onChange={(e) => set("description", e.target.value)} />
      </Field>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "grid", gap: 12 }}>
        <strong style={{ fontSize: 13 }}>Behaviour</strong>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={Boolean(f.required)} onChange={(e) => set("required", e.target.checked)} />
            Always required
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={Boolean(f.requiredForRelease)}
              onChange={(e) => set("requiredForRelease", e.target.checked)}
            />
            Required to release
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={Boolean(f.frozenAtRelease)}
              onChange={(e) => set("frozenAtRelease", e.target.checked)}
            />
            Frozen once released
          </label>
        </div>
        <Field
          label="Editable only in these states"
          hint="Nothing selected means every state. This is process control; 'frozen once released' is a separate, stronger guarantee."
        >
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13 }}>
            {states.map((st) => (
              <label key={st} style={{ display: "flex", gap: 5, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={(f.editableInStates ?? []).includes(st)}
                  onChange={(e) =>
                    set(
                      "editableInStates",
                      e.target.checked
                        ? [...(f.editableInStates ?? []), st]
                        : (f.editableInStates ?? []).filter((x) => x !== st)
                    )
                  }
                />
                {st}
              </label>
            ))}
          </div>
        </Field>
      </div>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "grid", gap: 12 }}>
        <strong style={{ fontSize: 13 }}>Onshape mapping</strong>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
          <Field label="Authored by">
            <select className="select" value={f.owner} onChange={(e) => set("owner", e.target.value)}>
              <option value="onshape">Onshape — a CAD property</option>
              <option value="plm">PLM — its own data</option>
            </select>
          </Field>
          <Field label="Direction">
            <select
              className="select"
              value={f.syncDirection}
              onChange={(e) => set("syncDirection", e.target.value)}
            >
              <option value="none">PLM only, never touches Onshape</option>
              <option value="from-onshape">Read from Onshape</option>
              <option value="to-onshape">Written to Onshape</option>
              <option value="both">Both ways</option>
            </select>
          </Field>
          {f.syncDirection === "both" && (
            <Field label="Who wins on conflict" hint="Consulted when both sides changed since the last sync">
              <select className="select" value={f.authority} onChange={(e) => set("authority", e.target.value)}>
                <option value="onshape">Onshape</option>
                <option value="plm">PLM</option>
              </select>
            </Field>
          )}
          {f.syncDirection !== "none" && (
            <Field
              label="Onshape property"
              hint="Matched by name, because Onshape's property ids are per-tenant"
            >
              <input
                className="input"
                list="onshape-props"
                value={f.onshapePropertyName ?? ""}
                onChange={(e) => set("onshapePropertyName", e.target.value)}
              />
              <datalist id="onshape-props">
                {available.map((a) => (
                  <option key={a.propertyId} value={a.name}>{a.valueType}</option>
                ))}
              </datalist>
            </Field>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-primary" onClick={() => onSave(f)} disabled={busy}>
          {busy ? <Spinner /> : def ? "Save changes" : "Add attribute"}
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
