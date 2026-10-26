#!/usr/bin/env node
// One-off cleanup for duplicate Instatus components (same name in the same
// group) created by the old reconcile bug. Per (group, name) it keeps the
// component whose ID is configured in wrangler.jsonc, else the oldest one
// (Instatus IDs are cuids, which sort by creation time), and deletes the rest.
//
//   INSTATUS_API_KEY=... node scripts/dedupe-instatus-components.mjs          # dry run
//   INSTATUS_API_KEY=... node scripts/dedupe-instatus-components.mjs --apply  # delete

import { readFileSync } from 'node:fs'

const apiKey = process.env.INSTATUS_API_KEY
if (!apiKey) {
  console.error('Set INSTATUS_API_KEY')
  process.exit(1)
}
const apply = process.argv.includes('--apply')
const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
const pageId = process.env.INSTATUS_PAGE_ID || wrangler.match(/"INSTATUS_PAGE_ID":\s*"(\w+)"/)[1]
const configuredIds = new Set([...wrangler.matchAll(/"INSTATUS_\w+_COMPONENT_ID":\s*"(\w+)"/g)].map(m => m[1]))

async function api(path, method = 'GET') {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.instatus.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const text = await res.text()
    // Limit is 60/min; Instatus reports it as a 500 "Too many requests", not a 429.
    if ((res.status === 429 || text.includes('Too many requests')) && attempt < 5) {
      await new Promise(r => setTimeout(r, 60_000))
      continue
    }
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`)
    return text ? JSON.parse(text) : null
  }
}

const components = []
for (let page = 1; page <= 50; page++) {
  const batch = await api(`/v2/${pageId}/components?per_page=100&page=${page}`)
  // Subcomponents are nested under their group in `children`.
  for (const g of batch) {
    components.push(g)
    for (const c of g.children || []) components.push({ ...c, groupId: g.id })
  }
  if (batch.length < 100) break
}

const groupOf = c => (typeof c.group === 'string' ? c.group : c.group?.id) || c.groupId || null
const names = new Map(components.map(c => [c.id, c.name]))
const sets = new Map()
for (const c of components) {
  const group = groupOf(c)
  if (!group) continue // groups themselves / ungrouped components
  const key = `${group}\u0000${(c.name || '').toLowerCase()}`
  if (!sets.has(key)) sets.set(key, [])
  sets.get(key).push(c)
}

const toDelete = []
for (const list of sets.values()) {
  if (list.length < 2) continue
  list.sort((a, b) => (a.id < b.id ? -1 : 1))
  const keep = list.find(c => configuredIds.has(c.id)) || list[0]
  const extra = list.filter(c => c !== keep)
  console.log(`${names.get(groupOf(keep)) || groupOf(keep)} / ${keep.name}: keep ${keep.id}${configuredIds.has(keep.id) ? ' (configured)' : ''}, delete ${extra.length}`)
  toDelete.push(...extra)
}

console.log(`\n${components.length} components, ${toDelete.length} duplicates.`)
if (!apply) {
  console.log('Dry run. Re-run with --apply to delete.')
  process.exit(0)
}
for (const c of toDelete) {
  await api(`/v1/${pageId}/components/${c.id}`, 'DELETE')
  console.log(`deleted ${c.id} (${c.name})`)
  await new Promise(r => setTimeout(r, 1100)) // stay under 60 requests/min
}
