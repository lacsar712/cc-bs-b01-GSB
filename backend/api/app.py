import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "surveyor": {"role": "writer", "password_hash": pwd.hash("surv123456")},
    "reviewer": {"role": "reader", "password_hash": pwd.hash("rev123456")},
}

app = Sanic("bridge-strain-shift")


def _auth_header(request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def _require_user(request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        return None
    return user


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


@app.before_server_start
async def setup(_app, _loop):
    pool = await create_pool()
    _app.ctx.pool = pool
    await ensure_schema(pool)
    await seed_if_empty(pool)


@app.after_server_stop
async def teardown(_app, _loop):
    pool = _app.ctx.pool
    if pool:
        await pool.close()


@app.get("/api/health")
async def health(_request):
    return sanic_json({"status": "ok", "service": "bridge-strain-shift"})


@app.post("/api/auth/login")
async def login(request):
    body = request.json or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return sanic_json({"detail": "用户名或密码错误"}, status=401)
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return sanic_json(
        {"access_token": token, "username": username, "role": user["role"]}
    )


@app.get("/api/readings")
async def list_readings(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, span_code, microstrain, verdict, reason, status,
                       created_by, created_at, processed_at
                FROM strain_readings
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "span_code": r["span_code"],
                "microstrain": r["microstrain"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": _iso(r["created_at"]),
                "processed_at": _iso(r["processed_at"]),
            }
        )
    return sanic_json(out)


@app.post("/api/readings")
async def create_reading(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可提交应变读数"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        microstrain = float(body.get("microstrain"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "微应变必须是数字"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO strain_readings (span_code, microstrain, status, created_by, created_at)
                VALUES (%s, %s, 'pending', %s, now())
                RETURNING id, span_code, microstrain, verdict, reason, status,
                          created_by, created_at, processed_at
                """,
                (span_code, microstrain, user["username"]),
            )
            row = await cur.fetchone()
        await conn.commit()

    return sanic_json(
        {
            "id": row["id"],
            "span_code": row["span_code"],
            "microstrain": row["microstrain"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": _iso(row["created_at"]),
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


# ---------- 趋势斜率专页 ----------
#
# 口径：斜率一律由服务端按「已办结」读数拟合，页面只展示结果。
# 窗口 = 每跨按办结时间倒序取最近 N 条；窗内按办结先后编号 1..n，
# 对微应变做最小二乘拟合（regr_slope），斜率单位 με/点；不足 2 条不出斜率。

DEFAULT_WINDOW = 10
ALLOWED_WINDOWS = (2, 5, 10, 20, 50)

# 列表与明细共用同一段窗口 CTE，保证两处斜率逐条对得上。
WINDOW_CTE = """
WITH ranked AS (
    SELECT id, span_code, microstrain, verdict, processed_at,
           ROW_NUMBER() OVER (
               PARTITION BY span_code
               ORDER BY processed_at DESC, id DESC
           ) AS rn
    FROM strain_readings
    WHERE status = 'done'
),
win AS (
    SELECT id, span_code, microstrain, verdict, processed_at,
           ROW_NUMBER() OVER (
               PARTITION BY span_code
               ORDER BY rn DESC
           ) AS seq
    FROM ranked
    WHERE rn <= %(window)s
)
"""

CALIBER_TEMPLATE = (
    "口径：仅统计状态为「已办结」的读数，待处理/处理中不计入拟合；"
    "按办结时间倒序取每跨最近 {window} 条作为窗口；"
    "窗内按办结先后编号 1..n，对微应变做最小二乘拟合，斜率单位 με/点；"
    "窗内不足 2 条时不出斜率（空）。"
    "斜率由服务端拟合，页面只展示，不自行计算。"
)


def _parse_window(request, user):
    """解析窗宽参数。返回 (window, error_response)；无误时 error_response 为 None。

    测量员可调窗；复核员只看，仅允许默认窗宽。
    """
    raw = request.args.get("window")
    if raw in (None, ""):
        return DEFAULT_WINDOW, None
    try:
        window = int(str(raw).strip())
    except ValueError:
        return None, sanic_json({"detail": "窗宽必须是整数"}, status=400)
    if window not in ALLOWED_WINDOWS:
        allowed = "/".join(str(w) for w in ALLOWED_WINDOWS)
        return None, sanic_json({"detail": f"窗宽仅支持 {allowed}"}, status=400)
    if user["role"] != "writer" and window != DEFAULT_WINDOW:
        return None, sanic_json(
            {"detail": "复核员仅可查看默认窗宽，不可调窗"}, status=403
        )
    return window, None


@app.get("/api/trends/slopes")
async def trend_slopes(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    window, err = _parse_window(request, user)
    if err:
        return err

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                WINDOW_CTE
                + """
                SELECT span_code,
                       COUNT(*) AS points,
                       CASE WHEN COUNT(*) >= 2
                           THEN ROUND(regr_slope(microstrain, seq)::numeric, 4)::float
                       END AS slope,
                       MIN(processed_at) AS first_processed_at,
                       MAX(processed_at) AS last_processed_at
                FROM win
                GROUP BY span_code
                ORDER BY span_code
                """,
                {"window": window},
            )
            rows = await cur.fetchall()

    spans = [
        {
            "span_code": r["span_code"],
            "points": r["points"],
            "slope": r["slope"],
            "first_processed_at": _iso(r["first_processed_at"]),
            "last_processed_at": _iso(r["last_processed_at"]),
        }
        for r in rows
    ]
    return sanic_json(
        {
            "window": window,
            "default_window": DEFAULT_WINDOW,
            "allowed_windows": list(ALLOWED_WINDOWS),
            "editable": user["role"] == "writer",
            "caliber": CALIBER_TEMPLATE.format(window=window),
            "spans": spans,
        }
    )


@app.get("/api/trends/detail")
async def trend_detail(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    window, err = _parse_window(request, user)
    if err:
        return err
    span_code = str(request.args.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "缺少跨段编号 span_code"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                WINDOW_CTE
                + """
                SELECT seq, id, microstrain, verdict, processed_at,
                       COUNT(*) OVER () AS points,
                       CASE WHEN COUNT(*) OVER () >= 2
                           THEN ROUND((regr_slope(microstrain, seq) OVER ())::numeric, 4)::float
                       END AS slope
                FROM win
                WHERE span_code = %(span)s
                ORDER BY seq
                """,
                {"window": window, "span": span_code},
            )
            rows = await cur.fetchall()

    points = rows[0]["points"] if rows else 0
    slope = rows[0]["slope"] if rows else None
    return sanic_json(
        {
            "span_code": span_code,
            "window": window,
            "points": points,
            "slope": slope,
            "caliber": CALIBER_TEMPLATE.format(window=window),
            "rows": [
                {
                    "seq": r["seq"],
                    "id": r["id"],
                    "microstrain": r["microstrain"],
                    "verdict": r["verdict"],
                    "processed_at": _iso(r["processed_at"]),
                }
                for r in rows
            ],
        }
    )
