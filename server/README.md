# Paper Reader 团队服务端（自托管）

实验室共享功能的配套服务端：账户、团队、共享阅读清单、组会排期、动态、共享术语表。

**零依赖**：纯 Node 标准库（`node:http` + `node:sqlite` + `node:crypto`），无 npm install、无编译，单文件拷到服务器即跑。

## 要求

- Node ≥ 22.5（需内置 `node:sqlite`；`node --version` 确认）

## 启动

```bash
# 最简（默认端口 8787，数据存同目录 team-server.db）
node server.mjs

# 自定义端口与数据路径
PORT=9000 DB_PATH=/data/team.db node server.mjs
```

首次启动自动建表（schema 版本随 `PRAGMA user_version` 管理，后续升级自动迁移）。

## 部署

### systemd（Linux 服务器）

```ini
# /etc/systemd/system/paper-team.service
[Unit]
Description=Paper Reader Team Server
After=network.target

[Service]
WorkingDirectory=/opt/paper-team
ExecStart=/usr/bin/node server.mjs
Environment=PORT=8787
Environment=DB_PATH=/opt/paper-team/team.db
Restart=always
User=paper

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now paper-team
```

### PM2

```bash
pm2 start server.mjs --name paper-team --env PORT=8787
```

### 备份

数据是单个 SQLite 文件（WAL 模式）。定时拷走即可：

```bash
sqlite3 team.db ".backup backup.db"   # 在线热备
```

## 安全边界

- **局域网部署（推荐）**：实验室内网直连，HTTP 明文可接受。Bearer 令牌 30 天有效。
- **公网部署必须上 TLS**：本服务自身不发证书，用 Nginx/Caddy 反代加 HTTPS，否则令牌与密码明文过公网：
  ```nginx
  location /api/ { proxy_pass http://127.0.0.1:8787; }
  ```
- 密码 scrypt 存储（N=16384），登录/邀请码有速率限制。
- **vault 资产不上传**：服务端只存团队协作元数据（KB 级）；论文 PDF/划线/笔记/译文永远在成员本机。

## API 概览

除注册/登录外全部 `Authorization: Bearer <token>`；统一返回 `{ok, data, error, hint}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/register | 注册（用户名+密码≥8位） |
| POST | /api/auth/login | 登录 → token |
| POST | /api/auth/logout | 注销 token |
| GET | /api/auth/me | 当前用户 |
| POST | /api/teams | 创建团队（返回 8 位邀请码） |
| GET | /api/teams | 我的团队列表 |
| POST | /api/join/:code | 凭邀请码加入（限流 10 次/分/IP） |
| GET | /api/teams/:id | 团队详情（成员+邀请码） |
| DELETE | /api/teams/:id/members/:uid | owner 移除成员 / member 自退 |
| POST | /api/teams/:id/transfer | owner 转让（毕业交接） |
| GET/POST | /api/teams/:id/reading-list | 共享清单（条目含 arxiv_id） |
| PATCH | /api/reading-items/:id | claim / unclaim / done |
| DELETE | /api/reading-items/:id | 添加人或 owner 删除 |
| GET/POST | /api/teams/:id/meetings | 组会排期（可挂论文） |
| PATCH | /api/meetings/:id | 领读认领 / 改期 / 笔记 |
| PUT | /api/teams/:id/progress | 阅读进度上报 |
| GET | /api/teams/:id/feed | 统一动态流（全类型） |
| GET/POST push | /api/teams/:id/terms | 共享术语表拉取/推送 |

## 测试

```bash
node tests/server-api.test.mjs   # 全 API round-trip（59 断言）
node tests/team-ui-e2e.test.mjs  # 真实窗口 UI E2E（13 断言）
```
