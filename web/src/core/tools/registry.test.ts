import { beforeEach, describe, expect, it } from 'vitest';
import { allTools, CHIPS, COMMON_TOOLS } from '../../data/chips';
import { CHIP_KEYS } from '../../types';
import { fakeCtx, resetAll } from '../testUtils';
import { liveTools, runTool, TOOLS, upperTypes } from './index';
import { registerTool } from './registry';

beforeEach(resetAll);

describe('registry', () => {
  it('her çipin tüm araçları kayıtlı', () => {
    const missing = CHIP_KEYS.flatMap((k) => allTools(k).filter((t) => !TOOLS.has(t)).map((t) => `${k}:${t}`));
    expect(missing).toEqual([]);
    expect(COMMON_TOOLS.every((t) => TOOLS.has(t))).toBe(true);
    expect(TOOLS.get('google_search')?.builtin).toBe(true);
  });

  it('yetkisiz araç reddedilir (çalıştırılmaz)', async () => {
    const r = await runTool('port_scan', { host: '127.0.0.1', ports: '80' }, fakeCtx('atlas'), allTools('atlas'));
    expect(r).toEqual({ error: "'port_scan' aracı bu çipin yetkisinde değil." });
    expect(await runTool('get_time', {}, fakeCtx('atlas'), allTools('atlas'))).toHaveProperty('result');
  });

  it('bilinmeyen, yerleşik ve hatalı araç {error} döner, asla fırlatmaz', async () => {
    expect(await runTool('yok', {}, fakeCtx(), ['yok'])).toHaveProperty('error');
    expect(await runTool('google_search', {}, fakeCtx(), ['google_search'])).toHaveProperty('error');
    registerTool({ name: '_patlayan', description: 'x', parameters: { type: 'object', properties: {} }, handler: () => { throw new Error('bam'); } });
    const r = await runTool('_patlayan', {}, fakeCtx(), ['_patlayan']);
    expect(r).toEqual({ error: '_patlayan başarısız: bam' });
    TOOLS.delete('_patlayan');
  });

  it('{error} ve {result} biçimleri korunur', async () => {
    registerTool({ name: '_e', description: 'x', parameters: { type: 'object', properties: {} }, handler: () => ({ error: 'şu' }) });
    registerTool({ name: '_r', description: 'x', parameters: { type: 'object', properties: {} }, handler: () => ({ result: 5 }) });
    registerTool({ name: '_n', description: 'x', parameters: { type: 'object', properties: {} }, handler: () => undefined });
    expect(await runTool('_e', {}, fakeCtx(), ['_e'])).toEqual({ error: 'şu' });
    expect(await runTool('_r', {}, fakeCtx(), ['_r'])).toEqual({ result: 5 });
    expect(await runTool('_n', {}, fakeCtx(), ['_n'])).toEqual({ result: 'tamam' });
    for (const n of ['_e', '_r', '_n']) TOOLS.delete(n);
  });

  it('upperTypes iç içe şemalarda tür adlarını büyütür', () => {
    expect(upperTypes({ type: 'object', properties: { a: { type: 'string', enum: ['x'] }, b: { type: 'array', items: { type: 'number' } } } }))
      .toEqual({ type: 'OBJECT', properties: { a: { type: 'STRING', enum: ['x'] }, b: { type: 'ARRAY', items: { type: 'NUMBER' } } } });
  });

  it('liveTools: yerleşik arama + tek işlev bildirimi listesi, şemalar büyük harf', () => {
    for (const k of CHIP_KEYS) {
      const tools = liveTools(allTools(k)) as Record<string, unknown>[];
      expect(tools[0]).toEqual({ googleSearch: {} });
      const decls = (tools[1] as { functionDeclarations: { name: string; description: string; parameters: { type: string } }[] }).functionDeclarations;
      expect(tools).toHaveLength(2);
      expect(decls.length).toBe(allTools(k).filter((t) => t !== 'google_search').length);
      expect(new Set(decls.map((d) => d.name)).size).toBe(decls.length);
      for (const d of decls) {
        expect(d.description.length).toBeGreaterThan(3);
        expect(d.parameters.type).toBe('OBJECT');
      }
    }
  });

  it('liveTools yalnızca istenen araçları verir', () => {
    const t = liveTools(['get_time']) as { functionDeclarations: { name: string }[] }[];
    expect(t).toHaveLength(1);
    expect(t[0].functionDeclarations.map((d) => d.name)).toEqual(['get_time']);
    expect(liveTools(['yok'])).toEqual([]);
  });

  it('OBSIDIAN yalnızca request_authority + ortak araçları görür', () => {
    expect(CHIPS.obsidian.tools).toEqual(['request_authority']);
    expect(allTools('obsidian')).not.toContain('run_command');
  });
});
