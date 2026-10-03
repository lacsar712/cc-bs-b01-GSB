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

// 斜率一律由服务端拟合返回，页面只做显示格式化，禁止在浏览器私下计算。
function fmtSlope(s) {
  if (s === null || s === undefined) return "—";
  return (s > 0 ? "+" : "") + Number(s).toFixed(4);
}

function slopeArrow(s) {
  if (s > 0) return " ↑";
  if (s < 0) return " ↓";
  return "";
}

function slopeClass(s) {
  if (s > 0) return "slope-pos";
  if (s < 0) return "slope-neg";
  return "slope-flat";
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
  view: "readings",
};

// 趋势专页状态：窗宽、汇总、按窗重查明细
const trend = {
  window: 10,
  data: null,
  error: "",
  loading: false,
  details: {},
};

try {
  state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch {
  state.user = null;
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

async function loadTrend() {
  if (!state.token) return;
  const isWriter = state.user?.role === "writer";
  trend.loading = true;
  trend.error = "";
  try {
    // 复核员不传窗宽，由服务端给默认窗；测量员按所选窗宽查询
    const qs = isWriter ? `?window=${trend.window}` : "";
    trend.data = await api(`/api/trend/slopes${qs}`);
    trend.window = trend.data.window;
    trend.details = {};
  } catch (err) {
    trend.error = err.message || "加载趋势失败";
    trend.data = null;
  } finally {
    trend.loading = false;
    m.redraw();
  }
}

async function toggleTrendDetail(spanCode) {
  const cur = trend.details[spanCode];
  if (cur && cur.open) {
    cur.open = false;
    m.redraw();
    return;
  }
  trend.details[spanCode] = { open: true, loading: true, error: "", data: null };
  m.redraw();
  try {
    const data = await api(
      `/api/trend/points?span_code=${encodeURIComponent(spanCode)}&window=${trend.window}`
    );
    trend.details[spanCode] = { open: true, loading: false, error: "", data };
  } catch (err) {
    trend.details[spanCode] = {
      open: true,
      loading: false,
      error: err.message || "明细加载失败",
      data: null,
    };
  }
  m.redraw();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(loadReadings, 3000);
}

function trendDetailBlock(spanRow) {
  const det = trend.details[spanRow.span_code];
  if (!det || det.loading) return "按窗重查明细加载中…";
  if (det.error) return m("p.err", det.error);
  const d = det.data;
  if (!d || !d.points.length) return "窗内暂无办结点。";
  const consistent =
    d.slope === spanRow.slope && d.point_count === spanRow.point_count;
  return m("div", [
    m("table", [
      m("thead", [
        m("tr", [
          m("th", "窗内序号"),
          m("th", "编号"),
          m("th", "微应变"),
          m("th", "结论"),
          m("th", "办结时间"),
        ]),
      ]),
      m(
        "tbody",
        d.points.map((p) =>
          m("tr", { key: p.id }, [
            m("td", p.seq),
            m("td", p.id),
            m("td", p.microstrain),
            m("td", p.verdict || "—"),
            m("td", p.processed_at ? new Date(p.processed_at).toLocaleString() : "—"),
          ])
        )
      ),
    ]),
    m(
      "p.sub",
      { style: { marginBottom: 0 } },
      `按窗重查斜率：${fmtSlope(d.slope)}（${d.point_count} 点）· ` +
        (consistent ? "与汇总逐条对上 ✓" : "与汇总不一致，请以服务端为准")
    ),
  ]);
}

function trendView() {
  const isWriter = state.user?.role === "writer";
  const data = trend.data;
  const options = data?.window_options || [3, 5, 10, 20, 50];
  return m("div.card", [
    m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "趋势斜率专页"),
    m("div.trend-bar", [
      m("label", [
        "窗宽（每跨最近 N 条办结）",
        m(
          "select",
          {
            disabled: !isWriter,
            value: String(trend.window),
            onchange: (e) => {
              trend.window = parseInt(e.target.value, 10);
              loadTrend();
            },
          },
          options.map((w) =>
            m("option", { value: String(w), selected: w === trend.window }, `最近 ${w} 条`)
          )
        ),
      ]),
      isWriter
        ? m("span.hint", "测量员可调窗复核")
        : m("span.hint", "复核员只看，不可调窗"),
    ]),
    trend.error ? m("p.err", trend.error) : null,
    m("table", [
      m("thead", [
        m("tr", [
          m("th", "跨段"),
          m("th", "斜率（με/点）"),
          m("th", "点数"),
          m("th", "窗内编号"),
          m("th", "明细"),
        ]),
      ]),
      m(
        "tbody",
        data && data.spans.length
          ? data.spans.flatMap((row) => {
              const det = trend.details[row.span_code];
              const open = !!(det && det.open);
              const rows = [
                m("tr", { key: row.span_code }, [
                  m("td", row.span_code),
                  m(
                    "td",
                    { class: slopeClass(row.slope) },
                    row.slope === null
                      ? "—（点数不足）"
                      : fmtSlope(row.slope) + slopeArrow(row.slope)
                  ),
                  m("td", row.point_count),
                  m("td", `${row.first_id} ~ ${row.last_id}`),
                  m(
                    "td",
                    m(
                      "button.secondary",
                      {
                        type: "button",
                        onclick: () => toggleTrendDetail(row.span_code),
                      },
                      open ? "收起" : "明细"
                    )
                  ),
                ]),
              ];
              if (open) {
                rows.push(
                  m("tr.detail-row", { key: `${row.span_code}-detail` }, [
                    m("td", { colspan: 5 }, trendDetailBlock(row)),
                  ])
                );
              }
              return rows;
            })
          : [m("tr", m("td", { colspan: 5 }, trend.loading ? "加载中…" : "暂无办结数据"))]
      ),
    ]),
    m("div.trend-foot", [
      m(
        "button",
        { type: "button", disabled: trend.loading, onclick: loadTrend },
        trend.loading ? "刷新中…" : "刷新"
      ),
      m("p.sub.caliber", data?.caliber || "口径：斜率由服务端按办结点拟合。"),
    ]),
  ]);
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

    const isWriter = state.user?.role === "writer";

    return m("div.wrap", [
      m("div.topbar", [
        m("div", [
          m("h1", "桥梁应变班交台"),
          m("p.sub", "微应变 80～220 με 为合格，否则为越界。"),
        ]),
        m("div.nav", [
          m(
            "button.navbtn" + (state.view === "readings" ? ".active" : ""),
            {
              type: "button",
              onclick: () => {
                state.view = "readings";
              },
            },
            "读数列表"
          ),
          m(
            "button.navbtn" + (state.view === "trend" ? ".active" : ""),
            {
              type: "button",
              onclick: () => {
                state.view = "trend";
                if (!trend.data) loadTrend();
              },
            },
            "趋势斜率"
          ),
          m(
            "span",
            `${state.user?.username}（${isWriter ? "测量员" : "复核员"}）`
          ),
          m(
            "button.secondary",
            {
              type: "button",
              onclick: () => {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(USER_KEY);
                state.token = "";
                state.user = null;
                state.rows = [];
                state.view = "readings";
                trend.data = null;
                trend.details = {};
                if (state.timer) clearInterval(state.timer);
                m.redraw();
              },
            },
            "退出"
          ),
        ]),
      ]),
      state.view === "trend"
        ? trendView()
        : [
            isWriter
              ? m("div.card", [
                  m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
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
