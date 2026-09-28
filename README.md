# 天文观测计划编排台（gbobsplan）

面向业余天文台与高校天文社团的值班排期人员：把「观测目标—可见窗口—月相—望远镜与终端—备用观测夜」串成一份可执行的观测夜编排表，解决目标亮度与月相冲突、设备被重复占用、阴天临时改期难以追溯的问题。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21813>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | MUI（Material UI 5）+ Emotion |
| 路由 | React Router 6（5 条业务路由 + 404） |
| 状态 | Zustand（targetStore / sessionStore / equipmentStore / nightStore） |
| 存储 | IndexedDB（Dexie，库名 `gbobsplan-db`，`schemaVersion` + v2/v3 迁移） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21813
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # target / session / equipment / night（+ index.ts 统一出口）
│       ├── stores/            # targetStore / sessionStore / equipmentStore / nightStore
│       ├── components/common/ # Timeline / StatusChip / ConflictBadge / FieldRow
│       ├── hooks/             # usePersistentStore（Dexie 读写 + Zustand 同步）/ useConflictCheck
│       ├── pages/             # OverviewPage / TargetsPage / SessionsPage / EquipmentPage / ExportPage
│       ├── router/index.tsx   # 路由表
│       └── utils/             # astro.ts（高度角/可见窗口/月相）/ replan.ts（替补安排预演）/ export.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 本夜编排总览 | 30 分钟刻度时间轴 + 月相与月出月落条带；冲突与低于高度阈值的目标自动标灰 |
| `/targets` | 观测目标库 | 按类型与优先级筛选、按视星等排序、维护地平高度阈值与曝光参数，并给出本夜可见窗口 |
| `/sessions` | 排程段与冲突 | 冲突检测结果、按时段/望远镜校验；勾选「因云取消」段可在备用夜预演并生成替补安排，确认前显示可安排 / 设备冲突 / 无法安排数量，替补段标明来源、失败段写明高度 / 月相 / 设备原因，支持按来源追溯 |
| `/equipment` | 设备分配视图 | 行 = 望远镜、列 = 30 分钟时段；冲突格标红，点击可一键跳转到对应排程段 |
| `/export` | 导出观测清单 | 目标、时刻、滤镜、帧数导出为文本与 CSV，支持打印视图 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbobsplan-db`），表：`targets`、`sessions`、`telescopes`、`instruments`、`nights`、`meta`。
- `db.version(1).stores({...})` 声明索引；`db.version(2).upgrade(...)` 为排程段增加 `backupNightId` 索引，并给旧数据补齐 `schemaVersion` 与因云取消排程段的替补夜。
- `db.version(3).upgrade(...)` 为替补安排增加 `replanSourceSessionId` / `replanOutcome` / `replanNightId` 索引：可安排的段复制为备用夜排程并记录来源，冲突与无法安排的段保留「因云取消」并写入原因分类与明细，重新打开后可按来源查回。
- 替补安排确认走单个 Dexie 读写事务（含设备占用二次校验），任一段不适合即整体回滚，页面与本地数据都保持确认前状态。
- 首次打开且表为空时写入示例数据（13 个观测目标、5 个观测夜、4 台望远镜、4 台终端、24 段排程，含 1 处设备冲突、7 段因云取消与备用夜上已占用的排程）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
