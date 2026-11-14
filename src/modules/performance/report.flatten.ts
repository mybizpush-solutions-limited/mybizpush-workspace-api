// Turns a report's JSON into tables for CSV, XLSX and PDF (API-CHANGES A504). Pure:
// it only reformats what the report service returned, so an export can't contain
// anything beyond what the viewer could open.

export interface Section {
  title: string;
  columns: string[];
  rows: Record<string, string>[];
}

const label = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(cell).join("; ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Keys that identify rather than inform, or that only the app can use.
const SKIP = new Set(["avatarUrl", "userId", "projectId", "productId", "departmentId", "headId", "id"]);

function tableFrom(title: string, rows: Record<string, unknown>[]): Section | null {
  if (!rows.length) return null;
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !SKIP.has(k));
  const columns = keys.map(label);
  return {
    title,
    columns,
    rows: rows.map((r) => Object.fromEntries(keys.map((k, i) => [columns[i]!, cell(r[k])]))),
  };
}

export function flatten(report: Record<string, unknown>, sections?: string[]): Section[] {
  const out: Section[] = [];
  const summary: Record<string, string>[] = [];
  const wanted = (key: string) => !sections?.length || sections.includes(key);

  for (const [key, value] of Object.entries(report)) {
    if (key === "range" || value === null || value === undefined || !wanted(key)) continue;
    if (Array.isArray(value)) {
      if (value.length && typeof value[0] === "object") {
        const t = tableFrom(label(key), value as Record<string, unknown>[]);
        if (t) out.push(t);
      } else {
        summary.push({ Section: label(key), Measure: "", Value: cell(value) });
      }
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SKIP.has(k)) continue;
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) summary.push({ Section: label(key), Measure: `${label(k)}: ${label(k2)}`, Value: cell(v2) });
        } else {
          summary.push({ Section: label(key), Measure: label(k), Value: cell(v) });
        }
      }
    } else {
      summary.push({ Section: "Report", Measure: label(key), Value: cell(value) });
    }
  }
  if (summary.length) out.unshift({ title: "Summary", columns: ["Section", "Measure", "Value"], rows: summary });
  return out;
}

export const rowCount = (sections: Section[]) => sections.reduce((n, s) => n + s.rows.length, 0);
