/**
 * The models Greg picks from when he delegates (D25). One list: a new model
 * is one line here. The page's picker, queue_add's `model` field and
 * config.json's `defaultModel` all read it. No Node imports: the page's
 * browser code imports this file too.
 */
export const MODELS = ["opus", "sonnet", "fable"] as const;
export type Model = (typeof MODELS)[number];

/** The model when neither the item nor config.json names one. Greg's normal. */
export const DEFAULT_MODEL: Model = "opus";

export function isModel(v: unknown): v is Model {
  return typeof v === "string" && (MODELS as readonly string[]).includes(v);
}

/**
 * Whether Go on a queue item carries a model choice: every proposal, and a
 * review whose filer named a model (its go starts an agent). Decisions and
 * blockers start nothing, so they get no picker.
 */
export function picksModel(item: { kind: string; model: string | null }): boolean {
  return item.kind === "proposal" || (item.kind === "review" && !!item.model);
}

/** "fable" → "Fable", for the page. */
export function modelLabel(m: string): string {
  return m.charAt(0).toUpperCase() + m.slice(1);
}
