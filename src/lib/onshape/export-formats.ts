/**
 * Formats a part can be exported in.
 *
 * Two mechanisms sit behind these. A few formats Onshape serves straight off a
 * part with a single GET; the rest go through the translation service, which is
 * an asynchronous job — submit, poll, then collect the result. The catalogue
 * records which applies so callers do not have to know.
 *
 * Kept deliberately short. A list of twenty formats is a worse answer than five
 * that people actually send to a machine shop.
 */
export type ExportFormat = {
  id: string;
  label: string;
  /** What the shop would use it for; shown beside the option. */
  purpose: string;
  extension: string;
  contentType: string;
  /** "direct" is one GET; "translation" submits a job and polls for it. */
  strategy: "direct" | "translation";
  /** Path segment under /parts/.../partid/{pid}/ for a direct download. */
  directPath?: string;
  /** Onshape's name for the format when requesting a translation. */
  formatName?: string;
};

export const EXPORT_FORMATS: ExportFormat[] = [
  {
    id: "STEP",
    label: "STEP",
    purpose: "The usual choice for sending a part out to be made",
    extension: "step",
    contentType: "application/step",
    strategy: "translation",
    formatName: "STEP",
  },
  {
    id: "PARASOLID",
    label: "Parasolid",
    purpose: "Exact solid geometry, for CAM and downstream CAD",
    extension: "x_t",
    contentType: "application/octet-stream",
    strategy: "direct",
    directPath: "parasolid",
  },
  {
    id: "IGES",
    label: "IGES",
    purpose: "Older interchange format, still asked for by some suppliers",
    extension: "igs",
    contentType: "application/iges",
    strategy: "translation",
    formatName: "IGES",
  },
  {
    id: "STL",
    label: "STL",
    purpose: "Mesh, for 3D printing and quick visual checks",
    extension: "stl",
    contentType: "model/stl",
    strategy: "direct",
    directPath: "stl",
  },
  {
    id: "3MF",
    label: "3MF",
    purpose: "Modern print format, keeps units and colour",
    extension: "3mf",
    contentType: "model/3mf",
    strategy: "translation",
    formatName: "3MF",
  },
];

export function findFormat(id: string): ExportFormat | undefined {
  return EXPORT_FORMATS.find((f) => f.id === String(id ?? "").toUpperCase());
}

/**
 * A filename someone can find again on a shared drive.
 *
 * The PLM number leads, because PLM is the number master and that is the
 * identifier both a supplier quote and this system work from. The revision
 * follows it: a released export without its revision in the name is the file
 * that gets built to after it has been superseded.
 */
export function exportFilename(
  part: { number?: string | null; name?: string | null; revision?: string | null },
  format: ExportFormat
): string {
  const safe = (v: unknown) =>
    String(v ?? "")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);

  const segments = [
    safe(part.number) || safe(part.name) || "part",
    part.revision ? `Rev${safe(part.revision)}` : "",
  ].filter(Boolean);

  return `${segments.join("_")}.${format.extension}`;
}
