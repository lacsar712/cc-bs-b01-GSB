# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python Sanic + psycopg（异步连接池） |
| 工人 | `worker.py`（psycopg 同步，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Mithril.js + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3198 |
| 接口 | http://localhost:8198 |
| PostgreSQL | localhost:54398（库名 `bridgestrain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| surveyor | surv123456 | 测量员，可提交读数 |
| reviewer | rev123456 | 复核员，只读列表 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

## 种子数据

| 跨段 | 微应变 | 结论 |
|------|--------|------|
| 跨中S1 | 150 με | 合格 |
| 支座S2 | 40 με | 越界 |

## 趋势斜率专页

顶栏「趋势斜率」进入专页：上方选窗宽，中间列出各跨段斜率与拟合点数，列表下方挂刷新按钮与口径说明；点击某跨可展开本窗拟合明细，逐条核对。

- 斜率由服务端按「已办结」读数最小二乘拟合（待处理/处理中不计入），页面只展示、不自行计算。
- 窗宽 = 每跨按办结时间倒序取最近 N 条（可选 2/5/10/20/50，默认 10）；窗内按办结先后编号 1..n，斜率单位 με/点；不足 2 条不出斜率（空）。
- 测量员可调窗复核；复核员只看默认窗宽（服务端强制，非默认窗宽返回 403）。

| 接口 | 说明 |
|------|------|
| `GET /api/trends/slopes?window=N` | 各跨段斜率与拟合点数（含口径文案） |
| `GET /api/trends/detail?span_code=X&window=N` | 指定跨段本窗拟合明细，与列表逐条对应 |

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
