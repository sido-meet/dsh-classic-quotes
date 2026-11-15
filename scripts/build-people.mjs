// 用 Wikidata 生成 data/people.jsonl。
// Q-id 已由 scripts/probe-candidates.mjs 人工确认（同名实体有多个，必须写死）。
// 这里只负责把权威字段抓下来并落盘，并校验 label 与 seed 一致——不一致就报错，不静默通过。
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const API = "https://www.wikidata.org/w/api.php"
const UA = "dsh-classic-quotes-plugin/0.1 (build-people)"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(params, attempt = 0) {
  const url = API + "?" + new URLSearchParams({ format: "json", formatversion: "2", ...params })
  const res = await fetch(url, { headers: { "user-agent": UA } })
  if (res.status === 429) {
    if (attempt >= 6) throw new Error("429: too many retries")
    await sleep(4000 * (attempt + 1))
    return api(params, attempt + 1)
  }
  if (!res.ok) throw new Error("wikidata " + res.status)
  return res.json()
}

function claimTime(entity, prop) {
  const v = entity?.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value
  if (!v?.time) return null
  const m = /^([+-])(\d{4,})-(\d{2})-(\d{2})/.exec(v.time)
  if (!m) return null
  const year = Number(m[2])
  return { year: m[1] === "-" ? -year : year, precision: v.precision ?? 11, raw: v.time }
}

function claimIds(entity, prop) {
  return (entity?.claims?.[prop] ?? [])
    .map((c) => c?.mainsnak?.datavalue?.value?.id)
    .filter(Boolean)
}

async function labelMap(ids) {
  const map = new Map()
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    if (chunk.length === 0) continue
    const data = await api({
      action: "wbgetentities",
      ids: chunk.join("|"),
      props: "labels",
      languages: "zh|zh-hans|zh-cn|en",
    })
    for (const [id, e] of Object.entries(data?.entities ?? {})) {
      // 简体优先：Wikidata 的 zh label 常常是繁体（詩人 / 画家），
      // 混排展示很难看。
      const zh =
        e?.labels?.["zh-hans"]?.value ?? e?.labels?.["zh-cn"]?.value ?? e?.labels?.zh?.value
      map.set(id, {
        zh: zh ?? null,
        en: e?.labels?.en?.value ?? null,
      })
    }
    await sleep(1200)
  }
  return map
}

async function main() {
  const seeds = JSON.parse(await readFile(join(ROOT, "scripts", "seed-people.json"), "utf8"))
  const rows = []
  const occIds = new Set()

  // 断点续跑：已落盘的记录先读回来，网络失败的人保留上一版数据，不至于被"跳过"抹掉。
  const existing = new Map()
  try {
    const prev = await readFile(join(ROOT, "data", "people.jsonl"), "utf8")
    for (const line of prev.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = JSON.parse(trimmed)
        if (row?.qid) existing.set(row.qid, row)
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    /* 首次运行，没有旧文件 */
  }

  for (const seed of seeds) {
    process.stdout.write("· " + seed.zh + " (" + seed.qid + ") … ")
    let data
    try {
      data = await api({
        action: "wbgetentities",
        ids: seed.qid,
        props: "labels|descriptions|claims|sitelinks",
        languages: "zh|zh-hans|zh-cn|en",
        sitefilter: "zhwiki|enwiki",
      })
    } catch (err) {
      const kept = existing.get(seed.qid)
      if (kept) {
        rows.push(kept)
        console.log("抓取失败：" + err.message + " —— 沿用已有记录")
      } else {
        console.log("抓取失败：" + err.message + " —— 跳过")
      }
      continue
    }
    const entity = data?.entities?.[seed.qid]
    if (!entity) {
      const kept = existing.get(seed.qid)
      if (kept) rows.push(kept)
      console.log("实体不存在" + (kept ? " —— 沿用已有记录" : ""))
      continue
    }
    // Wikidata 的中文 label 常是繁体（苏轼→蘇軾），所以比对所有 zh 系标签，
    // 任一命中即通过；同时优先用简体标签做展示名。
    const zhLabels = ["zh-hans", "zh-cn", "zh"]
      .map((code) => entity.labels?.[code]?.value)
      .filter(Boolean)
    const zhLabel = zhLabels[0] ?? null
    const expected = new Set([seed.zh, ...(seed.aliases ?? [])])
    const hit = zhLabels.find((label) => expected.has(label))
    if (!hit) {
      const kept = existing.get(seed.qid)
      if (kept) rows.push(kept)
      console.log(
        "label 不匹配：wikidata=" + zhLabels.join("/") + "，seed=" + seed.zh +
          (kept ? " —— 沿用已有记录" : " —— 已跳过"),
      )
      continue
    }

    const birth = claimTime(entity, "P569")
    const death = claimTime(entity, "P570")
    const occupations = claimIds(entity, "P106")
    occupations.forEach((id) => occIds.add(id))
    const sitelinks = entity.sitelinks ?? {}

    rows.push({
      qid: seed.qid,
      name_zh: seed.zh,
      name_full: hit,
      name_en: entity.labels?.en?.value ?? seed.en,
      aliases: seed.aliases ?? [],
      description_zh:
        entity.descriptions?.["zh-hans"]?.value ??
        entity.descriptions?.["zh-cn"]?.value ??
        entity.descriptions?.zh?.value ??
        null,
      description_en: entity.descriptions?.en?.value ?? null,
      birth_year: birth?.year ?? null,
      birth_precision: birth?.precision ?? null,
      death_year: death?.year ?? null,
      death_precision: death?.precision ?? null,
      era: seed.era,
      seed_role: seed.role,
      roles: occupations,
      notable_work_qids: claimIds(entity, "P800"),
      works: seed.works,
      wikipedia_zh: sitelinks.zhwiki?.title ?? null,
      wikipedia_en: sitelinks.enwiki?.title ?? null,
      source: "wikidata",
    })
    const last = rows[rows.length - 1]
    console.log(last.birth_year + "–" + last.death_year + " · " + (zhLabel ?? "?"))
    await sleep(1200)
  }

  const labels = await labelMap([...occIds])
  for (const row of rows) {
    // 只保留有中文译名的身份；英文专名（freedom fighter 之类）对这个插件没意义。
    // 中文名一个都没有时，才退回英文，避免把「诗人」整个丢掉。
    const zh = row.roles.map((id) => labels.get(id)?.zh).filter(Boolean)
    const en = row.roles.map((id) => labels.get(id)?.en).filter(Boolean)
    row.roles = zh.length > 0 ? zh : en.length > 0 ? en : row.roles
  }

  await mkdir(join(ROOT, "data"), { recursive: true })
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n"
  await writeFile(join(ROOT, "data", "people.jsonl"), body, "utf8")
  console.log("\n写入 data/people.jsonl：" + rows.length + " 人")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
