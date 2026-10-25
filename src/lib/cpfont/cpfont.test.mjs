// Unit tests for the browser .cpfont generator. These run without Python: the
// byte-for-byte comparison against the reference generator lives in
// scripts/font-builder/parity.mjs (needs freetype-py + fonttools).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { buildCpfonts } from './build.js'
import { defaultFallbackNames, DEFAULT_FALLBACK_FILES } from './fallbacks.js'
import { FontBuildError, INTERVAL_PRESETS, parseHexRange, resolveIntervals } from './intervals.js'
import { deriveKernClasses } from './opentype.js'

const FONT = 'scripts/font-builder/default-fallback-fonts/NotoSansHebrew-Regular.ttf'

test('parseHexRange accepts the forms the UI allows', () => {
  assert.deepEqual(parseHexRange('(0x2100-0x214f)'), [0x2100, 0x214f])
  assert.deepEqual(parseHexRange('0x2100-0x214F'), [0x2100, 0x214f])
  assert.deepEqual(parseHexRange('0x2122'), [0x2122, 0x2122])
  assert.equal(parseHexRange('0x2122-0x2000'), null, 'start after end')
  assert.equal(parseHexRange('0x110000'), null, 'past the last codepoint')
  assert.equal(parseHexRange('latin-ext'), null)
})

test('resolveIntervals always includes base coverage and U+FFFD', () => {
  const base = resolveIntervals('')
  assert.deepEqual(base, [[0x0000, 0x007f], [0x2000, 0x206f], [0xfffd, 0xfffd]])

  // Presets are additive on top of base, and merged.
  const greek = resolveIntervals('greek')
  assert.ok(greek.some(([start, end]) => start <= 0x0370 && end >= 0x03ff))
  assert.ok(greek.some(([start]) => start === 0x0000))

  // Custom ranges work alongside presets.
  const custom = resolveIntervals('greek,0x2122')
  assert.ok(custom.some(([start, end]) => start === 0x2122 && end === 0x2122))
})

test('resolveIntervals merges adjacent ranges', () => {
  // 0x0000-0x007F (base) and 0x0080-0x00FF (default) are adjacent.
  const merged = resolveIntervals('default')
  assert.ok(merged.some(([start, end]) => start === 0x0000 && end >= 0x00ff))
})

test('resolveIntervals rejects unknown coverage entries', () => {
  assert.throws(() => resolveIntervals('not-a-preset'), FontBuildError)
})

test('every UI preset name resolves', () => {
  for (const name of Object.keys(INTERVAL_PRESETS)) {
    assert.ok(resolveIntervals(name).length > 0, name)
  }
})

test('deriveKernClasses groups codepoints with identical adjustments', () => {
  // A and B kern identically against V; T kerns differently.
  const kernMap = new Map([
    ['65,86', -8], // A V
    ['66,86', -8], // B V
    ['84,86', -4], // T V
  ])
  const derived = deriveKernClasses(kernMap)
  assert.equal(derived.kernRightClassCount, 1, 'one right class (V)')
  assert.equal(derived.kernLeftClassCount, 2, 'A/B share a class, T gets its own')
  assert.equal(derived.kernMatrix.length, 2)
  assert.deepEqual([...derived.kernMatrix].sort((a, b) => a - b), [-8, -4])

  const classOf = new Map(derived.kernLeftClasses)
  assert.equal(classOf.get(65), classOf.get(66))
  assert.notEqual(classOf.get(65), classOf.get(84))
})

test('deriveKernClasses returns empty tables for an empty map', () => {
  const derived = deriveKernClasses(new Map())
  assert.equal(derived.kernLeftClassCount, 0)
  assert.equal(derived.kernRightClasses.length, 0)
  assert.equal(derived.kernMatrix.length, 0)
})

test('bundled fallbacks pick the CJK font matching the coverage', () => {
  assert.equal(defaultFallbackNames('cjk-jp')[DEFAULT_FALLBACK_FILES.length], 'NotoSansCJKjp-Regular.otf')
  assert.equal(defaultFallbackNames('cjk-tc')[DEFAULT_FALLBACK_FILES.length], 'NotoSansCJKtc-Regular.otf')
  assert.equal(defaultFallbackNames('base,cjk-sc')[DEFAULT_FALLBACK_FILES.length], 'NotoSansCJKsc-Regular.otf')
  // Non-CJK builds still carry one CJK fallback for stray ideographs.
  assert.deepEqual(defaultFallbackNames('reading').slice(DEFAULT_FALLBACK_FILES.length),
    ['NotoSansCJKjp-Regular.otf'])
})

test('buildCpfonts writes a v4 container per size', async () => {
  const bytes = new Uint8Array(readFileSync(FONT))
  const files = await buildCpfonts({
    family: 'Test Family',
    sizes: [12, 14],
    intervals: resolveIntervals('base'),
    styles: { regular: bytes },
  })

  assert.deepEqual(files.map((file) => file.name), ['Test Family_12.cpfont', 'Test Family_14.cpfont'])

  for (const file of files) {
    const view = new DataView(file.data.buffer, file.data.byteOffset, file.data.byteLength)
    assert.equal(new TextDecoder().decode(file.data.subarray(0, 6)), 'CPFONT')
    assert.equal(view.getUint16(8, true), 4, 'format version')
    assert.equal(view.getUint16(10, true), 1, 'flags: 2-bit greyscale')
    assert.equal(view.getUint8(12), 1, 'one style')

    const glyphCount = view.getUint32(32 + 8, true)
    assert.ok(glyphCount > 0)
    const advanceY = view.getUint8(32 + 12)
    assert.ok(advanceY > 0 && advanceY < 256)
  }

  // Bigger point size, more bitmap data.
  assert.ok(files[1].data.byteLength > files[0].data.byteLength)
})

test('buildCpfonts requires a regular style', async () => {
  await assert.rejects(
    buildCpfonts({ family: 'X', sizes: [12], intervals: resolveIntervals('base'), styles: {} }),
    FontBuildError)
})
