# ZotFlow 开发与发布流程实施计划

状态：本地实现和验证已完成；远端启用与真实 Release 演练待执行。日期：2026-09-18。

目标流程见 `docs/development-release-workflow.md`。本计划只改造开发、beta、stable 与 Enhancement Pack 协调自动化，不改变 ZotFlow 运行时功能或 Pack 资源协议。

本地 `staging` 已从当前 `master` 创建。commit、tag、push、branch protection 或 GitHub Release 等远端操作仍需在实际执行时单独确认。

## 0. 实施快照

| 项目                                  | 状态     | 实现                                                                          |
| ------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| ZotFlow 通用 CI                       | 本地完成 | `.github/workflows/ci.yml`                                                    |
| ZotFlow beta release                  | 本地完成 | `.github/workflows/beta-release.yml`                                          |
| ZotFlow stable 保护                   | 本地完成 | `.github/workflows/release.yml`                                               |
| ZotFlow → Pack stable dispatch        | 本地完成 | payload 明确增加 `channel: stable`                                            |
| Pack 契约 fingerprint 与 beta release | 本地完成 | `zotflow-enhancement-pack/.github/workflows/beta-release.yml`                 |
| Pack stable 流程                      | 保留     | 仍由 ZotFlow `master` lock 变化创建稳定同步 PR                                |
| 脚本测试与本地构建                    | 通过     | 两仓库测试、ZotFlow plugin build、Pack build 和临时工作树 beta 容器演练均通过 |
| commit / push / 远端 workflow         | 未执行   | 需要维护者审核后启用                                                          |
| branch protection / secrets 审核      | 未执行   | 需要在 GitHub 仓库设置中完成                                                  |
| 真实 beta / BRAT / 跨平台 smoke test  | 未执行   | 自动化进入远端后执行                                                          |

下方 checklist 同时包含代码实现和远端发布验收。未勾选项不一定表示缺少代码，也可能表示尚未在 GitHub 或目标平台执行。

### 远端启用顺序

1. 先在 Enhancement Pack 审核并合入 beta workflow、fingerprint 和版本工具；不得改变 Pack `manifest.json`。
2. 在 ZotFlow 更新 Enhancement Pack 子模块指针，并将本次 workflow、脚本和文档作为自动化引导变更合入默认分支 `master`；合入前确认 `manifest.json` 和运行时代码未变化。
3. 将同一自动化提交同步到远端 `staging`，配置 branch protection 和 `ENHANCEMENT_PACK_DISPATCH_TOKEN`。
4. 从 `staging` 的明确 SHA 触发首个 ZotFlow beta，再验证 Pack no-op 或 beta 路径。

第 2 步是 GitHub 识别 `workflow_dispatch` / `repository_dispatch` 文件所必需的默认分支引导，不是产品发布；它不允许借机升级 `master` manifest。

## 1. 实施范围

### 包含

- 建立长期 `staging` 与短期 `release/x.y.z` 流程；
- 为 ZotFlow 增加通用 CI 和手动 beta release；
- 收紧 ZotFlow stable release 的版本与 tag 检查；
- 在 ZotFlow beta 成功后按需请求 Enhancement Pack beta；
- 为 Pack 增加兼容 no-op、幂等 beta 发布和 prerelease 版本一致性；
- 保留 ZotFlow `master` lock 变化触发 Pack 正式同步的现有逻辑；
- 补充自动化测试、故障处理和维护文档。

### 不包含

- 把 Enhancement Pack 变成 ZotFlow 正式发布的硬依赖；
- 自动合并或自动发布 Pack 正式版；
- 在 `master` 或 `staging` 提交 beta 版本号；
- 同时维护多个活跃 release 分支；
- 为跨仓库发布实现分布式事务；
- 改变 Pack v2 容器格式或 ZotFlow 运行时兼容语义。

## 2. 阶段 0：建立基线

- [ ] 记录 ZotFlow 当前稳定 tag、`manifest.json`、`package.json` 和 `versions.json` 版本。
- [ ] 记录 Enhancement Pack 当前稳定 tag、manifest、lock 和开放的自动同步 PR。
- [ ] 确认 `ENHANCEMENT_PACK_DISPATCH_TOKEN` 只拥有目标仓库所需的最小权限。
- [ ] 确认 GitHub Actions 可以创建 prerelease、上传资产；stable job 继续生成 attestation。
- [x] 从当前 `master` 创建 `staging`，创建后验证两者 commit 完全一致。
- [ ] 配置 `master` branch protection；根据单人开发需要决定 `staging` 是否要求 PR。
- [ ] 约定同时最多一个 `release/*`，发布后立即删除。

完成标准：两个仓库工作树和远端状态明确，创建 `staging` 不改变任何版本文件，也不触发 release。

## 3. 阶段 1：抽取可复用的版本与发布校验

### ZotFlow

- [x] 新增只处理发布元数据的脚本，支持 stable 与 beta 两种模式。
- [x] stable 模式更新 `package.json`、`package-lock.json`、`manifest.json` 和 `versions.json`。
- [x] beta 模式只修改 runner 工作区，结束后不得 push 或 commit。
- [x] stable 版本只接受 `x.y.z`；beta 版本只接受 `x.y.z-beta.N`。
- [x] 校验 tag、manifest、package version 和 `versions.json` 映射。
- [ ] 输出机器可读的 version、channel 和 source SHA，供 workflow 后续步骤使用。
- [x] 为版本解析、非法输入和 minAppVersion 映射增加单元测试。

### Enhancement Pack

- [x] 将 Pack prerelease 版本同步到 `package.json`、lockfile、manifest、versions 和 `document-worker.lock.json.packVersion`。
- [x] 确保 Pack 容器内 `pack.version` 与发布 manifest version 一致。
- [x] 不把 beta 版本写回 Pack `master` 或自动化 PR 的稳定元数据。
- [x] 为版本一致性和容器读取验证增加测试。

完成标准：两个项目都能在临时工作区生成一致的 beta 资产，运行后 Git 工作树只出现预期的临时改动，并可显式清理。

## 4. 阶段 2：ZotFlow 通用 CI

建议新增 `.github/workflows/ci.yml`。

- [x] 在 `staging`、`master`、`release/**` push 和相关 PR 上触发。
- [x] 使用项目要求的 Node 22 与 npm cache。
- [x] checkout recursive submodules。
- [x] 执行 `npm ci`。
- [x] 通过 `npm test` 执行 lint、测试 typecheck、Vitest 和 release script tests。
- [x] 执行 `npm run build:plugin`。
- [x] release workflow 独立执行完整 `npm run build:ci`。
- [x] 设置 concurrency，使同一 ref 的旧 CI 可取消，release job 不被取消。
- [x] CI job 使用只读 `contents` 权限。

完成标准：普通代码变更在不具备 release 写权限的 workflow 中完成全部静态和测试验证。

## 5. 阶段 3：ZotFlow beta release

建议新增 `.github/workflows/beta-release.yml`。

### 触发和保护

- [ ] 使用 `workflow_dispatch`，要求输入 `version`，例如 `1.6.6-beta.1`。
- [ ] 从用户选择的 ref 解析不可变 SHA。
- [ ] 验证源 commit 属于远端 `staging`。
- [ ] 拒绝 `master`、任意 feature commit 和 stable 格式版本。
- [ ] 检查 tag 和 Release 不存在，禁止覆盖已有 beta。
- [ ] 使用 `concurrency: zotflow-beta-release`，禁止并发发布。

### 构建和发布

- [ ] 先在原始源树运行测试，避免版本改写掩盖工作树问题。
- [ ] 临时写入 beta 版本并生成构建所需的 manifest。
- [ ] 执行 `npm run build:ci`。
- [ ] 验证 `main.js`、`manifest.json` 和 `styles.css` 存在。
- [ ] 验证 Release tag、title 和资产 manifest version 完全一致。
- [ ] 上传普通 workflow artifact，便于失败诊断。
- [x] 生成 SHA-256 checksums；beta 的临时版本构建不生成可能指向错误提交的 provenance，stable 仍保留 attestation。
- [ ] 使用 `gh release create --prerelease --latest=false` 直接发布，禁止 Draft。
- [ ] Release Notes 包含源 SHA、测试命令、Pack 状态和安装方式。
- [ ] job 结束前确认没有 push beta 版本提交。

### Pack dispatch

- [ ] 只在 ZotFlow Pre-release 创建成功后 dispatch Enhancement Pack。
- [ ] payload 包含 channel、ZotFlow version、源 SHA、Document Worker commit 和 protocol。
- [ ] Pack dispatch 失败时保留 ZotFlow beta，但将 workflow 标记失败或明确产生需要处理的状态。

完成标准：可以从 `staging` 发布可安装的 ZotFlow beta，远端 `staging` 和 `master` 的版本文件保持不变。

## 6. 阶段 4：Enhancement Pack beta 自动化

新增 Pack 的 `.github/workflows/beta-release.yml`，并保留现有 `.github/workflows/sync-document-worker.yml` stable dispatch 路径。

### 区分 channel

- [ ] 保留 `document-worker-updated` 作为 stable 事件。
- [ ] 新增 beta 事件，或在 payload 中严格区分 `channel: beta`。
- [ ] stable payload 缺少 channel 时按 stable 处理，避免破坏现有调用方。
- [ ] 两种路径都把可移动 ref 解析为不可变 ZotFlow commit。

### 契约 fingerprint 和幂等性

- [ ] 从 ZotFlow lock 的兼容字段生成确定性的 contract fingerprint。
- [ ] fingerprint 不包含 ZotFlow SemVer 或无关格式化差异。
- [ ] 比较 Pack stable、现有自动化分支和已发布 Pack beta 的 fingerprint。
- [ ] 任一现有 Pack 产物已匹配时成功 no-op。
- [ ] 同一 fingerprint 的并发请求由 concurrency 合并或取消旧任务。
- [ ] 不以“Pack tag 相同”代替资源兼容判断。

### 不兼容时发布 beta

- [ ] 复用当前 lock 下载、archive hash、resource hash 和 SDT metadata 验证。
- [ ] 创建或更新按兼容目标命名的 automation 分支和 PR。
- [ ] 保持当前资源变化的 minor 候选版本策略。
- [ ] 计算下一个未占用的 prerelease 序号，例如 `2.1.0-beta.1`。
- [ ] 在 runner 中临时同步所有 Pack 版本字段。
- [ ] 运行 `npm run build`、lint、protocol test 和最终容器验证。
- [ ] 创建非 Draft、非 latest 的 GitHub Pre-release。
- [x] 上传 `main.js`、`manifest.json`、`styles.css` 和 checksums；不为临时 beta commit 生成误导性的 attestation。
- [ ] Release Notes 记录 ZotFlow beta tag、源 SHA、contract fingerprint 和 Document Worker commit。
- [ ] 不合入 Pack `master`，也不自动发布 stable Pack。

完成标准：兼容请求零发布；不兼容请求恰好生成一个可安装 Pack beta；重复请求复用同一兼容产物。

## 7. 阶段 5：ZotFlow stable release

### release 分支准备

- [ ] 从通过跨平台验收的 `staging` SHA 创建 `release/x.y.z`。
- [ ] 提交正式版本升级，使用 Conventional Commit，例如 `chore(release): x.y.z`。
- [ ] 验证 release 分支除版本元数据和明确 release-blocker 外没有额外改动。
- [ ] 冻结 `staging` 的非必要合入，直到正式发布完成。

### 收紧 `.github/workflows/release.yml`

- [ ] beta tag 不运行 stable job；stable tag 必须严格匹配 `x.y.z`。
- [ ] 验证 tag、package、manifest 和 versions 映射。
- [ ] 验证 stable tag 指向预期 release commit。
- [ ] 保留 recursive submodule checkout、`build:ci`、artifact 和 attestation。
- [ ] 保留 Draft Release，供正式发布前检查。
- [ ] Draft 资产缺失或版本不一致时失败。
- [ ] 记录源 SHA 和完整构建命令。

### 激活正式版本

- [ ] 手动下载并检查 Draft Release 资产。
- [ ] 发布 GitHub stable Release。
- [ ] 确认公开 Release 可按 tag 访问且三个资产完整。
- [ ] 只在此后将 `release/x.y.z` 合入 `master`。
- [ ] 优先 fast-forward；若不能 fast-forward，先审核 master 漂移原因。
- [ ] 将 `master` 同步回 `staging`。
- [ ] 删除本地和远端 release 分支，保留 tag。

完成标准：不存在“master manifest 已升级但公开 Release 尚不可下载”的时间窗口。

## 8. 阶段 6：保留 Pack stable 流程

ZotFlow `.github/workflows/notify-enhancement-pack.yml` 的 stable 行为保持不变：只在 `master` 的 `document-worker.lock.json` 变化时触发。

- [ ] 保留 `branches: master` 和 lock path filter。
- [ ] payload 可补充 `channel: stable`，但 Pack 必须兼容旧 payload。
- [ ] 保留手动 `workflow_dispatch` 作为恢复路径。
- [ ] Pack stable workflow 继续同步、minor bump、验证并创建 PR。
- [ ] Pack PR 继续人工检查和合并。
- [ ] Pack 正式 Release 继续人工完成，不由 ZotFlow 自动发布。
- [ ] lock 未变化时不创建 Pack stable 版本。

接受的权衡：ZotFlow stable 可以先于 Pack stable 生效；旧 Pack 不匹配时依赖 Pack 的功能暂时不可用，但 ZotFlow 基础功能必须正常。

完成标准：新 beta 自动化不改变现有 Pack stable 的审批和发布所有权。

## 9. 阶段 7：自动化测试

### ZotFlow workflow/脚本测试

- [ ] stable 和 beta 版本格式矩阵。
- [ ] tag/package/manifest/versions 一致与不一致。
- [ ] beta 临时改写后资产正确、Git 历史不变。
- [ ] beta tag 已存在时拒绝覆盖。
- [ ] 非 `staging` commit 被拒绝。
- [ ] Pack dispatch 只在 beta Release 成功后发生。

### Pack workflow/脚本测试

- [ ] 相同契约 no-op。
- [ ] Document Worker commit 变化触发同步。
- [ ] resource size/hash 变化触发同步。
- [ ] protocol/SDT version 变化触发同步或明确拒绝。
- [ ] 仅 ZotFlow beta version 变化不触发 Pack beta。
- [ ] 相同 fingerprint 的重复请求不发布重复版本。
- [ ] Pack beta 的 manifest、lock 和容器版本一致。
- [ ] stable dispatch 继续创建当前类型的 PR，而非 beta Release。

### 端到端演练

- [ ] 在不触碰 `master` manifest 的情况下发布一个测试 beta。
- [ ] 用兼容 lock 验证 Pack no-op。
- [ ] 用受控 fixture 改变 lock，验证自动 Pack beta。
- [ ] 验证 BRAT 固定版本安装 ZotFlow beta 与 Pack beta。
- [ ] 验证没有 Pack 和旧 Pack 时 ZotFlow 安全降级。
- [ ] 删除演练产生的临时 Release/tag 前确认目标准确且不影响正式版本。

## 10. 阶段 8：运维与文档

- [ ] 在维护者文档中链接 `docs/development-release-workflow.md`。
- [ ] 为 beta tester 提供简短安装和反馈模板。
- [ ] 为 release owner 提供逐项 checklist。
- [ ] 记录哪些平台由自动化覆盖、哪些必须真机验证。
- [ ] 记录 Release/tag 删除、失败 Draft 和 hotfix 的处理边界。
- [ ] 明确 Pack beta 是测试产物，Pack stable 仍需人工发布。

## 11. 建议实施顺序

按以下顺序实施，避免同时改动两个仓库后难以定位问题：

1. ZotFlow 版本校验脚本和通用 CI；
2. ZotFlow beta release，不 dispatch Pack；
3. 手动验证 beta 资产和 BRAT 安装；
4. Pack contract fingerprint 与 no-op；
5. Pack beta 自动发布；
6. 接通 ZotFlow beta → Pack beta dispatch；
7. 收紧 ZotFlow stable workflow；
8. 端到端演练 release 分支 → Draft → Publish → merge master；
9. 启用 branch protection 和正式运维流程。

每个阶段单独提交、单独验证。不要把 ZotFlow beta、Pack beta、stable release 和 branch protection 一次性切换。

## 12. 最终验收标准

- `master/manifest.json` 只在对应 stable Release 已公开并验证后变化；
- `staging` 可以连续发布 beta，而不产生版本提交；
- release 分支在发布后删除，tag 永久保留；
- ZotFlow beta 仅在 Pack 不兼容时产生一个新的 Pack beta；
- 相同 Pack 契约的后续 ZotFlow beta 不产生重复 Pack release；
- ZotFlow stable 不被 Pack stable 阻塞；
- ZotFlow `master` lock 变化仍触发现有 Pack 正式同步 PR；
- 无 Pack、旧 Pack、Pack beta 和 Pack stable 四种状态均有明确、可复现的行为；
- 全部自动化测试、生产构建和目标平台 smoke test 通过。
