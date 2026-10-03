import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty
from trend import (
    DEFAULT_WINDOW,
    WINDOW_OPTIONS,
    caliber_text,
    fit_slope,
    normalize_window,
    round_slope,
    summarize_spans,
)

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


# 每跨最近 N 条办结(done)读数；未办结(pending/processing)一律不入窗。
_WINDOWED_DONE_SQL = """
SELECT span_code, id, microstrain, verdict, processed_at
FROM (
    SELECT span_code, id, microstrain, verdict, processed_at,
           ROW_NUMBER() OVER (PARTITION BY span_code ORDER BY id DESC) AS rn
    FROM strain_readings
    WHERE status = 'done'
) t
WHERE rn <= %s
ORDER BY span_code, id
"""

_WINDOWED_DONE_BY_SPAN_SQL = """
SELECT span_code, id, microstrain, verdict, processed_at
FROM (
    SELECT span_code, id, microstrain, verdict, processed_at,
           ROW_NUMBER() OVER (PARTITION BY span_code ORDER BY id DESC) AS rn
    FROM strain_readings
    WHERE status = 'done' AND span_code = %s
) t
WHERE rn <= %s
ORDER BY id
"""


def _trend_context(request):
    """登录 + 窗宽 + 角色口径。测量员可调窗，复核员只能看默认窗宽。"""
    user = _require_user(request)
    if not user:
        return None, None, sanic_json({"detail": "未登录"}, status=401)
    window = normalize_window(request.args.get("window"))
    if window is None:
        opts = "/".join(str(w) for w in WINDOW_OPTIONS)
        return None, None, sanic_json(
            {"detail": f"窗宽仅支持 {opts}"}, status=400
        )
    if user["role"] != "writer" and window != DEFAULT_WINDOW:
        return None, None, sanic_json(
            {"detail": "复核员仅可查看默认窗宽，不可调窗"}, status=403
        )
    return user, window, None


@app.get("/api/trend/slopes")
async def trend_slopes(request):
    """趋势专页汇总：各跨段在最近窗宽内的服务端拟合斜率与点数。"""
    user, window, err = _trend_context(request)
    if err:
        return err
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(_WINDOWED_DONE_SQL, (window,))
            rows = await cur.fetchall()
    return sanic_json(
        {
            "window": window,
            "window_options": list(WINDOW_OPTIONS),
            "default_window": DEFAULT_WINDOW,
            "can_adjust_window": user["role"] == "writer",
            "fit": "server-least-squares",
            "caliber": caliber_text(window),
            "spans": summarize_spans(rows),
        }
    )


@app.get("/api/trend/points")
async def trend_points(request):
    """按窗重查明细：返回窗内逐条办结点及同一口径拟合的斜率，供逐条对账。"""
    user, window, err = _trend_context(request)
    if err:
        return err
    span_code = str(request.args.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "缺少 span_code"}, status=400)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(_WINDOWED_DONE_BY_SPAN_SQL, (span_code, window))
            rows = await cur.fetchall()
    values = [float(r["microstrain"]) for r in rows]
    points = [
        {
            "seq": seq,
            "id": r["id"],
            "microstrain": r["microstrain"],
            "verdict": r["verdict"],
            "processed_at": _iso(r["processed_at"]),
        }
        for seq, r in enumerate(rows)
    ]
    return sanic_json(
        {
            "span_code": span_code,
            "window": window,
            "point_count": len(points),
            "slope": round_slope(fit_slope(values)),
            "fit": "server-least-squares",
            "caliber": caliber_text(window),
            "points": points,
        }
    )
