"""趋势斜率纯逻辑测试：不依赖数据库，可用系统 python3 直接跑。

    python3 test_trend.py

模拟 _WINDOWED_DONE_SQL 的截窗语义（每跨最近 N 条 done，按 id 升序拟合），
并复现验收场景：连续抬高三笔办结后斜率明显为正；窗收到这批之外斜率回落或空。
"""

from trend import (
    DEFAULT_WINDOW,
    MIN_POINTS,
    WINDOW_OPTIONS,
    fit_slope,
    normalize_window,
    round_slope,
    summarize_spans,
)


def window_rows(readings, window):
    """模拟服务端 SQL：未办结不入窗，每跨取最近 N 条 done，按 span_code, id 排序。"""
    done = [r for r in readings if r["status"] == "done"]
    by_span = {}
    for r in done:
        by_span.setdefault(r["span_code"], []).append(r)
    out = []
    for span_code, rows in by_span.items():
        latest = sorted(rows, key=lambda r: r["id"], reverse=True)[:window]
        out.extend(latest)
    return sorted(out, key=lambda r: (r["span_code"], r["id"]))


def slopes_by_span(readings, window):
    return {s["span_code"]: s for s in summarize_spans(window_rows(readings, window))}


def test_fit_slope_basics():
    assert fit_slope([]) is None
    assert fit_slope([150.0]) is None  # 点数不足为空
    assert fit_slope([210.0, 210.0, 210.0]) == 0.0  # 平台拟合为零
    assert abs(fit_slope([0.0, 1.0, 2.0, 3.0]) - 1.0) < 1e-9  # 线性精确
    assert abs(fit_slope([10.0, 7.0, 4.0]) + 3.0) < 1e-9  # 负斜率
    # 与最小二乘公式交叉验证：y = 2x + 5
    assert abs(fit_slope([5.0, 7.0, 9.0, 11.0, 13.0]) - 2.0) < 1e-9


def test_normalize_window():
    assert normalize_window(None) == DEFAULT_WINDOW
    assert normalize_window("") == DEFAULT_WINDOW
    for w in WINDOW_OPTIONS:
        assert normalize_window(str(w)) == w
    assert normalize_window("7") is None  # 非档位
    assert normalize_window("abc") is None
    assert normalize_window("10.5") is None
    assert MIN_POINTS >= 2


def mk(rid, span, value, status="done"):
    return {"id": rid, "span_code": span, "microstrain": value, "status": status}


def test_acceptance_raise_three_then_narrow():
    readings = [
        mk(1, "跨中S1", 150.0),  # 种子：平稳基线
        mk(2, "支座S2", 40.0),
    ]
    # 未办结点不入拟合：三笔 pending 时跨中S1 仍只有 1 个办结点，斜率为空
    pending = readings + [mk(3, "跨中S1", 210.0, "pending"),
                          mk(4, "跨中S1", 210.0, "processing"),
                          mk(5, "跨中S1", 210.0, "pending")]
    spans = slopes_by_span(pending, 10)
    assert spans["跨中S1"]["slope"] is None
    assert spans["跨中S1"]["point_count"] == 1

    # 三笔办结后：窗 10 内为 [150, 210, 210, 210]，斜率明显为正
    raised = readings + [mk(3, "跨中S1", 210.0),
                         mk(4, "跨中S1", 210.0),
                         mk(5, "跨中S1", 210.0)]
    spans = slopes_by_span(raised, 10)
    s1 = spans["跨中S1"]
    assert s1["point_count"] == 4
    assert s1["slope"] is not None and s1["slope"] > 5  # 明显为正（=18）
    assert s1["first_id"] == 1 and s1["last_id"] == 5

    # 窗收到这批之外（窗 3 只含抬升后的平台）：斜率回落到 0
    spans = slopes_by_span(raised, 3)
    assert spans["跨中S1"]["slope"] == 0.0
    assert spans["跨中S1"]["point_count"] == 3

    # 单点跨段：任意窗宽斜率皆空
    assert slopes_by_span(raised, 10)["支座S2"]["slope"] is None
    assert slopes_by_span(raised, 3)["支座S2"]["slope"] is None

    # 抬升批之后再有新读数，小窗把抬升批挤出窗外：斜率回落
    after = raised + [mk(6, "跨中S1", 152.0), mk(7, "跨中S1", 151.0)]
    spans = slopes_by_span(after, 3)
    assert spans["跨中S1"]["slope"] is not None and spans["跨中S1"]["slope"] < 0


def test_summary_matches_detail_requery():
    """专页汇总斜率必须与按窗重查明细逐条对上（同一批点、同一拟合）。"""
    readings = [
        mk(1, "跨中S1", 150.0),
        mk(2, "跨中S1", 148.0),
        mk(3, "跨中S1", 210.0),
        mk(4, "跨中S1", 212.0),
        mk(5, "跨中S1", 211.0),
        mk(6, "支座S2", 40.0),
        mk(7, "支座S2", 90.0),
    ]
    for window in WINDOW_OPTIONS:
        rows = window_rows(readings, window)
        for summary in summarize_spans(rows):
            detail = [r for r in rows if r["span_code"] == summary["span_code"]]
            detail = sorted(detail, key=lambda r: r["id"])
            values = [float(r["microstrain"]) for r in detail]
            assert len(detail) == summary["point_count"]
            assert round_slope(fit_slope(values)) == summary["slope"]
            assert detail[0]["id"] == summary["first_id"]
            assert detail[-1]["id"] == summary["last_id"]


def test_window_truncates_to_latest():
    readings = [mk(i, "跨中S1", 100.0 + i) for i in range(1, 8)]
    spans = slopes_by_span(readings, 3)
    s = spans["跨中S1"]
    assert s["point_count"] == 3
    assert s["first_id"] == 5 and s["last_id"] == 7  # 留下最新三条


if __name__ == "__main__":
    test_fit_slope_basics()
    test_normalize_window()
    test_acceptance_raise_three_then_narrow()
    test_summary_matches_detail_requery()
    test_window_truncates_to_latest()
    print("全部趋势斜率测试通过")
