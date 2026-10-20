/**
 * Araç kaydı. Bir araç bir kez tanımlanır; çipe göre izin süzgeci `allowed` ile uygulanır.
 * Araç hatası modele {error} olarak döner, uygulamayı düşürmez.
 */
import type { ChipKey, SystemBridge } from '../../types';

export interface ToolContext {
  chip: ChipKey;
  confirm(title: string, detail?: string, timeoutSec?: number): Promise<boolean>;
  sendImage(jpegBase64: string, note?: string): void;
  handoff(to: ChipKey, task: string): string;
  debate(a: ChipKey, b: ChipKey, topic: string): string;
  bridge: SystemBridge;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;               // JSON Schema nesnesi
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> | unknown;
  builtin?: boolean;                                  // Gemini yerleşik aracı (google_search)
}

export const TOOLS = new Map<string, ToolSpec>();
export const OBJ = { type: 'object', properties: {} } as const;

export function registerTool(spec: ToolSpec): void {
  TOOLS.set(spec.name, spec);
}

/** Gemini şemasında tür adları büyük harf (object → OBJECT); iç içe tüm şemalara uygulanır. */
export function upperTypes<T>(node: T): T {
  if (Array.isArray(node)) return node.map(upperTypes) as unknown as T;
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) =>
        [k, k === 'type' && typeof v === 'string' ? v.toUpperCase() : upperTypes(v)]),
    ) as T;
  }
  return node;
}

/** Live `tools` dizisi: yerleşik arama + tek işlev bildirimi listesi. */
export function liveTools(names: string[]): object[] {
  const out: object[] = [];
  const decls: object[] = [];
  for (const n of names) {
    const t = TOOLS.get(n);
    if (!t) continue;
    if (t.builtin) { if (n === 'google_search') out.push({ googleSearch: {} }); continue; }
    decls.push({ name: t.name, description: t.description, parameters: upperTypes(t.parameters) });
  }
  if (decls.length) out.push({ functionDeclarations: decls });
  return out;
}

export type ToolResult = { result: unknown } | { error: string };

/** Aracı çalıştırır. Yetkisiz, bilinmeyen ya da hatalı çağrı {error} döner; asla fırlatmaz. */
export async function runTool(
  name: string, args: Record<string, unknown> | undefined, ctx: ToolContext, allowed: string[],
): Promise<ToolResult> {
  if (!allowed.includes(name)) return { error: `'${name}' aracı bu çipin yetkisinde değil.` };
  const spec = TOOLS.get(name);
  if (!spec || spec.builtin) return { error: `'${name}' aracı kullanılamıyor.` };
  try {
    const r = await spec.handler({ ...(args ?? {}) }, ctx);
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const o = r as Record<string, unknown>;
      if (typeof o.error === 'string') return { error: o.error };
      if ('result' in o) return { result: o.result };
    }
    return { result: r ?? 'tamam' };
  } catch (e) {
    return { error: `${name} başarısız: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export const str = (a: Record<string, unknown>, k: string, d = ''): string => {
  const v = a[k];
  return typeof v === 'string' ? v.trim() : v == null ? d : String(v).trim();
};
export const num = (a: Record<string, unknown>, k: string, d = 0): number => {
  const v = Number(a[k]);
  return Number.isFinite(v) ? v : d;
};

export const prop = (type: string, description: string, extra: Record<string, unknown> = {}) => ({ type, description, ...extra });
export const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
