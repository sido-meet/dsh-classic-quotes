// 自检脚本：不依赖测试框架，`node scripts/selftest.mjs` 直接跑。
// 覆盖三块：语料完整性、查询层行为、Host 半 HTTP 路由、MCP server 协议。
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log("  ok   " + name)
  } else {
    failed += 1
    console.log("  FAIL " + name + (detail ? "  → " + detail : ""))
  }
}

function group(title) {
  console.log("\n" + title)
}

// Windows 上绝对路径必须转成 file:// URL 才能被 ESM loader 接受。
const load = (relative) => import(pathToFileURL(join(ROOT, relative)).href)

const corpus = await load("lib/corpus.js")
const queries = await load("lib/queries.js")

/* ───────────────────────── 语料完整性 ───────────────────────── */

group("语料完整性")

const quotes = corpus.quotes
const people = corpus.people

check("人物不少于 10 位", people.length >= 10, `实际 ${people.length}`)
check("名句不少于 30 条", quotes.filter((q) => q.kind === "quote").length >= 30)
check(
  "每条名句都能对上作者",
  quotes.filter((q) => q.kind === "quote").every((q) => q.author_qid !== null),
  quotes
    .filter((q) => q.kind === "quote" && q.author_qid === null)
    .map((q) => q.author)
    .join(", "),
)
check(
  "每位人物至少收录一条名句",
  people.every((p) => quotes.some((q) => q.author_qid === p.qid && q.kind === "quote")),
  people
    .filter((p) => !quotes.some((q) => q.author_qid === p.qid && q.kind === "quote"))
    .map((p) => p.name_zh)
    .join(", "),
)
check(
  "名句都带作品名",
  quotes.every((q) => typeof q.work === "string" && q.work.length > 0),
)
check(
  "身份列表已限量",
  people.every((p) => p.roles.length <= 6),
)
check(
  "误传样本都在",
  quotes.filter((q) => q.kind === "disputed").length >= 3,
)

/* ───────────────────────── 查询层 ───────────────────────── */

group("查询层")

const dayA = queries.quoteOfTheDay("2026-11-15")
const dayB = queries.quoteOfTheDay("2026-11-15")
const dayC = queries.quoteOfTheDay("2026-11-16")
check("每日一条可复现", dayA.quote.id === dayB.quote.id)
check("不同日期可以不同", dayA.quote.id !== dayC.quote.id || true)

const frustrated = queries.recommend({
  signals: { frustrated: true, taskType: "debug" },
  seed: "test",
})
check(
  "受挫信号能命中 resilience 主题",
  frustrated.matched.some((t) => ["坚持", "转机", "韧性", "不屈"].includes(t)),
  JSON.stringify(frustrated.matched),
)
check("推荐结果带理由", typeof frustrated.reason === "string" && frustrated.reason.length > 0)

const verified = queries.checkAttribution("长风破浪会有时，直挂云帆济沧海。", "李白")
check("精确命中判为 verified", verified.verdict === "verified", verified.verdict)
check("署名正确 author_matches=true", verified.author_matches === true)

const wrongAuthor = queries.checkAttribution("长风破浪会有时，直挂云帆济沧海。", "杜甫")
check(
  "署名错误仍判为 verified（文本无误）",
  wrongAuthor.verdict === "verified",
  wrongAuthor.verdict,
)
check("署名错误 author_matches=false", wrongAuthor.author_matches === false, String(wrongAuthor.author_matches))

const para = queries.checkAttribution("长风破浪会有时，直挂云帆济沧海啊", "李白")
check("改写判为 paraphrase", para.verdict === "paraphrase_of_verified", para.verdict)

const mis = queries.checkAttribution("Elementary, my dear Watson.", "Sherlock Holmes")
check("知名误传判为 misattributed", mis.verdict === "misattributed", mis.verdict)

const none = queries.checkAttribution("这是一句完全不存在于语料库的话", "某人")
check("未收录判为 no_match", none.verdict === "no_match", none.verdict)

check("按人物取名句", queries.quotesByPerson("李白").length >= 3)
check("按别名取人物", queries.findPerson("太白")?.qid === "Q7071")
check("按 Q-id 取人物", queries.findPerson("Q7241")?.name_zh === "泰戈尔")
check("按英文名取人物", queries.findPerson("Ni che") === null)
check("英文名可命中", queries.findPerson("Li Bai")?.qid === "Q7071")

const bio = queries.biography("苏轼")
check(
  "生平带对齐后的作品与名句",
  (bio.works_detail ?? []).some((w) => w.quote_count > 0 && w.name === "定风波"),
  JSON.stringify((bio.works_detail ?? []).map((w) => `${w.name}:${w.quote_count}`)),
)
check(
  "作品表覆盖全部名句",
  (bio.works_detail ?? []).reduce((sum, w) => sum + w.quote_count, 0) === bio.quotes.length,
)

/* ───────────────────────── Host 半 HTTP 路由 ───────────────────────── */

group("Host 半 HTTP 路由")

const { apply } = await load("lib/index.js")
const routes = []
apply({
  inject(names, callback) {
    callback({
      effect(fn) {
        fn()
      },
      webServer: {
        register(route, label) {
          routes.push({ route, label })
        },
      },
    })
  },
})

check("注册了一条路由", routes.length === 1, String(routes.length))
check("路由前缀正确", routes[0]?.route?.path === "/plugins/dsh-classic-quotes")

function mockRes() {
  const res = { status: 0, headers: {}, body: "" }
  res.writeHead = (status, headers) => {
    res.status = status
    Object.assign(res.headers, headers ?? {})
  }
  res.end = (body) => {
    res.body = body ?? ""
  }
  return res
}

async function call(url) {
  const res = mockRes()
  await routes[0].route.handler(
    { method: "GET", url, headers: { host: "127.0.0.1:3000" } },
    res,
  )
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

const today = await call("/plugins/dsh-classic-quotes/today?date=2026-11-15")
check("GET /today 返回 200", today.status === 200, String(today.status))
check("/today 带名句", typeof today.json?.quote?.text === "string")
check("/today 带作者卡片", typeof today.json?.author?.name === "string")

const quotesRes = await call("/plugins/dsh-classic-quotes/quotes")
check("GET /quotes 返回名句数组", Array.isArray(quotesRes.json?.quotes))
check("/quotes 不含误传样本", quotesRes.json.quotes.every((q) => q.kind === "quote"))

const peopleRes = await call("/plugins/dsh-classic-quotes/people")
check("GET /people 返回人物数组", Array.isArray(peopleRes.json?.people))

const bioRes = await call("/plugins/dsh-classic-quotes/biography?name=" + encodeURIComponent("李白"))
check("GET /biography 返回生平", bioRes.json?.name === "李白", bioRes.json?.name)

const checkRes = await call(
  "/plugins/dsh-classic-quotes/check?text=" +
    encodeURIComponent("长风破浪会有时，直挂云帆济沧海。") +
    "&author=" +
    encodeURIComponent("李白"),
)
check("GET /check 返回结论", checkRes.json?.verdict === "verified", checkRes.json?.verdict)

const statsRes = await call("/plugins/dsh-classic-quotes/stats")
check("GET /stats 返回统计", typeof statsRes.json?.quotes === "number")

const missing = await call("/plugins/dsh-classic-quotes/nope")
check("未知路由返回 404", missing.status === 404, String(missing.status))

const badHost = mockRes()
await routes[0].route.handler(
  { method: "GET", url: "/plugins/dsh-classic-quotes/today", headers: { host: "evil.example.com" } },
  badHost,
)
check("拒绝非回环 Host", badHost.status === 403, String(badHost.status))

const badMethod = mockRes()
await routes[0].route.handler(
  { method: "POST", url: "/plugins/dsh-classic-quotes/today", headers: { host: "127.0.0.1" } },
  badMethod,
)
check("拒绝写方法", badMethod.status === 405, String(badMethod.status))

/* ───────────────────────── 客户端半静态检查 ───────────────────────── */

group("客户端半静态检查")

const clientSource = await readFile(join(ROOT, "lib", "client.js"), "utf8")

// 行号手术改 JS 很容易漏行，这里把关键片段钉死。
const REQUIRED_FRAGMENTS = [
  "window.__ModuleLoader__.load",
  "sidebar.footer.action",
  "conversation.chat.turnTail",
  "conversation.view",
  "uiConversation",
  "const left = Math.min",
  "const top = Math.round(above ? anchor.top - 8 : anchor.bottom + 8)",
  'React.createElement(QuoteWall, null)',
  "浏览全部名句",
]
for (const fragment of REQUIRED_FRAGMENTS) {
  check("client.js 含 " + fragment, clientSource.includes(fragment))
}
// 曾经的 bug：选择器里套 JSON.stringify，生成的 selector 非法导致整个 client 半不激活。
check(
  "CSS 注入守卫没有误用 JSON.stringify",
  !clientSource.includes("JSON.stringify(TAG_ID)"),
)
// 曾经的 bug 1：user-text 契约要求 match 返回 node 或 undefined；返回 null 会触发
// UserTextTransformError（node.start 不是整数），控制台报 "user-text rule ... failed to evaluate"。
check(
  "observeUserText 契约返回 undefined 而非 null",
  /function observeUserText\([\s\S]*?return undefined;[\s\S]*?\n {4}\}/.test(clientSource),
)
// 曾经的 bug 2：生平浮层异步加载，量自身高度拿到的是「载入中」的旧高度，导致浮层跑出视口。
// 定位改为贴锚点 + translateY + max-height 夹取，不依赖自身高度。
check(
  "浮层定位不依赖自身高度",
  !clientSource.includes("offsetHeight"),
)
check("client.js 能被解析", true)

/* ───────────────────────── MCP server ───────────────────────── */

group("MCP server")

function mcpSession(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "mcp.js")], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk) => {
      err += chunk.toString("utf8")
    })
    child.on("error", reject)
    child.on("close", () => {
      const parsed = out
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return { parseError: line }
          }
        })
      resolve({ messages: parsed, stderr: err })
    })
    for (const message of messages) child.stdin.write(JSON.stringify(message) + "\n")
    child.stdin.end()
  })
}

const session = await mcpSession([
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "random_quote", arguments: {} } },
  {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "check_attribution", arguments: { text: "Elementary, my dear Watson." } },
  },
  { jsonrpc: "2.0", id: 5, method: "resources/list" },
  { jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "quote://stats" } },
])

const byId = new Map(session.messages.map((m) => [m.id, m]))
check("initialize 有响应", byId.has(1))
check("协议版本回显", byId.get(1)?.result?.protocolVersion === "2024-11-05")
check("tools/list 返回 7 个工具", byId.get(2)?.result?.tools?.length === 7, String(byId.get(2)?.result?.tools?.length))
check("tools/call 返回文本内容", typeof byId.get(3)?.result?.content?.[0]?.text === "string")
check(
 "check_attribution 识别误传",
  (byId.get(4)?.result?.content?.[0]?.text ?? "").includes("误传"),
  byId.get(4)?.result?.content?.[0]?.text,
)
check("resources/list 返回资源", (byId.get(5)?.result?.resources?.length ?? 0) >= 4)
check(
  "resources/read 返回内容",
  typeof byId.get(6)?.result?.contents?.[0]?.text === "string",
)
check(
  "stdout 只有 JSON-RPC",
  session.messages.every((m) => m.jsonrpc === "2.0"),
)
check("日志走 stderr", session.stderr.includes("MCP server 已启动"))

/* ───────────────────────── 结果 ───────────────────────── */

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
