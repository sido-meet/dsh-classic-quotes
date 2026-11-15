// 一次性探针：对每个 seed 中文名，列出 Wikidata 候选及其职业、生卒、描述，
// 用来确定正确的 Q-id（同名的"屈原""老子"在 Wikidata 上有多个实体）。
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const API = "https://www.wikidata.org/w/api.php"
const UA = "dsh-classic-quotes-plugin/0.1 (probe)"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(params, attempt = 0) {
  const url = API + "?" + new URLSearchParams({ format: "json", formatversion: "2", ...params })
  const res = await fetch(url, { headers: { "user-agent": UA } })
  if (res.status === 429) {
    if (attempt >= 5) throw new Error("429 too many retries")
    await sleep(4000 * (attempt + 1))
    return api(params, attempt + 1)
  }
  if (!res.ok) throw new Error("wikidata " + res.status)
  return res.json()
}

function firstTime(entity, prop) {
  const v = entity?.claims?.[prop]?.[0]?.mainsnak?.datavalue?.value
  if (!v?.time) return null
  const m = /^([+-])(\d{4,})/.exec(v.time)
  if (!m) return null
  const y = Number(m[2])
  return m[1] === "-" ? -y : y
}

const seeds = JSON.parse(await readFile(join(ROOT, "scripts", "seed-people.json"), "utf8"))
for (const seed of seeds) {
  console.log("\n### " + seed.zh + "  (期望 " + seed.role + " / " + seed.era + ")")
  let hits = []
  try {
    const data = await api({
      action: "wbsearchentities",
      search: seed.zh,
      language: "zh",
      uselang: "zh",
      type: "item",
      limit: "10",
    })
    hits = data?.search ?? []
  } catch (err) {
    console.log("  搜索失败 " + err.message)
    continue
  }
  await sleep(1600)
  for (const h of hits.slice(0, 6)) {
    let detail = null
    try {
      const d = await api({
        action: "wbgetentities",
        ids: h.id,
        props: "labels|descriptions|claims",
        languages: "zh|en",
      })
      detail = d?.entities?.[h.id]
    } catch { /* 单个失败不中断 */ }
    await sleep(1600)
    const occ = (detail?.claims?.P106 ?? []).map((c) => c?.mainsnak?.datavalue?.value?.id).filter(Boolean)
    const b = firstTime(detail, "P569")
    const d2 = firstTime(detail, "P570")
    console.log(
      "  " + h.id + " | " + h.label + " | " + (h.description ?? "") +
      " | " + (detail?.labels?.en?.value ?? "") + " | " + (b ?? "?") + "-" + (d2 ?? "?") +
      " | occ=" + occ.join(",")
    )
  }
}
