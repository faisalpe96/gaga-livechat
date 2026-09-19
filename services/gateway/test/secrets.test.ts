import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { requireSecret, MIN_SECRET_LENGTH, generateSecret } from '../src/secrets.js';

const silent = { warn: () => {} };
const strong = 'a'.repeat(MIN_SECRET_LENGTH);

describe('requireSecret — mode produksi', () => {
  const prod = (extra: Record<string, string>) => ({ NODE_ENV: 'production', ...extra });

  test('variabel kosong → throw menyebut nama variabel', () => {
    assert.throws(() => requireSecret('COOKIE_SECRET', { env: prod({}), logger: silent }), /COOKIE_SECRET tidak di-set/);
  });

  test('terlalu pendek → throw', () => {
    assert.throws(
      () => requireSecret('COOKIE_SECRET', { env: prod({ COOKIE_SECRET: 'pendek123' }), logger: silent }),
      /terlalu pendek/
    );
  });

  test('cukup panjang → dikembalikan apa adanya', () => {
    assert.equal(requireSecret('COOKIE_SECRET', { env: prod({ COOKIE_SECRET: strong }), logger: silent }), strong);
  });
});

describe('requireSecret — mode dev/test', () => {
  test('variabel kosong → nilai acak + warning, tidak throw', () => {
    let warned = '';
    const v = requireSecret('COOKIE_SECRET', { env: { NODE_ENV: 'test' }, logger: { warn: (m: string) => (warned = m) } });
    assert.ok(v.length >= MIN_SECRET_LENGTH);
    assert.match(warned, /COOKIE_SECRET tidak di-set/);
  });

  test('nilai acak berbeda tiap pemanggilan', () => {
    assert.notEqual(generateSecret(), generateSecret());
  });

  test('nilai pendek diterima dengan warning', () => {
    let warned = '';
    const v = requireSecret('X', { env: { X: 'pendek' }, logger: { warn: (m: string) => (warned = m) } });
    assert.equal(v, 'pendek');
    assert.match(warned, /hanya 6 karakter/);
  });
});

describe('requireSecret — default lama yang bocor ditolak di semua mode', () => {
  for (const mode of ['production', 'development', 'test']) {
    test(`NODE_ENV=${mode}`, () => {
      assert.throws(
        () =>
          requireSecret('COOKIE_SECRET', {
            env: { NODE_ENV: mode, COOKIE_SECRET: 'gaga-livechat-production-cookie-secret-2026' },
            logger: silent,
          }),
        /default lama/
      );
      assert.throws(
        () =>
          requireSecret('ATTACHMENT_SIGNING_SECRET', {
            env: { NODE_ENV: mode, ATTACHMENT_SIGNING_SECRET: 'gaga-livechat-secure-signing-secret-2026' },
            logger: silent,
          }),
        /default lama/
      );
    });
  }
});
