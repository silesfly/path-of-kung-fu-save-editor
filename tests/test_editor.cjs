'use strict';

const assert = require('node:assert');
const zlib = require('node:zlib');

const codec = require('../src/pokf-codec.js');
const editorCore = require('../src/editor-core.js');
const catalogModule = require('../src/catalog-data.js');

const PokfCatalogData = catalogModule.PokfCatalogData || catalogModule;

const {
  SAVE_KEY_PREFIX,
  write7BitInt,
  read7BitInt,
  decodeSaveBytes,
  encodeSaveBytes,
} = codec;

const {
  createSampleSave,
  makeDemoSave,
  applyScalarPatch,
  validateSave,
  upsertItem,
  removeItem,
  addEquip,
  updateEquip,
  removeEquip,
  toggleIdInList,
  unlockAllMeridians,
  addWuxue,
  removeWuxue,
  upsertSorcery,
  removeSorcery,
  applyPreset,
} = editorCore;

const HANZI_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const KANA_RE = /[\u3040-\u30ff]/;
const RICH_TEXT_RE = /<\/?color|<size|<b|<i/i;

function readVarintNormalized(buf, offset) {
  const res = read7BitInt(buf, offset);
  if (typeof res === 'number') {
    return { value: res, next: offset + write7BitInt(res).length };
  }
  if (Array.isArray(res)) {
    return { value: res[0], next: res[1] };
  }
  if (res && typeof res === 'object') {
    if ('value' in res && 'next' in res) return { value: res.value, next: res.next };
    if ('value' in res && 'offset' in res) return { value: res.value, next: res.offset };
    if ('value' in res && 'bytesRead' in res) {
      return { value: res.value, next: offset + res.bytesRead };
    }
  }
  throw new Error('Unsupported read7BitInt return shape: ' + JSON.stringify(res));
}

function concatUint8(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function utf8(str) {
  return Buffer.from(str, 'utf8');
}

function collectStrings(value, out) {
  if (value == null) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      collectStrings(k, out);
      collectStrings(value[k], out);
    }
  }
}

async function main() {
  let pass = 0;
  let fail = 0;
  const failures = [];

  function ok(name, fn) {
    try {
      fn();
      pass++;
    } catch (err) {
      fail++;
      failures.push({ name, err });
    }
  }

  async function okAsync(name, fn) {
    try {
      await fn();
      pass++;
    } catch (err) {
      fail++;
      failures.push({ name, err });
    }
  }

  ok('SAVE_KEY_PREFIX is correct', () => {
    assert.strictEqual(SAVE_KEY_PREFIX, 'KeyPlayerDatammjh2023');
  });

  ok('write7BitInt produces Uint8Array/Buffer', () => {
    const v = write7BitInt(0);
    assert.ok(v instanceof Uint8Array || Buffer.isBuffer(v));
  });

  ok('write7BitInt/read7BitInt round-trip LEB128 values', () => {
    const values = [0, 1, 2, 127, 128, 129, 255, 300, 16383, 16384, 100000, 0x7fffffff];
    for (const n of values) {
      const buf = write7BitInt(n);
      const { value, next } = readVarintNormalized(buf, 0);
      assert.strictEqual(value, n, `value mismatch for ${n}`);
      assert.strictEqual(next, buf.length, `next offset mismatch for ${n}`);
    }
  });

  ok('read7BitInt reads from non-zero offset', () => {
    const prefix = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const enc = write7BitInt(512);
    const buf = concatUint8([prefix, enc]);
    const { value, next } = readVarintNormalized(buf, 3);
    assert.strictEqual(value, 512);
    assert.strictEqual(next, buf.length);
  });

  await okAsync('encodeSaveBytes + decodeSaveBytes round-trip (binary, slotId)', async () => {
    const save = createSampleSave();
    const encoded = await encodeSaveBytes(save, { containerKind: 'save-binary', slotId: '1' });
    assert.ok(encoded instanceof Uint8Array);

    const { value: keyLen, next: afterKeyLen } = readVarintNormalized(encoded, 0);
    const keyStr = Buffer.from(encoded.slice(afterKeyLen, afterKeyLen + keyLen)).toString('utf8');
    assert.strictEqual(keyStr, SAVE_KEY_PREFIX + '1');

    const { value: compLen, next: afterCompLen } = readVarintNormalized(encoded, afterKeyLen + keyLen);
    const compBytes = encoded.slice(afterCompLen, afterCompLen + compLen);
    assert.strictEqual(compBytes.length, compLen);

    const inflated = zlib.inflateRawSync(Buffer.from(compBytes));
    const json = JSON.parse(inflated.toString('utf8'));
    assert.ok(json && typeof json === 'object');

    const decoded = await decodeSaveBytes(encoded, {});
    assert.ok(decoded && typeof decoded === 'object');
    assert.ok(decoded.root && typeof decoded.root === 'object');
    assert.ok(decoded.meta && typeof decoded.meta === 'object');
    assert.strictEqual(decoded.meta.containerKind, 'save-binary');
  });

  await okAsync('encodeSaveBytes with explicit saveKey produces correct header', async () => {
    const save = createSampleSave();
    const encoded = await encodeSaveBytes(save, {
      containerKind: 'save-binary',
      saveKey: 'KeyPlayerDatammjh20231',
    });
    const { value: keyLen, next: afterKeyLen } = readVarintNormalized(encoded, 0);
    const keyStr = Buffer.from(encoded.slice(afterKeyLen, afterKeyLen + keyLen)).toString('utf8');
    assert.strictEqual(keyStr, 'KeyPlayerDatammjh20231');

    const { value: compLen, next: afterCompLen } = readVarintNormalized(encoded, afterKeyLen + keyLen);
    const compBytes = encoded.slice(afterCompLen, afterCompLen + compLen);
    const inflated = zlib.inflateRawSync(Buffer.from(compBytes));
    assert.ok(inflated.length > 0);
  });

  await okAsync('decodeSaveBytes handles plain JSON payload', async () => {
    const save = createSampleSave();
    const json = utf8(JSON.stringify(save));
    const decoded = await decodeSaveBytes(json, {});
    assert.ok(decoded.root && typeof decoded.root === 'object');
    assert.ok('firstName' in decoded.root || 'sliver' in decoded.root || 'gold' in decoded.root);
  });

  await okAsync('decodeSaveBytes supports UTF-16LE fallback payload', async () => {
    const save = createSampleSave();
    const utf16 = Buffer.from(JSON.stringify(save), 'utf16le');
    const keyBuf = utf8(SAVE_KEY_PREFIX + '1');
    const compressed = zlib.deflateRawSync(Buffer.from(utf16));
    const bytes = concatUint8([
      write7BitInt(keyBuf.length),
      keyBuf,
      write7BitInt(compressed.length),
      compressed,
    ]);
    const decoded = await decodeSaveBytes(bytes, {});
    assert.ok(decoded.root && typeof decoded.root === 'object');
    assert.strictEqual(decoded.root.sliver, save.sliver);
  });

  await okAsync('decodeSaveBytes rejects truncated save', async () => {
    const save = createSampleSave();
    const encoded = await encodeSaveBytes(save, { containerKind: 'save-binary', slotId: '1' });
    const truncated = encoded.slice(0, Math.max(1, encoded.length - 10));
    await assert.rejects(() => decodeSaveBytes(truncated, {}));
  });

  await okAsync('decodeSaveBytes rejects trailing bytes after deflate stream', async () => {
    const save = createSampleSave();
    const encoded = await encodeSaveBytes(save, { containerKind: 'save-binary', slotId: '1' });
    const withTrailing = concatUint8([encoded, new Uint8Array([0x00, 0x01, 0x02, 0x03])]);
    await assert.rejects(() => decodeSaveBytes(withTrailing, {}));
  });

  await okAsync('decodeSaveBytes rejects wrong key prefix', async () => {
    const payload = utf8(JSON.stringify(createSampleSave()));
    const badKey = utf8('WrongKeyPrefix0000000000000000000000');
    const compressed = zlib.deflateRawSync(payload);
    const bytes = concatUint8([
      write7BitInt(badKey.length),
      badKey,
      write7BitInt(compressed.length),
      compressed,
    ]);
    await assert.rejects(() => decodeSaveBytes(bytes, {}));
  });

  await okAsync('decodeSaveBytes rejects oversize/corrupt deflate', async () => {
    const keyBuf = utf8(SAVE_KEY_PREFIX + '1');
    const bogus = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const bytes = concatUint8([
      write7BitInt(keyBuf.length),
      keyBuf,
      write7BitInt(bogus.length),
      bogus,
    ]);
    await assert.rejects(() => decodeSaveBytes(bytes, {}));
  });

  for (const [name, factory] of [
    ['createSampleSave', createSampleSave],
    ['makeDemoSave', makeDemoSave],
  ]) {
    ok(`${name} returns direct PlayerData root`, () => {
      const save = factory();
      assert.ok(save && typeof save === 'object');
      assert.strictEqual(save.PlayerData, undefined, 'must not be wrapped in .PlayerData');
      assert.strictEqual(typeof save.m_allSkillList, 'object');
      assert.ok(!Array.isArray(save.m_allSkillList));
      for (const key of [
        'm_myTfList',
        'acupointDataList',
        'acupointJlDataList',
        'm_allXinJue',
        'm_allMinJuan',
      ]) {
        assert.ok(Array.isArray(save[key]), `${key} must be an array`);
      }
      assert.ok(Array.isArray(save.listMyItemData));
      assert.ok(save.listMyItemData.length >= 1);
      for (const it of save.listMyItemData) {
        assert.ok('_guid' in it && 'itemId' in it && 'count' in it);
      }
      assert.ok(Array.isArray(save.listMyEuipData));
      for (const eq of save.listMyEuipData) {
        for (const k of ['guid', 'quipId', '_quipTypeId', 'quality', 'wearId', 'IsLock']) {
          assert.ok(k in eq, `equipment entry missing ${k}`);
        }
      }
    });

    ok(`${name} attribute in 1..10 and gameLv in 0..2`, () => {
      const save = factory();
      assert.ok(Number.isInteger(save.attribute) && save.attribute >= 1 && save.attribute <= 10);
      assert.ok(Number.isInteger(save.gameLv) && save.gameLv >= 0 && save.gameLv <= 2);
    });
  }

  ok('applyScalarPatch accepts valid scalar patch', () => {
    const save = createSampleSave();
    applyScalarPatch(save, { firstName: '영웅', sliver: 999, gold: 12345, attribute: 5, gameLv: 2 });
    assert.strictEqual(save.firstName, '영웅');
    assert.strictEqual(save.sliver, 999);
    assert.strictEqual(save.gold, 12345);
    assert.strictEqual(save.attribute, 5);
    assert.strictEqual(save.gameLv, 2);
  });

  for (const [label, patch] of [
    ['negative sliver', { sliver: -1 }],
    ['negative gold', { gold: -5 }],
    ['attribute 0', { attribute: 0 }],
    ['attribute 11', { attribute: 11 }],
    ['gameLv 3', { gameLv: 3 }],
  ]) {
    ok(`applyScalarPatch throws on ${label}`, () => {
      const save = createSampleSave();
      assert.throws(() => applyScalarPatch(save, patch), /./);
    });
  }

  ok('validateSave clean sample -> ok true, no errors', () => {
    const save = createSampleSave();
    const res = validateSave(save);
    assert.ok(res && typeof res === 'object');
    for (const k of ['valid', 'ok', 'errors', 'warnings', 'issues']) {
      assert.ok(k in res, `missing ${k}`);
    }
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.errors.length, 0);
    assert.strictEqual(res.valid, true);
  });

  ok('validateSave negative sliver / invalid attribute -> ok false', () => {
    const s1 = createSampleSave();
    s1.sliver = -50;
    const r1 = validateSave(s1);
    assert.strictEqual(r1.ok, false);
    assert.ok(r1.errors.length > 0);

    const s2 = createSampleSave();
    s2.attribute = 99;
    const r2 = validateSave(s2);
    assert.strictEqual(r2.ok, false);
    assert.ok(r2.errors.length > 0);
  });

  ok('upsertItem and removeItem manage listMyItemData', () => {
    const save = createSampleSave();
    const before = save.listMyItemData.length;
    upsertItem(save, 901002, 3, false);
    assert.strictEqual(save.listMyItemData.length, before + 1);
    const found = save.listMyItemData.find((it) => Number(it.itemId) === 901002);
    assert.ok(found && found._guid);
    assert.strictEqual(found.count, 3);

    upsertItem(save, 901002, 7, false);
    assert.strictEqual(save.listMyItemData.length, before + 1);
    assert.strictEqual(save.listMyItemData.find((it) => Number(it.itemId) === 901002).count, 7);

    removeItem(save, found._guid);
    assert.ok(!save.listMyItemData.find((it) => Number(it.itemId) === 901002));
  });

  ok('addEquip/updateEquip/removeEquip manage listMyEuipData', () => {
    const save = createSampleSave();
    const start = save.listMyEuipData.length;
    const eq = addEquip(save, 102003, { _quipTypeId: 0, quality: 3, wearId: 0, IsLock: 0 });
    assert.strictEqual(save.listMyEuipData.length, start + 1);
    assert.ok(eq && eq.guid);

    updateEquip(save, eq.guid, { quality: 5, IsLock: 1 });
    const updated = save.listMyEuipData.find((e) => e.guid === eq.guid);
    assert.strictEqual(updated.quality, 5);
    assert.strictEqual(updated.IsLock, 1);

    removeEquip(save, eq.guid);
    assert.strictEqual(save.listMyEuipData.length, start);
  });

  ok('toggleIdInList toggles numeric ID in PlayerData arrays', () => {
    const save = createSampleSave();
    const beforeLen = save.acupointDataList.length;
    const res1 = toggleIdInList(save, 'acupointDataList', 10101);
    assert.strictEqual(res1.present, true);
    assert.strictEqual(save.acupointDataList.length, beforeLen + 1);
    const res2 = toggleIdInList(save, 'acupointDataList', 10101);
    assert.strictEqual(res2.present, false);
    assert.strictEqual(save.acupointDataList.length, beforeLen);
  });

  ok('unlockAllMeridians populates acupoints and collaterals', () => {
    const save = createSampleSave();
    unlockAllMeridians(save, PokfCatalogData);
    assert.strictEqual(save.acupointDataList.length, PokfCatalogData.acupoints.length);
    assert.strictEqual(save.acupointJlDataList.length, PokfCatalogData.collaterals.length);
  });

  ok('addWuxue / removeWuxue manage m_allSkillList dict', () => {
    const save = createSampleSave();
    addWuxue(save, 101001, ['1010101_1', '1010102']);
    assert.ok(Array.isArray(save.m_allSkillList['101001']));
    assert.ok(save.m_allSkillList['101001'].includes('1010101_1'));
    removeWuxue(save, 101001);
    assert.strictEqual(save.m_allSkillList['101001'], undefined);
  });

  ok('upsertSorcery / removeSorcery manage listMySorcery', () => {
    const save = createSampleSave();
    upsertSorcery(save, 110, 1);
    assert.ok(save.listMySorcery.some((s) => s.id === 110 && s.wear === 1));
    removeSorcery(save, 110);
    assert.ok(!save.listMySorcery.some((s) => s.id === 110));
  });

  for (const preset of ['wealth', 'cultivation', 'meridians', 'recovery', 'clean_record', 'starter_supply']) {
    ok(`applyPreset('${preset}') passes validation`, () => {
      const save = createSampleSave();
      const target = applyPreset(save, preset, PokfCatalogData);
      const res = validateSave(target);
      assert.strictEqual(res.ok, true, JSON.stringify(res.errors));
    });
  }

  ok('catalog cardinalities', () => {
    assert.strictEqual(PokfCatalogData.realms.length, 10);
    assert.strictEqual(PokfCatalogData.difficulties.length, 3);
    assert.strictEqual(PokfCatalogData.equipSlots.length, 7);
    assert.ok(PokfCatalogData.items.length > 2000);
    assert.ok(PokfCatalogData.martialGroups.length >= 100);
    assert.ok(PokfCatalogData.acupoints.length > 50);
    assert.ok(PokfCatalogData.collaterals.length >= 20);
    assert.ok(PokfCatalogData.inborn.length >= 20);
  });

  ok('catalog contains no Hanzi, Kana, or rich-text tags', () => {
    const strings = [];
    collectStrings(PokfCatalogData, strings);
    const bad = [];
    for (const s of strings) {
      if (HANZI_RE.test(s)) bad.push({ type: 'hanzi', value: s });
      if (KANA_RE.test(s)) bad.push({ type: 'kana', value: s });
      if (RICH_TEXT_RE.test(s)) bad.push({ type: 'rich-text', value: s });
    }
    assert.strictEqual(bad.length, 0, JSON.stringify(bad.slice(0, 5)));
  });

  for (const { name, err } of failures) {
    console.error(`\nFAIL: ${name}\n${err && err.stack ? err.stack : err}`);
  }
  console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total)`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal test runner error:', err && err.stack ? err.stack : err);
  process.exit(1);
});
