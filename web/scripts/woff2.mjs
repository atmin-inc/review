// Minimal TTF -> WOFF2 encoder (W3C WOFF2, section 5) using Node's built-in Brotli.
// The server only serves .woff2 fonts and the brand kit ships TTF, so the build converts
// the kit's pinned files. Every table is stored untransformed: glyf and loca use the
// null transform (version 3), all other tables version 0. Glyph data is unchanged.
import { brotliCompressSync, constants } from 'node:zlib';

// Section 5.1 known table tags; the index is stored instead of the tag when present.
const knownTags = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep',
  'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS',
  'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln',
  'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf',
  'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

function base128(value) {
  const bytes = [value & 0x7f];
  for (value >>>= 7; value > 0; value >>>= 7) bytes.unshift(0x80 | (value & 0x7f));
  return bytes;
}

export function readTables(font) {
  const count = font.readUInt16BE(4);
  return Array.from({ length: count }, (_, i) => {
    const at = 12 + i * 16;
    return { tag: font.toString('latin1', at, at + 4), offset: font.readUInt32BE(at + 8), length: font.readUInt32BE(at + 12) };
  });
}

export function toWoff2(font) {
  const flavor = font.readUInt32BE(0);
  if (flavor !== 0x00010000 && flavor !== 0x4f54544f) throw new Error('Not a TrueType or OpenType font');
  const tables = readTables(font);
  // An untransformed loca must directly follow glyf in the table directory.
  const loca = tables.findIndex(t => t.tag === 'loca');
  if (loca >= 0) tables.splice(tables.findIndex(t => t.tag === 'glyf') + 1, 0, ...tables.splice(loca, 1));
  const directory = [];
  for (const table of tables) {
    const version = table.tag === 'glyf' || table.tag === 'loca' ? 3 : 0;
    const known = knownTags.indexOf(table.tag);
    directory.push((known >= 0 ? known : 63) | (version << 6));
    if (known < 0) directory.push(...Buffer.from(table.tag, 'latin1'));
    directory.push(...base128(table.length));
  }
  const data = Buffer.concat(tables.map(t => font.subarray(t.offset, t.offset + t.length)));
  const compressed = brotliCompressSync(data, { params: {
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT,
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
  } });
  const length = Math.ceil((48 + directory.length + compressed.length) / 4) * 4;
  const head = tables.find(t => t.tag === 'head');
  const out = Buffer.alloc(length);
  out.writeUInt32BE(0x774f4632, 0); // 'wOF2'
  out.writeUInt32BE(flavor, 4);
  out.writeUInt32BE(length, 8);
  out.writeUInt16BE(tables.length, 12);
  out.writeUInt32BE(12 + 16 * tables.length + tables.reduce((sum, t) => sum + Math.ceil(t.length / 4) * 4, 0), 16);
  out.writeUInt32BE(compressed.length, 20);
  if (head) { out.writeUInt16BE(font.readUInt16BE(head.offset + 4), 24); out.writeUInt16BE(font.readUInt16BE(head.offset + 6), 26); }
  Buffer.from(directory).copy(out, 48);
  compressed.copy(out, 48 + directory.length);
  return out;
}
