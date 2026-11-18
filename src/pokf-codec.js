/* src/pokf-codec.js — Path of Kung Fu save codec (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokfCodec = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SAVE_KEY_PREFIX = 'KeyPlayerDatammjh2023';
  const SAVE_KEY_RE = /^KeyPlayerDatammjh2023(\d+)$/;
  const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
  const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;

  function fail(message) { throw new Error(message); }

  function toU8(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    fail('입력이 Uint8Array가 아닙니다.');
  }

  function concatBytes(chunks, total) {
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function utf8Encode(text) {
    return new TextEncoder().encode(text);
  }

  function utf8Decode(bytes, fatal) {
    return new TextDecoder('utf-8', { fatal: !!fatal }).decode(bytes);
  }

  function utf16leDecode(bytes) {
    return new TextDecoder('utf-16le').decode(bytes);
  }

  function hasUtf8Bom(bytes) {
    return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  }

  function isPlainJson(bytes) {
    if (bytes.length === 0) return false;
    if (bytes[0] === 0x7b) return true;
    return hasUtf8Bom(bytes) && bytes.length > 3 && bytes[3] === 0x7b;
  }

  function read7BitInt(u8, offset) {
    u8 = toU8(u8);
    offset = offset == null ? 0 : offset;
    let value = 0;
    let shift = 0;
    let pos = offset;
    for (let i = 0; i < 5; i++) {
      if (pos >= u8.length) fail('7비트 정수 데이터가 잘렸습니다.');
      const b = u8[pos++];
      value += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) {
        if (value > 0x7fffffff) fail('7비트 정수가 너무 큽니다.');
        return { value, offset: pos };
      }
      shift += 7;
    }
    fail('7비트 정수가 너무 큽니다.');
  }

  function write7BitInt(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
      fail('7비트 정수 값이 올바르지 않습니다.');
    }
    const out = [];
    let v = value;
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return new Uint8Array(out);
  }

  function inspectBinaryHeader(bytes) {
    try {
      const u8 = toU8(bytes);
      const keyLen = read7BitInt(u8, 0);
      if (keyLen.value <= 0) return { ok: false, reason: '세이브 키 길이가 올바르지 않습니다.' };
      const keyStart = keyLen.offset;
      const keyEnd = keyStart + keyLen.value;
      if (keyEnd > u8.length) return { ok: false, reason: '세이브 키 데이터가 잘렸습니다.' };
      const saveKey = utf8Decode(u8.subarray(keyStart, keyEnd), true);
      if (!SAVE_KEY_RE.test(saveKey)) return { ok: false, reason: '세이브 키가 올바르지 않습니다.' };
      const lenInfo = read7BitInt(u8, keyEnd);
      const compLen = lenInfo.value;
      if (compLen <= 0 || compLen > MAX_COMPRESSED_BYTES) {
        return { ok: false, reason: '압축 데이터 길이가 올바르지 않습니다.' };
      }
      const dataOffset = lenInfo.offset;
      if (dataOffset + compLen !== u8.length) {
        return { ok: false, reason: '압축 데이터 길이가 파일 크기와 다릅니다.' };
      }
      return {
        ok: true,
        saveKey,
        slotId: SAVE_KEY_RE.exec(saveKey)[1],
        compLen,
        dataOffset,
        totalLength: u8.length
      };
    } catch (err) {
      return { ok: false, reason: err && err.message ? err.message : '세이브 헤더를 읽을 수 없습니다.' };
    }
  }

  function getNodeZlib() {
    if (typeof require !== 'function') return null;
    try { return require('node:zlib'); } catch (_) { return null; }
  }

  async function deflateRaw(u8) {
    const zlib = getNodeZlib();
    if (zlib && typeof zlib.deflateRawSync === 'function') {
      const buf = zlib.deflateRawSync(u8);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    if (typeof CompressionStream !== 'function') fail('압축을 지원하지 않는 환경입니다.');
    try {
      const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) {
      fail('압축에 실패했습니다.');
    }
  }

  async function inflateRaw(u8, maxOutputLength) {
    const limit = maxOutputLength || MAX_DECOMPRESSED_BYTES;
    const zlib = getNodeZlib();
    if (zlib && typeof zlib.inflateRawSync === 'function') {
      try {
        const buf = zlib.inflateRawSync(u8, { maxOutputLength: limit });
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch (err) {
        if (err && /maxOutputLength|buffer/i.test(String(err.message))) {
          fail('압축 해제 결과가 너무 큽니다.');
        }
        fail('압축 해제에 실패했습니다.');
      }
    }
    if (typeof DecompressionStream !== 'function') fail('압축 해제를 지원하지 않는 환경입니다.');
    let reader = null;
    try {
      const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      reader = stream.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          try { await reader.cancel(); } catch (_) {}
          fail('압축 해제 결과가 너무 큽니다.');
        }
        chunks.push(value);
      }
      return concatBytes(chunks, total);
    } catch (err) {
      if (err && err.message === '압축 해제 결과가 너무 큽니다.') throw err;
      fail('압축 해제에 실패했습니다.');
    } finally {
      if (reader) { try { reader.releaseLock(); } catch (_) {} }
    }
  }

  function detectFormat(text) {
    const indentMatch = /\r?\n([ \t]+)\S/.exec(text);
    let indent = '';
    if (indentMatch) {
      indent = /^\t+$/.test(indentMatch[1]) ? '\t' : indentMatch[1];
    } else if (!/\r?\n/.test(text)) {
      indent = '';
    }
    const hasCrLf = text.indexOf('\r\n') !== -1;
    return {
      eol: hasCrLf ? '\r\n' : '\n',
      indent,
      trailingNewline: /(?:\r?\n)$/.test(text)
    };
  }

  function parsePlayerDataJson(rawText) {
    if (typeof rawText !== 'string') fail('JSON 텍스트가 올바르지 않습니다.');
    const hasBom = rawText.charCodeAt(0) === 0xfeff;
    const text = hasBom ? rawText.slice(1) : rawText;
    let root;
    try { root = JSON.parse(text); } catch (_) { fail('JSON 텍스트가 올바르지 않습니다.'); }
    const fmt = detectFormat(text);
    return {
      root,
      meta: {
        containerKind: 'json',
        hasBom,
        eol: fmt.eol,
        indent: fmt.indent,
        trailingNewline: fmt.trailingNewline,
        slotId: null,
        saveKey: null
      }
    };
  }

  function serializePlayerDataJson(root, meta) {
    const m = meta || {};
    const indent = typeof m.indent === 'string' ? m.indent : (m.indent === undefined ? '' : String(m.indent));
    let text;
    try { text = JSON.stringify(root, null, indent); } catch (_) { fail('JSON 직렬화에 실패했습니다.'); }
    if (text === undefined) fail('JSON 직렬화에 실패했습니다.');
    const eol = m.eol === '\r\n' ? '\r\n' : '\n';
    if (eol === '\r\n') text = text.replace(/\n/g, '\r\n');
    if (m.trailingNewline) text += eol;
    if (m.hasBom) text = '\ufeff' + text;
    return text;
  }

  async function decodeSaveBytes(bytes, opts) {
    const options = opts || {};
    const u8 = toU8(bytes);
    const maxOutput = options.maxOutputLength || MAX_DECOMPRESSED_BYTES;

    if (isPlainJson(u8)) {
      const hasBom = hasUtf8Bom(u8);
      let text;
      try { text = utf8Decode(u8, true); } catch (_) { fail('JSON 텍스트를 읽을 수 없습니다.'); }
      const parsed = parsePlayerDataJson(text);
      parsed.meta.hasBom = hasBom;
      return parsed;
    }

    const header = inspectBinaryHeader(u8);
    if (!header.ok) fail(header.reason);

    const compressed = u8.subarray(header.dataOffset);
    const payload = await inflateRaw(compressed, maxOutput);
    if (payload.length > maxOutput) fail('압축 해제 결과가 너무 큽니다.');

    let text = null;
    let encoding = 'utf-8';
    const hasBom = hasUtf8Bom(payload);
    try {
      const candidate = utf8Decode(payload, true);
      JSON.parse(hasBom ? candidate.replace(/^\ufeff/, '') : candidate);
      text = candidate;
    } catch (_) {
      try {
        const candidate = utf16leDecode(payload);
        JSON.parse(candidate.replace(/^\ufeff/, ''));
        text = candidate;
        encoding = 'utf-16le';
      } catch (_) {
        fail('세이브 JSON 데이터를 읽을 수 없습니다.');
      }
    }

    const parsed = parsePlayerDataJson(text);
    parsed.meta.containerKind = 'save-binary';
    parsed.meta.saveKey = header.saveKey;
    parsed.meta.slotId = header.slotId;
    parsed.meta.hasBom = hasBom;
    parsed.meta.encoding = encoding;
    return parsed;
  }

  async function encodeSaveBytes(root, meta) {
    const m = meta || {};
    const kind = m.containerKind || 'json';
    if (kind === 'json') {
      const text = serializePlayerDataJson(root, m);
      return utf8Encode(text);
    }
    if (kind !== 'save-binary') fail('지원하지 않는 컨테이너 형식입니다.');

    let slotId = m.slotId;
    if (slotId == null && typeof m.saveKey === 'string') {
      const match = SAVE_KEY_RE.exec(m.saveKey);
      if (match) slotId = match[1];
    }
    if (slotId == null || !/^\d+$/.test(String(slotId))) fail('슬롯 번호를 확인할 수 없습니다.');
    const saveKey = SAVE_KEY_PREFIX + String(slotId);
    if (!SAVE_KEY_RE.test(saveKey)) fail('세이브 키가 올바르지 않습니다.');

    const text = serializePlayerDataJson(root, m);
    const payload = utf8Encode(text);
    const compressed = await deflateRaw(payload);
    if (compressed.length <= 0 || compressed.length > MAX_COMPRESSED_BYTES) {
      fail('압축 데이터 길이가 올바르지 않습니다.');
    }

    const keyBytes = utf8Encode(saveKey);
    const keyLen = write7BitInt(keyBytes.length);
    const compLen = write7BitInt(compressed.length);
    const total = keyLen.length + keyBytes.length + compLen.length + compressed.length;
    const out = new Uint8Array(total);
    let offset = 0;
    out.set(keyLen, offset); offset += keyLen.length;
    out.set(keyBytes, offset); offset += keyBytes.length;
    out.set(compLen, offset); offset += compLen.length;
    out.set(compressed, offset);
    return out;
  }

  return {
    SAVE_KEY_PREFIX,
    MAX_DECOMPRESSED_BYTES,
    read7BitInt,
    write7BitInt,
    inspectBinaryHeader,
    parsePlayerDataJson,
    serializePlayerDataJson,
    decodeSaveBytes,
    encodeSaveBytes
  };
});
