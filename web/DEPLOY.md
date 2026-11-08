# Web 端部署（GitLab Pages）

零后端静态 SPA——直接读取 vault 所在的 GitLab 项目（API），PAT 存浏览器本地。

## 构建

```bash
cd web
npm install
WEB_BASE=/<namespace>/<project>/ npm run build   # GitLab Pages 子路径部署
# 自有域名（根路径）省略 WEB_BASE
```

产物在 `web/dist/`。

## GitLab Pages 发布

方式一：CI（推荐）——vault 仓库加 `.gitlab-ci.yml`：

```yaml
pages:
  image: node:20
  script:
    # 把 web 工程放进 vault 仓库的 web/ 目录（或子模块），Pages 构建直接引用
    - cd web && npm ci && npm run build
    - mkdir -p ../public && cp -r dist/* ../public/
  artifacts:
    paths:
      - public
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

> 注意：web 工程与 vault 同仓时把 `web/` 提交进 vault 仓库；分仓部署则把本目录复制过去。

方式二：手动——`npm run build` 后把 `dist/` 上传到任意静态托管（含自有服务器）。

## 使用

1. 打开 Pages 地址 → 首屏填 GitLab host / PAT（需 `read_api` + `write_repository`）/ 项目 ID
2. 论文列表来自 `papers/*/meta.yaml`；点进论文读 `translations.jsonl` 双语流
3. 划选英文 →「划线并回写」→ Commits API 更新 `annotations.json`（乐观 UI，失败回滚）

## 安全模型

- PAT 只存 localStorage（按设备/浏览器），不经过任何中间服务器
- 静态 SPA 可公开托管（无 PAT 的访客打不开数据——所有请求带你的 PAT 从浏览器直发 GitLab）
- 回写走单文件 commit：单人使用可接受行级并发丢更新（桌面端 DB 是权威，同步链路会收敛）

## 已知限制（MVP）

- 无内嵌 PDF 阅读器：PDF 走 raw URL 外链（新标签打开）
- 精炼令牌跳转是近似锚点（H→划线卡，N/Q→段落 seq）
- >100 篇论文的仓库列表分页已处理；>1000 篇建议按年分子目录（vault 布局本身按 paperKey 平铺，暂无此场景）
