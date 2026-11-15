# dsh-classic-quotes · 名人语录

DeepSeek Harness 插件：**侧栏每日一条名句 + 回合结束后的应时而变鼓励卡 + 可核查出处的语录墙**，并附带一个可独立复用的「名人著作生平」MCP server。

零门槛：不需要 API key，不需要联网，语料随包发布。

![侧栏每日一条](docs/screenshot-sidebar.png)

---

## 三个界面

| 位置 | 槽位 | 说明 |
|---|---|---|
| 侧栏底部常驻 | `sidebar.footer.action` | 每天一句，同一天固定；点正文看生平，点齿轮改设置 |
| 每轮回复之后 | `conversation.chat.turnTail` | 按你这轮在做什么推荐，并说明「为什么是这句」 |
| 会话视图 tab | `conversation.view` | 语录墙：13 位人物 / 39 条名句，按时代与主题筛选 |

![回合鼓励卡](docs/screenshot-turntail.png)

### 推荐是怎么算出来的

**不调用模型。** 纯规则打分，零延迟、零成本、可解释：

```
score = Σ(信号权重 × 主题命中) − 最近用过的 − 今天已用过的
```

信号从你的输入里旁听得到（DSH 官方 `uiConversation.userText.register` 通道）：

| 信号 | 判定方式 | 命中的主题 |
|---|---|---|
| 受挫 | 「还是不行 / 又挂了 / 崩溃 / 卡住 / still failing…」 | 坚持、转机、韧性、不屈 |
| 刚完成 | 「搞定 / 通过了 / fixed / works now…」 | 豁达、担当、坚持 |
| 深夜 | 23:00–05:00 | 生命、接受、豁达 |
| 任务类型 | 报错→debug / 文档→write / 方案→plan | 专注、行动 / 学习、积累 / 视野、格局 |

所以你输入「这个 bug 又挂了好几次，还是不行」，卡片会给：

> 应时而变 · 检测到受挫信号 · 任务类型：调试 · 匹配主题：坚持、转机
> **山重水复疑无路，柳暗花明又一村。** —— 陆游《游山西村》

---

## 安装

```sh
# 1. 装进 profile（CLI 路径；桌面端用「插件」面板安装效果相同）
dsh plugin --profile <profile> add dsh-classic-quotes

# 2. 声明为 profile 层（CLI 不会自动写这一行）
#    在 ~/.dsh/profiles/<profile>/package.json 里：
#    "dsh": { "profile": { "bundles": ["...", "dsh-classic-quotes"] } }
```

本地开发直接指向源码目录即可，改完刷新页面就生效：

```sh
dsh plugin --profile quote-test add E:\path\to\dsh-classic-quotes
```

---

## MCP server

同一份语料，另开一个标准 MCP server（stdio，**零依赖**，不用 npm install 就能跑）：

```sh
dsh-classic-quotes-mcp
# 或
node node_modules/dsh-classic-quotes/bin/mcp.js
```

### 工具（7 个）

| 工具 | 作用 |
|---|---|
| `random_quote` | 取一条名句，可按主题 / 时代 / 作者 / 情绪过滤 |
| `quote_of_the_day` | 每日一条，同一天同参数结果稳定 |
| `recommend_quote` | 按 signals（受挫 / 刚完成 / 深夜 / 任务类型 / 关键词）推荐 |
| `quotes_by_person` | 某人的名句全集（中文名 / 别名 / 英文名 / Q-id 都能命中） |
| `biography` | 结构化生平档案 + 代表作 + 名句 |
| `works_by_author` | 代表作清单，附该作品下的名句 |
| `check_attribution` | 核查一句话的归属 |

### 资源（4 个）

`quote://today`、`quote://people`、`quote://quotes`、`quote://stats`

### 为什么 UI 不走 MCP

MCP 是「模型 ↔ 工具」的协议，不是 UI 数据管道。侧栏每一条名句都过一次模型往返，
既慢又贵，还没法保证稳定性。所以这里走**双通道**：

- **Host 半直连自己的查询层**（`/plugins/dsh-classic-quotes/*` 只读 HTTP 接口）→ 供 UI 用，零延迟
- **同一个查询层再包一层 MCP** → 供模型主动引用、别的宿主复用

两条路共用 `lib/queries.js`，所以「UI 里看到的」和「模型引用的」永远一致。

---

## 语料

`data/quotes.jsonl`（名句）与 `data/people.jsonl`（人物生平）各一行一个 JSON。

```json
{"id":"q-libai-xinglu","text":"长风破浪会有时，直挂云帆济沧海。","author":"李白","work":"行路难·其三","era":"唐","topics":["挫折","乐观","远行"],"mood":"uplifting","domain":["唐诗"],"kind":"quote","verification":"curated","source":"chinese-poetry"}
```

- `kind`：`quote`（可展示）/ `disputed`（误传样本，只用于归属核查）
- `verification`：`curated`（出处已核查）/ `disputed`（有争议）/ `unverified`
- 人物生平来自 Wikidata（`scripts/build-people.mjs` 抓取，Q-id 写死在 `scripts/seed-people.json`），
  语料作者名通过别名表对到人物记录，从而自动补上生卒年、时代、身份、代表作。

### 归属核查

`check_attribution` 返回四种结论：

| verdict | 含义 |
|---|---|
| `verified` | 语料中有此句；`author_matches` 告诉你署名对不对 |
| `misattributed` | 广为流传的误传（如「Elementary, my dear Watson」） |
| `paraphrase_of_verified` | 与某条名句高度相似的改写（Dice 系数 ≥ 0.75） |
| `no_match` | 语料中没有这句话 |

---

## 开发

```sh
node scripts/selftest.mjs          # 61 项自检：语料完整性 / 查询层 / HTTP 路由 / MCP 协议 / client 静态检查
node scripts/build-people.mjs      # 从 Wikidata 重建人物生平（会断点续跑，网络失败不丢旧数据）
node scripts/probe-candidates.mjs  # 查同名实体的 Q-id
python scripts/browser-smoke.py http://127.0.0.1:8791 <token>   # 浏览器端回归（需 playwright）
python scripts/turn-smoke.py    http://127.0.0.1:8791 <token>   # 回合鼓励卡回归（发真消息，看推荐理由）
python scripts/desktop-shots.py http://127.0.0.1:8791 <token> <目录>   # 重出截图
```

浏览器端回归脚本抓的是**静态检查抓不到**的一类问题：非法 CSS 选择器会让整个
client 半静默不激活、浮层定位算错会飘出视口、漏掉一个变量会 ReferenceError
把整个槽位打挂。

### 实机验证记录（desktop profile）

桌面端起 profile 有个坑：CLI 的 `dsh --profile desktop` 会因为「已经是桌面端」
保护直接静默退出（exit 0、无窗口）。绕法是直接调 npm 包里的 boot 代码：

```js
import { runProfile } from "@deepseek-ai/dsh/lib/profile-boot.js";
import { loadLayeredEnv } from "@deepseek-ai/dsh-app-boot";
await runProfile({
  environment: loadLayeredEnv("dsh"),
  profile: "desktop",
  patchFiles: [],
  args: ["--port", "8793"],
});
```

这轮实机验证抓出并修掉了两个静态检查看不到的 bug：

1. **user-text 契约**：`uiConversation.userText.register` 的 `match(text, cursor, context)`
   必须返回候选节点或 `undefined`；返回 `null` 会被当成候选校验（`node.start` 不是整数），
   抛 `UserTextTransformError`，控制台刷 `user-text rule "..." failed to evaluate`。
   我们不改写用户原文，所以永远返回 `undefined`。
2. **浮层定位不能依赖自身高度**：生平是异步加载的，第一次量到的是「载入中」的旧高度，
   浮层会飘出视口。改成「贴锚点 + `translateY(-100%)` + `max-height` 夹取」，
   滚动/缩放时重算，完全不读自己的 `offsetHeight`。

---

## 目录

```
dsh-classic-quotes/
├── lib/
│   ├── index.js      Host 半：只读 HTTP 路由 /plugins/dsh-classic-quotes/*
│   ├── client.js     Client 半：三个槽位 + 浮层 + 样式
│   ├── corpus.js     语料加载与索引（唯一事实源）
│   └── queries.js    纯函数查询层（Host 半与 MCP 共用）
├── bin/mcp.js        零依赖 stdio MCP server
├── data/             quotes.jsonl / people.jsonl
└── scripts/          数据构建与测试脚本
```

## 已知限制

- 语料目前 13 位人物 / 39 条名句，覆盖先秦到近现代；扩语料靠加 `data/*.jsonl`，不用改代码。
- `conversation.view` 的 tab 栏规则是「可用 View 少于两个时隐藏」，trajectory 默认关闭。
  所以语录墙同时挂在侧栏浮层里，保证任何情况下都够得着。
- 归属核查基于语料内的精确匹配与字符 bigram 相似度，能识别人尽皆知的误传，
  但不是学术级的引文考证。

## License

MIT
