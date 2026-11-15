// Browser half of dsh-classic-quotes.
//
// 三个挂载点：
//   sidebar.footer.action      —— 侧栏常驻的每日一条
//   conversation.chat.turnTail —— 每轮回复后的应时而变鼓励卡
//   conversation.view          —— 语录墙整页（人物卡片 + 生平详情）
//
// 数据全部来自 Host 半的只读接口 /plugins/dsh-classic-quotes/*，这里不内置任何语料，
// 所以改语料不需要重新打包。样式一律走 harness 主题 token（--dsw-alias-*）。
window.__ModuleLoader__.load({
  id: "dsh-classic-quotes",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    /* ───────────────────────── 工具 ───────────────────────── */

    function resolveIcon(nameModule, candidates) {
      if (nameModule === null || nameModule === undefined) return null;
      for (const name of candidates) {
        const component = nameModule[name];
        if (typeof component === "function") return component;
      }
      return null;
    }

    function icon(component, size) {
      return component === null ? null : React.createElement(component, { size });
    }

    const IconRefresh = resolveIcon(primitives, [
      "IconRefreshOutlineRegular", "IconRefreshOutlineMedium",
      "IconRefreshOutline16", "IconRefreshOutline14",
    ]);
    const IconSettings = resolveIcon(primitives, [
      "IconSettingsOutlineRegular", "IconSettingsOutlineMedium",
      "IconSettingsOutline16", "IconSettingsOutline14",
    ]);
    const IconClose = resolveIcon(primitives, [
      "IconCloseFillRegular", "IconCloseFillMedium", "IconCloseFill14",
    ]);

    const API_BASE = "/plugins/dsh-classic-quotes";
    const STORAGE_KEY = "dsh-classic-quotes:v1";
    const HISTORY_LIMIT = 12;

    const DEFAULT_SETTINGS = {
      sidebar: true,
      turnTail: true,
      recommend: true,
      mode: "daily",
    };

    /* ───────────────────────── 全局状态 ───────────────────────── */

    const store = {
      settings: loadSettings(),
      history: [],
      // signals 是「当前正在输入的这条消息」的信号，纯从文本推导，不跨消息累加。
      signals: {
        frustrated: false,
        completed: false,
        taskType: "chat",
        turns: 0,
        lastUserText: "",
      },
      // pending 是最近一次非空输入的快照。回合鼓励卡在助手回复之后才渲染，
      // 那时输入框已经被清空，所以不能靠「收到空文本」来重置信号——只能靠快照。
      pending: null,
    };

    function loadSettings() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          if (parsed !== null && typeof parsed === "object") {
            return Object.assign({}, DEFAULT_SETTINGS, parsed);
          }
        }
      } catch (err) {
        /* 隐私模式 / 存储被禁：退回默认值 */
      }
      return Object.assign({}, DEFAULT_SETTINGS);
    }

    function saveSettings() {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store.settings));
      } catch (err) {
        /* 存不住也不影响使用 */
      }
    }

    function rememberQuote(id) {
      if (!id) return;
      store.history = [id].concat(store.history.filter((x) => x !== id)).slice(0, HISTORY_LIMIT);
    }

    /* ───────────────────────── 信号识别 ───────────────────────── */

    const FRUSTRATED = [
      /怎么.{0,4}不行/, /还是.{0,4}(不|没|错)/, /又.{0,3}(挂|失败|报错|出错)/,
      /搞不定/, /卡住/, /崩溃/, /烦/,
      /why.{0,10}not.{0,6}work/i, /still.{0,10}(fail|error|broken)/i,
    ];
    const COMPLETED = [/搞定/, /好了/, /通过了/, /成功了/, /解决了/, /fixed/i, /works? now/i, /passed/i];
    const DEBUG = [/报错/, /错误/, /异常/, /失败/, /挂了/, /崩/, /bug/i, /error/i, /stack ?trace/i, /traceback/i];
    const WRITE = [/写/, /文档/, /注释/, /readme/i, /prose/i, /文案/, /润色/];
    const PLAN = [/计划/, /规划/, /方案/, /架构/, /路线/, /roadmap/i, /design/i];

    function detectTaskType(text) {
      if (DEBUG.some((re) => re.test(text))) return "debug";
      if (PLAN.some((re) => re.test(text))) return "plan";
      if (WRITE.some((re) => re.test(text))) return "write";
      return "chat";
    }

    /**
     * 旁听用户输入，累积推荐信号。
     *
     * DSH 的 user-text 契约：match(text, cursor, context) 必须返回候选节点或 undefined；
     * 返回 null 会被当成候选校验（node.start 不是整数）而抛 UserTextTransformError。
     * 我们不改写用户原文，所以永远返回 undefined。
     */
    function observeUserText(text) {
      try {
        if (typeof text !== "string" || text.trim() === "") return undefined;
        const signals = store.signals;
        // 纯推导：只根据当前文本判断，不跨消息累加，
        // 否则上一条抱怨过的消息会一直污染后面所有推荐。
        const completed = COMPLETED.some((re) => re.test(text));
        signals.turns += 1;
        signals.lastUserText = text.slice(0, 400);
        signals.taskType = detectTaskType(text);
        signals.completed = completed;
        signals.frustrated = !completed && FRUSTRATED.some((re) => re.test(text));
        store.pending = {
          frustrated: signals.frustrated,
          completed: signals.completed,
          taskType: signals.taskType,
          turns: signals.turns,
          lastUserText: signals.lastUserText,
        };
      } catch (err) {
        /* 观察失败不影响主流程 */
      }
      return undefined;
    }

    function currentSignals() {
      if (!store.settings.recommend) return {};
      const signals = store.pending ?? store.signals;
      const payload = { taskType: signals.taskType };
      if (signals.frustrated) payload.frustrated = true;
      if (signals.completed) payload.completed = true;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 5) payload.lateNight = true;
      return payload;
    }

    /* ───────────────────────── 数据访问 ───────────────────────── */

    function api(path, params) {
      const url = new URL(API_BASE + path, window.location.origin);
      if (params) {
        for (const key of Object.keys(params)) {
          if (params[key] === undefined || params[key] === null) continue;
          url.searchParams.set(key, String(params[key]));
        }
      }
      return fetch(url.toString(), { cache: "no-store" }).then((res) => {
        if (!res.ok) throw new Error("dsh-classic-quotes api " + res.status + " " + path);
        return res.json();
      });
    }

    function todayKey() {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    }

    function fetchDaily(options) {
      const opts = options || {};
      return api("/today", {
        date: todayKey(),
        mode: opts.mode || store.settings.mode,
        exclude: store.history.join(","),
        signals: JSON.stringify(opts.signals || currentSignals()),
      }).then((payload) => {
        rememberQuote(payload.quote.id);
        return payload;
      });
    }

    /* ───────────────────────── 样式 ───────────────────────── */

    const CSS = [
      ".dq-row{position:relative;box-sizing:border-box;margin:4px -4px;padding:8px 10px;border-radius:12px;font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#61666b);transition:background .15s ease;cursor:default}",
      ".dq-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
      ".dq-text{white-space:normal;overflow-wrap:anywhere;min-width:0;opacity:.78}",
      ".dq-meta{display:flex;align-items:center;gap:6px;margin-top:4px;min-width:0;font-size:12px;line-height:18px;opacity:.55}",
      ".dq-source{flex:1 1 auto;min-width:0;text-align:right;white-space:normal;overflow-wrap:anywhere}",
      ".dq-gear,.dq-x{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;opacity:0;transition:opacity .15s ease}",
      ".dq-row:hover .dq-gear,.dq-gear:focus-visible,.dq-gear[data-open=true]{opacity:1}",
      ".dq-gear:hover,.dq-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
      ".dq-pop{position:fixed;z-index:1000;box-sizing:border-box;width:300px;max-width:calc(100vw - 24px);overflow-y:auto;padding:12px 13px 13px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.12));font-family:var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary,#0f1115);font-size:13px;line-height:20px}",
      ".dq-pop-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}",
      ".dq-pop-title{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);opacity:.85}",
      ".dq-pop-q{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115)}",
      ".dq-pop-src{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);opacity:.8}",
      ".dq-pop-sec{margin-top:11px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}",
      ".dq-pop-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);opacity:.7;margin-bottom:3px}",
      ".dq-pop-body{font-size:12px;line-height:19px;color:var(--dsw-alias-label-primary,#0f1115);opacity:.86}",
      ".dq-pop-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}",
      ".dq-pop-chips span{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));color:var(--dsw-alias-label-secondary,#61666b)}",
      ".dq-row-line{display:flex;align-items:center;gap:8px;margin-top:9px}",
      ".dq-btn{flex:1 1 auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:8px;background:transparent;font-family:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#0f1115);cursor:pointer}",
      ".dq-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
      ".dq-toggle{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12px;color:var(--dsw-alias-label-secondary,#61666b)}",
      ".dq-toggle .dq-sp{flex:1}",
      ".dq-mini{padding:2px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:999px;background:transparent;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}",
      ".dq-mini[data-on=true]{background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-bg-layer-2,#fff);border-color:var(--dsw-alias-label-primary,#0f1115)}",
      ".dq-turn{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:11px;background:var(--dsw-alias-bg-layer-2,#fff);padding:10px 12px;margin:8px 0 4px;font-family:var(--dsw-font-family,inherit)}",
      ".dq-turn-head{display:flex;align-items:center;gap:7px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);opacity:.8}",
      ".dq-turn-badge{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));font-weight:550}",
      ".dq-turn-sp{flex:1}",
      ".dq-turn-btn{font-size:11px;line-height:16px;padding:2px 7px;border-radius:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}",
      ".dq-turn-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
      ".dq-turn-q{margin-top:6px;font-size:14.5px;line-height:24px;color:var(--dsw-alias-label-primary,#0f1115)}",
      ".dq-turn-src{margin-top:4px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);opacity:.75}",
      ".dq-turn-why{margin-top:8px;padding-top:7px;border-top:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.08));display:flex;flex-wrap:wrap;gap:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#61666b);opacity:.8}",
      ".dq-turn-why span{padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}",
      ".dq-wall{padding:20px 24px 28px;font-family:var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary,#0f1115)}",
      ".dq-wall-head{margin-bottom:14px}",
      ".dq-wall-head h3{margin:0;font-size:16px;line-height:24px;font-weight:650}",
      ".dq-wall-head p{margin:3px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);opacity:.8}",
      ".dq-wall-filters{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:9px 0 13px;margin-bottom:14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}",
      ".dq-wall-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:11px}",
      ".dq-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:12px;padding:12px 13px;background:var(--dsw-alias-bg-layer-2,#fff);cursor:pointer;display:flex;flex-direction:column;gap:8px}",
      ".dq-card:hover{border-color:var(--dsw-alias-label-secondary,#61666b)}",
      ".dq-card-q{font-size:13.5px;line-height:22px}",
      ".dq-card-src{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#61666b);opacity:.75}",
      ".dq-card-tags{display:flex;flex-wrap:wrap;gap:5px}",
      ".dq-card-tags span{font-size:10.5px;line-height:15px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));color:var(--dsw-alias-label-secondary,#61666b)}",
      ".dq-card-who{display:flex;align-items:center;gap:7px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));font-size:12px}",
      ".dq-card-who b{font-weight:600}",
      ".dq-card-who i{font-style:normal;color:var(--dsw-alias-label-secondary,#61666b);opacity:.7;font-size:11px}",
      ".dq-card-era{margin-left:auto;font-size:10.5px;line-height:15px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#61666b)}",
      ".dq-empty{font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary,#61666b);opacity:.8;padding:24px 0}",
      ".dq-pop-wide{width:min(700px,calc(100vw - 24px))}",
      ".dq-pop-scroll{max-height:min(64vh,560px);overflow-y:auto;overscroll-behavior:contain}",
      ".dq-pop .dq-wall{padding:2px 0 0}",
      ".dq-pop .dq-wall-head h3{font-size:14px;line-height:20px}",
    ].join("\n");

    const TAG_ID = "dsh-classic-quotes/dsh-classic-quotes.css";
    if (
      typeof document !== "undefined" &&
      document.querySelector('style[data-plugin-css="' + TAG_ID + '"]') === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-classic-quotes";
      tag.dataset.pluginCss = TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /* ───────────────────────── 浮层 ───────────────────────── */

    function Popover(props) {
      const [pos, setPos] = React.useState(null);
      const ref = React.useRef(null);

      const reposition = React.useCallback(() => {
        if (!ref.current || !props.anchorRef || !props.anchorRef.current) return;
        const anchor = props.anchorRef.current.getBoundingClientRect();
        const box = ref.current.getBoundingClientRect();
        // 高度不参与定位计算：内容是异步到的（生平先显示「载入中…」再变成整块），
        // 此刻量到的自身高度是过期的，算出来的 top 会把浮层推到视口外。
        // 改成「贴住锚点 + translateY」定位，高低用 max-height 兜底，永远不出屏。
        const spaceAbove = Math.round(anchor.top - 16);
        const spaceBelow = Math.round(window.innerHeight - anchor.bottom - 16);
        const above = spaceAbove >= 220 || spaceAbove >= spaceBelow;
        const maxHeight = Math.max(140, above ? spaceAbove : spaceBelow);
        const top = Math.round(above ? anchor.top - 8 : anchor.bottom + 8);
        const left = Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - box.width - 8));
        setPos((prev) =>
          prev !== null &&
          prev.left === left &&
          prev.top === top &&
          prev.above === above &&
          prev.maxHeight === maxHeight
            ? prev
            : { left, top, above, maxHeight },
        );
      }, [props.anchorRef]);

      React.useLayoutEffect(() => {
        if (!props.open) return;
        reposition();
        if (typeof ResizeObserver === "undefined" || !ref.current) return;
        const observer = new ResizeObserver(reposition);
        observer.observe(ref.current);
        if (props.anchorRef && props.anchorRef.current) observer.observe(props.anchorRef.current);
        return () => observer.disconnect();
      }, [props.open, reposition]);

      // 锚点在可滚动的侧栏里，滚动或改窗口大小时要跟着重算位置。
      React.useEffect(() => {
        if (!props.open) return;
        const onViewportChange = () => reposition();
        window.addEventListener("resize", onViewportChange);
        window.addEventListener("scroll", onViewportChange, true);
        return () => {
          window.removeEventListener("resize", onViewportChange);
          window.removeEventListener("scroll", onViewportChange, true);
        };
      }, [props.open, reposition]);

      React.useEffect(() => {
        if (!props.open) return;
        const onKey = (event) => {
          if (event.key === "Escape") props.onClose();
        };
        const onDown = (event) => {
          if (ref.current && ref.current.contains(event.target)) return;
          if (props.anchorRef && props.anchorRef.current && props.anchorRef.current.contains(event.target)) return;
          props.onClose();
        };
        window.addEventListener("keydown", onKey);
        window.addEventListener("pointerdown", onDown);
        return () => {
          window.removeEventListener("keydown", onKey);
          window.removeEventListener("pointerdown", onDown);
        };
      }, [props.open, props.onClose, props.anchorRef]);

      if (!props.open) return null;
      return React.createElement(
        "div",
        {
          ref,
          className: "dq-pop" + (props.className ? " " + props.className : ""),
          role: "dialog",
          style:
            pos === null
              ? { visibility: "hidden" }
              : {
                  left: pos.left,
                  top: pos.top,
                  maxHeight: pos.maxHeight + "px",
                  transform: pos.above ? "translateY(-100%)" : "none",
                },
        },
        props.children,
      );
    }

    /* ───────────────────────── 侧栏常驻 ───────────────────────── */

    function SidebarQuote() {
      const [payload, setPayload] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [popKind, setPopKind] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const anchorRef = React.useRef(null);

      const load = React.useCallback((mode) => {
        setError(null);
        fetchDaily({ mode: mode })
          .then(setPayload)
          .catch((err) => setError(err.message));
      }, []);

      React.useEffect(() => {
        load(store.settings.mode);
      }, [load]);

      const openDetail = React.useCallback(() => {
        if (!payload) return;
        setPopKind("detail");
        api("/biography", { name: payload.quote.author })
          .then(setDetail)
          .catch(() => setDetail(null));
      }, [payload]);

      const closePop = React.useCallback(() => {
        setPopKind(null);
        setDetail(null);
      }, []);

      if (error && !payload) {
        return React.createElement(
          "div",
          { className: "dq-row" },
          React.createElement("div", { className: "dq-text" }, "名人语录加载失败"),
        );
      }
      if (!payload) {
        return React.createElement(
          "div",
          { className: "dq-row" },
          React.createElement("div", { className: "dq-text", style: { opacity: 0.5 } }, "载入中…"),
        );
      }

      const quote = payload.quote;
      const author = payload.author || {};

      return React.createElement(
        "div",
        { ref: anchorRef, className: "dq-row" },
        React.createElement(
          "button",
          {
            type: "button",
            className: "dq-gear",
            "aria-label": "名人语录设置",
            "data-open": popKind === "settings" ? "true" : undefined,
            onClick: (e) => {
              e.stopPropagation();
              setPopKind(popKind === "settings" ? null : "settings");
            },
          },
          icon(IconSettings, 14),
        ),
        React.createElement(
          "div",
          {
            className: "dq-text",
            style: { cursor: "pointer" },
            title: "点击查看生平",
            onClick: openDetail,
          },
          quote.text,
        ),
        React.createElement(
          "div",
          { className: "dq-meta" },
          React.createElement(
            "span",
            { className: "dq-source" },
            "—— " + quote.author + "《" + quote.work + "》" +
              (author.years ? " · " + author.years : ""),
          ),
        ),
        React.createElement(
          Popover,
          { open: popKind === "settings", anchorRef, onClose: closePop },
          React.createElement(
            "div",
            { className: "dq-pop-head" },
            React.createElement("span", { className: "dq-pop-title" }, "名人语录"),
            React.createElement(
              "button",
              { type: "button", className: "dq-x", "aria-label": "关闭", onClick: closePop },
              icon(IconClose, 12),
            ),
          ),
          React.createElement("div", { className: "dq-pop-q" }, quote.text),
          React.createElement(
            "div",
            { className: "dq-pop-src" },
            "—— " + quote.author + "《" + quote.work + "》",
          ),
          React.createElement(
            "div",
            { className: "dq-pop-sec" },
            React.createElement("div", { className: "dq-pop-label" }, "刷新频率"),
            React.createElement(
              "div",
              { className: "dq-row-line" },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "dq-mini",
                  "data-on": store.settings.mode === "daily" ? "true" : undefined,
                  onClick: () => {
                    store.settings.mode = "daily";
                    saveSettings();
                    load("daily");
                  },
                },
                "每天",
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "dq-mini",
                  "data-on": store.settings.mode === "open" ? "true" : undefined,
                  onClick: () => {
                    store.settings.mode = "open";
                    saveSettings();
                    load("open");
                  },
                },
                "每次打开",
              ),
            ),
          ),
          React.createElement(
            "div",
            { className: "dq-pop-sec" },
            React.createElement("div", { className: "dq-pop-label" }, "推荐"),
            React.createElement(
              "div",
              { className: "dq-toggle" },
              React.createElement("span", null, "按聊天情况推荐"),
              React.createElement("span", { className: "dq-sp" }),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "dq-mini",
                  "data-on": store.settings.recommend ? "true" : undefined,
                  onClick: () => {
                    store.settings.recommend = !store.settings.recommend;
                    saveSettings();
                    load(store.settings.mode);
                  },
                },
                store.settings.recommend ? "开" : "关",
              ),
            ),
            React.createElement(
              "div",
              { className: "dq-toggle" },
              React.createElement("span", null, "回合鼓励卡"),
              React.createElement("span", { className: "dq-sp" }),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "dq-mini",
                  "data-on": store.settings.turnTail ? "true" : undefined,
                  onClick: () => {
                    store.settings.turnTail = !store.settings.turnTail;
                    saveSettings();
                  },
                },
                store.settings.turnTail ? "开" : "关",
              ),
            ),
          ),
          React.createElement(
            "div",
            { className: "dq-row-line" },
            React.createElement(
              "button",
              { type: "button", className: "dq-btn", onClick: () => load("open") },
              icon(IconRefresh, 14),
              "换一句",
            ),
          ),
          React.createElement(
            "div",
            { className: "dq-row-line" },
            React.createElement(
              "button",
              {
                type: "button",
                className: "dq-btn",
                onClick: () => setPopKind("wall"),
              },
              "浏览全部名句",
            ),
          ),
        ),
        React.createElement(
          Popover,
          {
            open: popKind === "wall",
            anchorRef,
            onClose: closePop,
            className: "dq-pop-wide",
          },
          React.createElement(
            "div",
            { className: "dq-pop-head" },
            React.createElement("span", { className: "dq-pop-title" }, "语录墙"),
            React.createElement(
              "button",
              { type: "button", className: "dq-x", "aria-label": "关闭", onClick: closePop },
              icon(IconClose, 12),
            ),
          ),
          React.createElement(
            "div",
            { className: "dq-pop-scroll" },
            React.createElement(QuoteWall, null),
          ),
        ),
        React.createElement(
          Popover,
          { open: popKind === "detail", anchorRef, onClose: closePop },
          React.createElement(
            "div",
            { className: "dq-pop-head" },
            React.createElement(
              "span",
              { className: "dq-pop-title" },
              (author.name || quote.author) + (author.years ? " · " + author.years : ""),
            ),
            React.createElement(
              "button",
              { type: "button", className: "dq-x", "aria-label": "关闭", onClick: closePop },
              icon(IconClose, 12),
            ),
          ),
          detail
            ? React.createElement(
                "div",
                null,
                React.createElement("div", { className: "dq-pop-label" }, "生平"),
                React.createElement("div", { className: "dq-pop-body" }, detail.description || "—"),
                React.createElement(
                  "div",
                  { className: "dq-pop-sec" },
                  React.createElement("div", { className: "dq-pop-label" }, "代表作"),
                  React.createElement(
                    "div",
                    { className: "dq-pop-chips" },
                    (detail.works || []).map((w) => React.createElement("span", { key: w }, w)),
                  ),
                ),
                React.createElement(
                  "div",
                  { className: "dq-pop-sec" },
                  React.createElement("div", { className: "dq-pop-label" }, "名句"),
                  React.createElement(
                    "div",
                    { className: "dq-pop-chips" },
                    (detail.quotes || []).map((q) =>
                      React.createElement("span", { key: q.id }, q.text),
                    ),
                  ),
                ),
                React.createElement(
                  "div",
                  { className: "dq-pop-sec" },
                  React.createElement("div", { className: "dq-pop-body" }, "数据来源：" + detail.source),
                ),
              )
            : React.createElement("div", { className: "dq-pop-body" }, "载入中…"),
        ),
      );
    }

    /* ───────────────────────── 回合鼓励卡 ───────────────────────── */

    function TurnTail(props) {
      const [payload, setPayload] = React.useState(null);

      const load = React.useCallback(() => {
        fetchDaily({ mode: "open" })
          .then(setPayload)
          .catch(() => setPayload(null));
      }, []);

      React.useEffect(() => {
        if (!store.settings.turnTail) return;
        load();
      }, [load, props.turn]);

      if (!store.settings.turnTail || !payload) return null;

      const quote = payload.quote;
      const author = payload.author || {};

      return React.createElement(
        "div",
        { className: "dq-turn" },
        React.createElement(
          "div",
          { className: "dq-turn-head" },
          React.createElement("span", { className: "dq-turn-badge" }, "应时而变"),
          React.createElement("span", null, payload.reason || "每日一条"),
          React.createElement("span", { className: "dq-turn-sp" }),
          React.createElement(
            "button",
            { type: "button", className: "dq-turn-btn", onClick: load },
            "换一句",
          ),
        ),
        React.createElement("div", { className: "dq-turn-q" }, quote.text),
        React.createElement(
          "div",
          { className: "dq-turn-src" },
          "—— " + quote.author + "《" + quote.work + "》" +
            (author.years ? " · " + author.years : ""),
        ),
        payload.matched && payload.matched.length > 0
          ? React.createElement(
              "div",
              { className: "dq-turn-why" },
              React.createElement("span", { key: "m" }, "匹配主题：" + payload.matched.join("、")),
              React.createElement(
                "span",
                { key: "v" },
                quote.verification === "curated" ? "出处已核查 ✓" : "出处待核 ⚠",
              ),
            )
          : null,
      );
    }

    /* ───────────────────────── 语录墙 ───────────────────────── */

    function QuoteWall() {
      const [people, setPeople] = React.useState([]);
      const [quotes, setQuotes] = React.useState([]);
      const [era, setEra] = React.useState("");
      const [topic, setTopic] = React.useState("");
      const [selected, setSelected] = React.useState(null);

      React.useEffect(() => {
        api("/people")
          .then((payload) => setPeople(payload.people || []))
          .catch(() => setPeople([]));
        api("/quotes")
          .then((payload) => setQuotes(payload.quotes || []))
          .catch(() => setQuotes([]));
      }, []);

      const eras = Array.from(new Set(people.map((p) => p.era).filter(Boolean)));
      const topics = Array.from(new Set(quotes.reduce((acc, q) => acc.concat(q.topics || []), [])));

      const visible = quotes.filter((q) => {
        if (era && q.era !== era) return false;
        if (topic && (q.topics || []).indexOf(topic) < 0) return false;
        return true;
      });

      const yearOf = (person) => {
        if (!person || person.birth == null || person.death == null) return null;
        return person.birth + "–" + person.death;
      };

      return React.createElement(
        "div",
        { className: "dq-wall" },
        React.createElement(
          "div",
          { className: "dq-wall-head" },
          React.createElement("h3", null, "语录墙"),
          React.createElement(
            "p",
            null,
            people.length + " 位人物 · " + visible.length + " 条名句 · 每条出处可定位到具体作品",
          ),
        ),
        React.createElement(
          "div",
          { className: "dq-wall-filters" },
          React.createElement(
            "button",
            {
              type: "button",
              className: "dq-mini",
              "data-on": era === "" ? "true" : undefined,
              onClick: () => setEra(""),
            },
            "全部时代",
          ),
          eras.map((e) =>
            React.createElement(
              "button",
              {
                type: "button",
                className: "dq-mini",
                "data-on": era === e ? "true" : undefined,
                onClick: () => setEra(e),
                key: e,
              },
              e,
            ),
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "dq-mini",
              "data-on": topic === "" ? "true" : undefined,
              onClick: () => setTopic(""),
            },
            "全部主题",
          ),
          topics.map((t) =>
            React.createElement(
              "button",
              {
                type: "button",
                className: "dq-mini",
                "data-on": topic === t ? "true" : undefined,
                onClick: () => setTopic(t),
                key: t,
              },
              t,
            ),
          ),
        ),
        visible.length === 0
          ? React.createElement("div", { className: "dq-empty" }, "没有符合条件的名句。")
          : React.createElement(
              "div",
              { className: "dq-wall-grid" },
              visible.map((q) => {
                const person = people.find((p) => p.qid === q.author_qid);
                const years = yearOf(person);
                return React.createElement(
                  "div",
                  { className: "dq-card", key: q.id, onClick: () => setSelected({ quote: q, person }) },
                  React.createElement("div", { className: "dq-card-q" }, q.text),
                  React.createElement("div", { className: "dq-card-src" }, "—— " + q.work),
                  React.createElement(
                    "div",
                    { className: "dq-card-tags" },
                    (q.topics || []).map((t) => React.createElement("span", { key: t }, t)),
                  ),
                  React.createElement(
                    "div",
                    { className: "dq-card-who" },
                    React.createElement("b", null, q.author),
                    years ? React.createElement("i", null, years) : null,
                    React.createElement("span", { className: "dq-card-era" }, q.era || ""),
                  ),
                );
              }),
            ),
        selected
          ? React.createElement(
              "div",
              { className: "dq-pop", role: "dialog", style: { position: "static", width: "auto", marginTop: "14px" } },
              React.createElement(
                "div",
                { className: "dq-pop-head" },
                React.createElement(
                  "span",
                  { className: "dq-pop-title" },
                  (selected.person ? selected.person.name : selected.quote.author) +
                    (yearOf(selected.person) ? " · " + yearOf(selected.person) : ""),
                ),
                React.createElement(
                  "button",
                  { type: "button", className: "dq-x", "aria-label": "关闭", onClick: () => setSelected(null) },
                  icon(IconClose, 12),
                ),
              ),
              React.createElement("div", { className: "dq-pop-q" }, selected.quote.text),
              React.createElement(
                "div",
                { className: "dq-pop-src" },
                "—— " + selected.quote.author + "《" + selected.quote.work + "》",
              ),
              selected.person && selected.person.description
                ? React.createElement(
                    "div",
                    { className: "dq-pop-sec" },
                    React.createElement("div", { className: "dq-pop-label" }, "生平"),
                    React.createElement("div", { className: "dq-pop-body" }, selected.person.description),
                  )
                : null,
              selected.person
                ? React.createElement(
                    "div",
                    { className: "dq-pop-sec" },
                    React.createElement("div", { className: "dq-pop-label" }, "代表作"),
                    React.createElement(
                      "div",
                      { className: "dq-pop-chips" },
                      (selected.person.works || []).map((w) => React.createElement("span", { key: w }, w)),
                    ),
                  )
                : null,
            )
          : null,
      );
    }

    /* ───────────────────────── 注册 ───────────────────────── */

    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register(
          { name: "sidebar.footer.action", id: "dsh-classic-quotes-sidebar", order: -100 },
          SidebarQuote,
        ),
      );

      ctx.slots.inject("conversation.chat.turnTail", () =>
        ctx.slots.register(
          { name: "conversation.chat.turnTail", id: "dsh-classic-quotes-turntail", order: 50 },
          TurnTail,
        ),
      );

      ctx.slots.inject("conversation.view", () =>
        ctx.slots.register(
          {
            name: "conversation.view",
            id: "dsh-classic-quotes-wall",
            order: 20,
            label: () => "语录墙",
          },
          QuoteWall,
        ),
      );

      // 旁听用户输入，累积推荐信号；该 API 不存在时降级为纯每日一条
      try {
        ctx.inject(["uiConversation"], (uictx) => {
          try {
            uictx.uiConversation.userText.register({
              id: "dsh-classic-quotes-observer",
              order: 1000,
              match: (text) => observeUserText(text),
            });
          } catch (err) {
            /* ignore */
          }
        });
      } catch (err) {
        /* ignore */
      }
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports._test = {
      DEFAULT_SETTINGS,
      detectTaskType,
      observeUserText,
      currentSignals,
    };
    return module.exports;
  },
});
