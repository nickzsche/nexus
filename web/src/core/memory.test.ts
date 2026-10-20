import { beforeEach, describe, expect, it } from 'vitest';
import * as memory from './memory';
import { resetAll } from './testUtils';

beforeEach(resetAll);

describe('memory', () => {
  it('ekler, aynı bilgiyi iki kez yazmaz, boş kaydı reddeder', () => {
    memory.add('Adı Sahan');
    memory.add('adı sahan');
    expect(memory.items()).toEqual(['Adı Sahan']);
    expect(() => memory.add('   ')).toThrow();
  });

  it('çipe özel ve ortak hafıza ayrı; promptBlock ikisini yazar', () => {
    memory.add('Kahve sever');
    memory.add('Nota ilgi duyar', 'nova');
    expect(memory.items('nova')).toEqual(['Nota ilgi duyar']);
    const b = memory.promptBlock('nova');
    expect(b).toContain('Kahve sever');
    expect(b).toContain('Nota ilgi duyar');
    expect(memory.promptBlock('forge')).not.toContain('Nota ilgi duyar');
  });

  it('remove eşleşenleri siler ve sayıyı döner', () => {
    memory.add('Kedisi var'); memory.add('Köpeği yok', 'forge');
    expect(memory.remove('kedi')).toBe(1);
    expect(memory.remove('yok')).toBe(1);
    expect(memory.remove('')).toBe(0);
    expect(memory.items()).toEqual([]);
  });

  it('kalıcı ve boş durumda promptBlock boş', () => {
    expect(memory.promptBlock('atlas')).toBe('');
    memory.add('x1');
    expect(JSON.parse(localStorage.getItem('nexus.memory')!).shared[0].text).toBe('x1');
  });
});
