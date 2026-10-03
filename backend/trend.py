"""趋势斜率：由服务端按办结(done)读数最小二乘拟合。

页面只展示本模块算出的结果，禁止浏览器私下拟合或改数。
本模块刻意保持零第三方依赖，便于单测与复核。
"""

# 可选窗宽档位（最近 N 条办结读数）
WINDOW_OPTIONS = (3, 5, 10, 20, 50)
DEFAULT_WINDOW = 10
# 拟合最少点数：不足则斜率为空
MIN_POINTS = 2


def normalize_window(raw) -> int | None:
    """解析窗宽参数。缺省给默认档；非法值返回 None（调用方应回 400）。"""
    if raw is None or str(raw).strip() == "":
        return DEFAULT_WINDOW
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if value not in WINDOW_OPTIONS:
        return None
    return value


def fit_slope(microstrains) -> float | None:
    """最小二乘拟合斜率（με/点）。

    x 取窗内办结先后序号 0..n-1（按 id 升序），y 为微应变。
    点数不足 MIN_POINTS 时返回 None，页面显示为空。
    """
    n = len(microstrains)
    if n < MIN_POINTS:
        return None
    mean_x = (n - 1) / 2.0
    mean_y = sum(microstrains) / n
    num = 0.0
    den = 0.0
    for x, y in enumerate(microstrains):
        dx = x - mean_x
        num += dx * (y - mean_y)
        den += dx * dx
    if den == 0:
        return None
    return num / den


def round_slope(slope: float | None) -> float | None:
    """统一保留 6 位小数；汇总与明细走同一舍入口径，保证逐条对上。"""
    return round(slope, 6) if slope is not None else None


def caliber_text(window: int) -> str:
    return (
        f"口径：每跨取最近 {window} 条已办结(done)读数，按办结先后编号 0..n-1，"
        "由服务端最小二乘拟合斜率（με/点）；未办结读数不入拟合；"
        "窗内点数不足 2 时斜率为空。页面只展示服务端结果，不自行计算。"
    )


def summarize_spans(rows) -> list[dict]:
    """把窗内办结点（已按 span_code, id 升序排好）汇总成各跨斜率行。

    rows 由 SQL 按窗宽截好（每跨最近 N 条 done）。返回按跨段编号排序的列表。
    """
    spans: dict[str, list[dict]] = {}
    for row in rows:
        spans.setdefault(row["span_code"], []).append(row)
    out = []
    for span_code in sorted(spans):
        pts = spans[span_code]
        values = [float(p["microstrain"]) for p in pts]
        out.append(
            {
                "span_code": span_code,
                "point_count": len(pts),
                "slope": round_slope(fit_slope(values)),
                "first_id": pts[0]["id"],
                "last_id": pts[-1]["id"],
            }
        )
    return out
