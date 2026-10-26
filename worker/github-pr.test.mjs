import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseArtifactComment, parsePrUrl, unzipFirstBin } from './github-pr.ts'

test('parses PR and comment URLs', () => {
  assert.deepEqual(
    parsePrUrl('https://github.com/crosspoint-reader/crosspoint-reader/pull/3787#issuecomment-5885848879'),
    { owner: 'crosspoint-reader', repo: 'crosspoint-reader', pr: 3787 }
  )
  assert.equal(parsePrUrl('https://github.com/a/b/issues/1'), null)
})

test('maps artifact comment lines to device suffixes', () => {
  const body = [
    '<!-- pr-firmware-artifacts -->',
    '- [X3 / X4 (`firmware.bin`)](https://github.com/o/r/actions/runs/1/artifacts/11)',
    '- [X4 Pro (`firmware-x4pro.bin`)](https://github.com/o/r/actions/runs/1/artifacts/22)',
    '- [MetalIO EInk4 (`firmware-metalio_eink4.bin`)](https://github.com/o/r/actions/runs/1/artifacts/33)',
  ].join('\n')
  assert.deepEqual(parseArtifactComment(body).map(a => [a.suffix, a.artifactId]), [
    ['x3-x4', '11'], ['x4pro', '22'], ['metalio_eink4', '33'],
  ])
})

test('extracts the .bin from a deflated zip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zip-'))
  const payload = Buffer.from('firmware!'.repeat(1000))
  writeFileSync(join(dir, 'firmware.bin'), payload)
  execFileSync('zip', ['-q', '-fd', 'a.zip', 'firmware.bin'], { cwd: dir })
  const zip = readFileSync(join(dir, 'a.zip'))
  const out = await unzipFirstBin(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength))
  assert.deepEqual(Buffer.from(out), payload)
})
