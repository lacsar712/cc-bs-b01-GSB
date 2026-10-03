import m from "mithril";

const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function verdictClass(verdict, status) {
  if (verdict === "合格") return "tag pass";
  if (verdict === "越界") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

// 趋势标签只是服务端斜率的符号展示，不做任何数值计算
function trendTagClass(slope) {
  if (slope === null || slope === undefined) return "trendtag none";
  if (slope > 0) return "trendtag up";
  if (slope < 0) return "trendtag down";
  return "trendtag flat";
}

function trendTagText(slope) {
  if (slope === null || slope === undefined) return "数据不足";
  if (slope > 0) return "上升";
  if (slope < 0) return "下降";
  return "持平";
}

function fmtTime(iso) {
  if (!iso) return "—";
  return String(iso).replace("T", " ").slice(0, 19);
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  rows: [],
  error: "",
  msg: "",
  loading: false,
  timer: null,
  view: "readings", // readings | trend
  trend: {
    window: 10,
    loading: false,
    error: "",
    data: null, // 服务端 /api/trends/slopes 原样返回
    detailSpan: "",
    detail: null, // 服务端 /api/trends/detail 原样返回
  },
};

try {
  state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch {
  state.user = null;
}

function isWriter() {
  return state.user?.role === "writer";
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

async function loadReadings() {
  if (!state.token) return;
  try {
    state.rows = await api("/api/readings");
    state.error = "";
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
  m.redraw();
}

// 趋势斜率：只向服务端取拟合结果，页面不自行计算
async function loadTrends() {
  if (!state.token) return;
  state.trend.loading = true;
  try {
    // 复核员只看默认窗宽，不带 window 参数；测量员带当前窗宽
    const qs = isWriter() ? `?window=${state.trend.window}` : "";
    state.trend.data = await api(`/api/trends/slopes${qs}`);
    state.trend.error = "";
    if (state.trend.detailSpan) {
      await loadTrendDetail(state.trend.detailSpan, { keepOpen: true });
    }
  } catch (err) {
    state.trend.error = err.message || "加载趋势失败";
  } finally {
    state.trend.loading = false;
  }
  m.redraw();
}

async function loadTrendDetail(spanCode, opts = {}) {
  if (!opts.keepOpen && state.trend.detailSpan === spanCode) {
    state.trend.detailSpan = "";
    state.trend.detail = null;
    m.redraw();
    return;
  }
  state.trend.detailSpan = spanCode;
  try {
    const qs = isWriter() ? `window=${state.trend.window}&` : "";
    state.trend.detail = await api(
      `/api/trends/detail?${qs}span_code=${encodeURIComponent(spanCode)}`
    );
  } catch (err) {
    state.trend.error = err.message || "加载明细失败";
  }
  m.redraw();
}

function refreshActive() {
  if (state.view === "trend") {
    loadTrends();
  } else {
    loadReadings();
  }
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(refreshActive, 3000);
}

function switchView(view) {
  if (state.view === view) return;
  state.view = view;
  if (view === "trend") {
    loadTrends();
  } else {
    loadReadings();
  }
}

function resetSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  state.token = "";
  state.user = null;
  state.rows = [];
  state.view = "readings";
  state.trend.data = null;
  state.trend.detail = null;
  state.trend.detailSpan = "";
  if (state.timer) clearInterval(state.timer);
  m.redraw();
}

function trendDetailView() {
  const d = state.trend.detail;
  if (!d) return null;
  return m("div.detailbox", [
    m("div.detailhead", [
      m("strong", `明细核对：${d.span_code} · 窗宽 ${d.window}`),
      m(
        "span",
        `窗内 ${d.points} 条 · 服务端拟合斜率：${
          d.slope === null ? "空" : `${d.slope} με/点`
        }`
      ),
      m(
        "button.secondary",
        {
          type: "button",
          onclick: () => {
            state.trend.detailSpan = "";
            state.trend.detail = null;
          },
        },
        "收起"
      ),
    ]),
    m("table", [
      m("thead", [
        m("tr", [
          m("th", "序号"),
          m("th", "编号"),
          m("th", "微应变"),
          m("th", "结论"),
          m("th", "办结时间"),
        ]),
      ]),
      m(
        "tbody",
        d.rows.length
          ? d.rows.map((r) =>
              m("tr", { key: r.id }, [
                m("td", r.seq),
                m("td", r.id),
                m("td", r.microstrain),
                m(
                  "td",
                  r.verdict
                    ? m("span", { class: verdictClass(r.verdict, "done") }, r.verdict)
                    : "—"
                ),
                m("td", fmtTime(r.processed_at)),
              ])
            )
          : [m("tr", m("td", { colspan: 5 }, "窗内无办结点"))]
      ),
    ]),
    m(
      "p.caliber",
      "上表即本窗拟合所用的全部办结点；斜率由服务端按序号 1..n 最小二乘拟合，与主表逐条对应。"
    ),
  ]);
}

function trendView() {
  const t = state.trend;
  const data = t.data;
  const editable = isWriter();
  const windows = data?.allowed_windows || [2, 5, 10, 20, 50];
  const curWindow = data?.window ?? t.window;
  return [
    m("div.card", { key: "trend-filter" }, [
      m("div.row", [
        m("label", [
          "窗宽（每跨最近办结条数）",
          m(
            "select",
            {
              disabled: !editable,
              value: String(curWindow),
              onchange: (e) => {
                t.window = parseInt(e.target.value, 10);
                loadTrends();
              },
            },
            windows.map((w) =>
              m(
                "option",
                { value: String(w), selected: w === curWindow },
                `最近 ${w} 条`
              )
            )
          ),
        ]),
        editable
          ? m("span.hint", "测量员可调窗复核")
          : m("span.hint", "复核侧只看，不可调窗（默认窗宽）"),
      ]),
    ]),
    m("div.card", { key: "trend-list" }, [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "各跨段斜率"),
      t.error ? m("p.err", t.error) : null,
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "跨段"),
            m("th", "拟合点数"),
            m("th", "斜率（με/点）"),
            m("th", "趋势"),
            m("th", "窗内办结时间"),
          ]),
        ]),
        m(
          "tbody",
          data && data.spans.length
            ? data.spans.map((s) =>
                m(
                  "tr",
                  {
                    key: s.span_code,
                    class:
                      state.trend.detailSpan === s.span_code
                        ? "spanrow open"
                        : "spanrow",
                    title: "点击查看本窗拟合明细",
                    onclick: () => loadTrendDetail(s.span_code),
                  },
                  [
                    m("td", s.span_code),
                    m("td", s.points),
                    // 服务端拟合值，原样展示，页面不改动
                    m("td", s.slope === null ? "空" : s.slope),
                    m("td", m("span", { class: trendTagClass(s.slope) }, trendTagText(s.slope))),
                    m(
                      "td",
                      `${fmtTime(s.first_processed_at)} ~ ${fmtTime(s.last_processed_at)}`
                    ),
                  ]
                )
              )
            : [m("tr", m("td", { colspan: 5 }, "暂无办结数据"))]
        ),
      ]),
      trendDetailView(),
      m("div.trend-foot", [
        m(
          "button",
          { type: "button", disabled: t.loading, onclick: () => loadTrends() },
          t.loading ? "刷新中…" : "刷新"
        ),
        m("p.caliber", data?.caliber || ""),
      ]),
    ]),
  ];
}

const App = {
  oninit() {
    loadReadings();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) {
      return m(
        "div.wrap",
        [
          m("h1", "桥梁应变班交台"),
          m(
            "p.sub",
            "测量员提交跨段编号与微应变读数，后台工人认领队列后判定合格或越界。"
          ),
          m("div.card", [
            m(
              "form",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  state.error = "";
                  state.loading = true;
                  try {
                    const data = await api("/api/auth/login", {
                      method: "POST",
                      body: JSON.stringify(state.loginForm),
                    });
                    state.token = data.access_token;
                    state.user = { username: data.username, role: data.role };
                    localStorage.setItem(TOKEN_KEY, state.token);
                    localStorage.setItem(USER_KEY, JSON.stringify(state.user));
                    await loadReadings();
                    startPolling();
                  } catch {
                    state.error = "用户名或密码错误";
                  } finally {
                    state.loading = false;
                    m.redraw();
                  }
                },
              },
              [
                m("div.row", [
                  m("label", [
                    "用户名",
                    m("input", {
                      value: state.loginForm.username,
                      oninput: (e) => {
                        state.loginForm.username = e.target.value;
                      },
                    }),
                  ]),
                  m("label", [
                    "密码",
                    m("input", {
                      type: "password",
                      value: state.loginForm.password,
                      oninput: (e) => {
                        state.loginForm.password = e.target.value;
                      },
                    }),
                  ]),
                  m(
                    "button",
                    { type: "submit", disabled: state.loading },
                    "登录"
                  ),
                ]),
                state.error ? m("p.err", state.error) : null,
              ]
            ),
            m(
              "p.sub",
              { style: { marginBottom: 0 } },
              "测量员 surveyor / surv123456 · 复核员 reviewer / rev123456"
            ),
          ]),
        ]
      );
    }

    const writer = isWriter();

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div", [
          `${state.user?.username}（${writer ? "测量员" : "复核员"}） `,
          m(
            "button.secondary",
            { type: "button", onclick: resetSession },
            "退出"
          ),
        ]),
      ]),
      m("div.nav", [
        m(
          "button",
          {
            type: "button",
            class: state.view === "readings" ? "navbtn active" : "navbtn",
            onclick: () => switchView("readings"),
          },
          "读数列表"
        ),
        m(
          "button",
          {
            type: "button",
            class: state.view === "trend" ? "navbtn active" : "navbtn",
            onclick: () => switchView("trend"),
          },
          "趋势斜率"
        ),
      ]),
      state.view === "trend"
        ? trendView()
        : [
            writer
              ? m("div.card", [
                  m(
                    "h2",
                    { style: { marginTop: 0, fontSize: "1.1rem" } },
                    "提交读数"
                  ),
                  m(
                    "form",
                    {
                      onsubmit: async (e) => {
                        e.preventDefault();
                        state.error = "";
                        state.msg = "";
                        state.loading = true;
                        try {
                          const data = await api("/api/readings", {
                            method: "POST",
                            body: JSON.stringify({
                              span_code: state.submitForm.span_code,
                              microstrain: parseFloat(state.submitForm.microstrain),
                            }),
                          });
                          state.msg = data.message || "已提交";
                          state.submitForm = { span_code: "", microstrain: "" };
                          await loadReadings();
                        } catch (err) {
                          state.error = err.message || "提交失败";
                        } finally {
                          state.loading = false;
                          m.redraw();
                        }
                      },
                    },
                    [
                      m("div.row", [
                        m("label", [
                          "跨段编号",
                          m("input", {
                            required: true,
                            placeholder: "例如 跨中S3",
                            value: state.submitForm.span_code,
                            oninput: (e) => {
                              state.submitForm.span_code = e.target.value;
                            },
                          }),
                        ]),
                        m("label", [
                          "微应变（με）",
                          m("input", {
                            required: true,
                            type: "number",
                            step: "0.1",
                            value: state.submitForm.microstrain,
                            oninput: (e) => {
                              state.submitForm.microstrain = e.target.value;
                            },
                          }),
                        ]),
                        m(
                          "button",
                          { type: "submit", disabled: state.loading },
                          "提交"
                        ),
                      ]),
                      state.error ? m("p.err", state.error) : null,
                      state.msg ? m("p.ok", state.msg) : null,
                    ]
                  ),
                ])
              : null,
            m("div.card", [
              m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
              m("table", [
                m("thead", [
                  m("tr", [
                    m("th", "编号"),
                    m("th", "跨段"),
                    m("th", "微应变"),
                    m("th", "结论"),
                    m("th", "说明"),
                    m("th", "状态"),
                    m("th", "提交人"),
                  ]),
                ]),
                m(
                  "tbody",
                  state.rows.length
                    ? state.rows.map((r) =>
                        m("tr", { key: r.id }, [
                          m("td", r.id),
                          m("td", r.span_code),
                          m("td", r.microstrain),
                          m("td", [
                            m(
                              "span",
                              { class: verdictClass(r.verdict, r.status) },
                              displayVerdict(r)
                            ),
                          ]),
                          m("td", r.reason || "—"),
                          m("td", r.status),
                          m("td", r.created_by),
                        ])
                      )
                    : [m("tr", m("td", { colspan: 7 }, "暂无数据"))]
                ),
              ]),
            ]),
          ],
    ]);
  },
};

export default App;
