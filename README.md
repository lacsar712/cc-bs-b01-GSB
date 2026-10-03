# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

顶栏可切换到 **趋势斜率专页**（交接班用）：上方选窗宽，中间列各跨段斜率与点数，下方挂刷新按钮与口径说明。斜率一律由 **服务端** 按每跨最近 N 条 **已办结（done)** 读数做最小二乘拟合（με/点），未办结读数不入拟合，点数不足 2 时斜率为空；页面只展示服务端结果，不自行计算。测量员可调窗宽复核，复核员只看默认窗。每行可展开 **按窗重查明细**，窗内逐条办结点与重查斜率与汇总逐条对上。

## 趋势接口

| 接口 | 说明 |
|------|------|
| `GET /api/trend/slopes?window=N` | 各跨段斜率汇总（窗宽档位 3/5/10/20/50，默认 10；复核员仅默认窗） |
| `GET /api/trend/points?span_code=X&window=N` | 按窗重查明细：窗内逐条办结点 + 同口径斜率 |

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

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

趋势拟合为纯逻辑模块（`backend/trend.py`，零依赖），不启库即可自测：

```bash
cd backend && python3 test_trend.py
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
