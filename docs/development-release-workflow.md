# ZotFlow 开发、测试与正式发布流程

状态：本地自动化改造已完成并通过验证；等待提交、推送和远端启用。日期：2026-09-18。

本文规定 ZotFlow 从日常开发、跨平台 beta 测试到正式发布的分支与自动化流程，并说明与 ZotFlow Enhancement Pack 的协作边界。具体实施步骤见 `docs/development-release-workflow-plan.md`。

## 1. 目标与发布不变量

流程必须同时满足以下约束：

1. `master/manifest.json` 始终表示当前已经正式发布、可以被 Obsidian 获取的稳定版本。
2. 在对应 GitHub Release 已发布且资产验证完成之前，不把新的正式版本号合入 `master`。
3. beta release 可以公开供 BRAT 或手动安装使用，但不得通过提交修改 `master` 或 `staging` 的版本号。
4. 正式 Release 的 tag、`package.json`、`package-lock.json`、`manifest.json` 和 `versions.json` 必须一致。
5. Enhancement Pack 是可选组件。Pack 不兼容不能阻塞 ZotFlow 的普通阅读、同步和 Source Note；依赖 Pack 的功能必须明确降级。
6. Pack beta 仅在兼容契约变化时自动发布；Pack 正式版继续由 ZotFlow `master` 上的 lock 变化触发现有人工发布流程。
7. 发布历史由不可变 tag 和 GitHub Release 保存。`release/x.y.z` 是短期隔离分支，发布结束后删除。

## 2. 分支模型

| 分支            | 生命周期   | 作用                                           | 版本文件规则                                                                                   |
| --------------- | ---------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `master`        | 长期       | 当前正式产品状态和默认分支自动化               | 产品版本文件只在正式 Release 已发布并验证后更新；允许不改变 manifest 的 CI、发布脚本和文档维护 |
| `staging`       | 长期       | 日常集成、beta 构建和跨平台验证                | 保持当前稳定版本，不提交 beta 版本号                                                           |
| `feature/*`     | 可选、短期 | 隔离较大、风险较高或并行开发                   | 不做发布版本升级                                                                               |
| `fix/*`         | 可选、短期 | 隔离需要评审或可能回退的修复                   | 不做发布版本升级                                                                               |
| `release/x.y.z` | 短期       | 冻结正式候选、提交正式版本号并生成正式 Release | 唯一允许提前包含下一个正式版本号的分支                                                         |

同时最多保留一个活跃的 `release/*`。发布完成并合入后，删除本地和远端 release 分支；对应 tag 永久保留。

### 2.1 何时使用 feature 或 fix 分支

单人、单任务且改动很小时，可以直接在 `staging` 开发。以下情况使用短期分支：

- 改动较大，需要多次提交或独立评审；
- 同时进行多个任务；
- 失败后希望整体放弃或回退；
- beta 问题涉及高风险数据、同步、Reader 生命周期或跨平台行为。

测试发现问题时：

- 原 feature 尚未合入：继续在原 feature 修复；
- 原 feature 已合入且修复很小：直接在 `staging` 修复；
- 原 feature 已合入且修复需要隔离：从 `staging` 创建新的 `fix/*`，验证后合回；
- 不重新打开已经完成并删除的 feature 分支。

## 3. 日常开发流程

1. 从最新 `staging` 开始开发；按风险决定直接提交或创建 `feature/*`。
2. 每次合入 `staging` 前运行自动化 CI：
    - `npm run lint`
    - `npm run typecheck:tests`
    - `npm run test:vitest`
    - `npm run build:plugin`
3. Reader、PDF.js、Document Worker 或资源打包变更按风险追加 `npm run build:ci`。
4. `staging` 中不提交 `x.y.z-beta.N`，也不为了测试提前修改稳定版本号。
5. `master` 不接收未发布的运行时功能提交；稳定候选通过 `release/x.y.z` 一次性进入 `master`。默认分支所需的 CI、发布脚本和维护文档可以独立合入，但不得修改稳定版本号或改变已发布插件产物。

## 4. ZotFlow beta release

GitHub 只会从默认分支识别可手动触发的 workflow。首次启用本流程时，先将 workflow、发布脚本和本文档作为一次自动化引导变更合入 `master`，并确认 `manifest.json`、运行时代码和当前稳定版本均未变化；随后把该提交同步到 `staging`。这不会触发 Obsidian 获取新版本。

### 4.1 触发

beta release 由 `workflow_dispatch` 从 `staging` 的明确 commit 手动触发。输入至少包含 beta 版本，例如 `1.6.6-beta.1`。

workflow 必须：

1. 将输入版本验证为 `x.y.z-beta.N`；
2. 将源 ref 解析为不可变 commit SHA，并确认它属于 `staging`；
3. 确认对应 tag 和 Release 尚不存在；
4. 运行完整测试和 `build:ci`；
5. 只在 runner 工作区临时把版本写入构建所需文件；
6. 验证发布资产中的 tag、名称和 manifest 版本一致；
7. 创建非 Draft 的 GitHub Pre-release，并明确设置为非 latest；
8. 上传 `main.js`、`manifest.json`、`styles.css` 和 SHA-256 checksums；stable 构建继续生成 provenance attestation；
9. 在 Release Notes 中记录准确的 ZotFlow 源 commit。

beta 的临时版本改写不能 commit 或 push 回任何分支。beta tag 指向实际测试的 `staging` 源 commit，Release 资产是在 CI 中从该 commit 可重复生成的派生产物。

### 4.2 测试方式

推荐使用 BRAT 固定到具体 beta tag，也允许从 GitHub Release 手动下载资产。测试记录至少包含：

- Windows、macOS 和 Linux；
- iOS/iPadOS 和 Android；
- 全新安装、覆盖安装和从上一 beta 更新；
- 插件启动、关闭、重启和 vault 重开；
- Zotero 同步、WebDAV、Linked File 和本地文件路径；
- PDF、EPUB、HTML Reader；
- annotation 创建、修改、删除和持久化；
- `.zf.json` sidecar 读写、重命名和删除；
- Enhancement Pack 相关 Reading Mode/SDT 行为；
- 无 Pack、旧 Pack、不兼容 Pack 和匹配 Pack 四种状态。

### 4.3 beta 修复循环

发现问题后在 `staging` 或新的 `fix/*` 修复，重新运行 CI，然后发布递增的 beta：

```text
1.6.6-beta.1
1.6.6-beta.2
1.6.6-beta.3
```

不覆盖、移动或复用已经发布的 beta tag。

## 5. Enhancement Pack beta 协作

### 5.1 触发时机

只有 ZotFlow beta 构建和发布成功后，才向 Enhancement Pack dispatch。不要在每次 `staging` push 时直接发布 Pack beta，以免为未进入测试的中间 commit 制造版本。

dispatch payload 至少包含：

- `channel: beta`
- `zotflowCommit`
- `zotflowVersion`
- `documentWorkerCommit`
- protocol major/minor

Enhancement Pack 必须从 `zotflowCommit` 下载 lock，不能重新解析可移动的 `staging` 分支名。

### 5.2 兼容判断与 no-op

Pack workflow 比较真正的兼容契约，而不是比较 ZotFlow 与 Pack 的 SemVer。兼容契约包含：

- Document Worker commit、archive size 和 SHA-256；
- Pack protocol major/minor；
- SDT pack/schema version；
- include 路径；
- 每个资源的路径、大小和 SHA-256。

结果分为：

- 已有稳定 Pack 或已发布 beta Pack 与目标契约一致：成功结束，不创建新版本；
- 契约不一致：同步资源、验证构建、创建或更新自动化 PR，并自动发布新的 Pack Pre-release；
- 协议不支持或资源校验失败：失败并阻止该 Pack beta，但不撤销已经完成的 ZotFlow beta。

兼容判断必须具备幂等性。相同契约被多个 ZotFlow beta 请求时，只复用现有 Pack beta，不能重复发布。

### 5.3 Pack beta 版本

当前 Pack 对 Document Worker/resource 目标变化采用 minor bump。示例：

```text
Pack stable: 2.0.0
Target candidate: 2.1.0
Pack beta: 2.1.0-beta.1
Pack stable after manual promotion: 2.1.0
```

Pack beta 构建时，runner 内的 `package.json`、`package-lock.json`、`manifest.json`、`versions.json`、`document-worker.lock.json.packVersion` 和最终容器中的 Pack version 必须一致。临时 beta 版本不得写入 Pack `master`。

当 ZotFlow beta 递增但 Pack 契约未变化时，继续使用原 Pack beta；只有契约变化才递增 Pack beta。

Pack 使用 `automation/beta-<contract-fingerprint>` 分支保存已验证 beta 的不可变来源并实现重复请求复用。兼容 Pack 正式版发布后，可删除对应 beta automation 分支；beta tag 和 GitHub Release 继续保留。每个契约最多产生一个此类分支，不随 ZotFlow beta 序号重复创建。

## 6. ZotFlow 正式发布

### 6.1 创建 release 分支

跨平台测试通过后：

1. 暂停向 `staging` 合入新的非 release-blocker 改动；
2. 从已经验证的 `staging` commit 创建 `release/x.y.z`；
3. 在该分支提交正式版本升级：
    - `package.json`
    - `package-lock.json`
    - `manifest.json`
    - `versions.json`
4. release 分支只接受版本准备、发布元数据和 release-blocker 修复。

如果 release-blocker 修复会影响后续开发，必须同步回 `staging`，避免 release 与开发线漂移。

### 6.2 构建和发布

1. 对 release 分支运行完整 CI 和 `build:ci`；
2. 创建与 `manifest.json` 完全相同的稳定 tag，例如 `1.6.6`；
3. 现有 stable workflow 构建、attest 并创建 Draft Release；
4. 下载并验证 Draft 中的三个发布资产；
5. 手动发布正式 GitHub Release；
6. 确认 Release 已公开且 tag、manifest、最小 Obsidian 版本和资产均正确；
7. 才允许把 `release/x.y.z` 合入 `master`。

`master/manifest.json` 的变化是正式版本对 Obsidian 生效的开关。禁止先合并 version bump、再等待 Release 构建。

### 6.3 发布后收尾

1. 优先使用 fast-forward 将 release 分支合入 `master`；
2. 将 `master` 同步回 `staging`；
3. 删除本地和远端 `release/x.y.z`；
4. 保留稳定 tag 和 GitHub Release；
5. 检查正式安装和更新路径；
6. 记录平台验证结果和已知限制。

## 7. Enhancement Pack 正式发布

Pack 正式版不作为 ZotFlow 正式发布的强制前置条件。保留当前逻辑：

1. `release/x.y.z` 合入 ZotFlow `master`；
2. 如果该次合并修改了 `document-worker.lock.json`，`notify-enhancement-pack.yml` dispatch `document-worker-updated`；
3. Pack workflow 从准确的 ZotFlow `master` commit 下载 lock；
4. Pack 自动同步资源、执行当前 minor bump、验证构建并创建或更新 PR；
5. 人工检查、合并 Pack PR，并按 Pack 当前流程完成正式发布。

如果 lock 未变化，不触发 Pack 正式版本。

ZotFlow 正式版可以先于兼容 Pack 正式版生效。期间不兼容 Pack 只能使依赖资源的功能不可用，不能破坏 ZotFlow 的基础功能。UI 应给出短而明确的安装或更新提示，不暴露内部 hash 或 stack trace。

## 8. 失败与回退

### beta 失败

- 修复后发布新的 beta，不移动旧 tag；
- 已发布的失败 beta 标记说明，不作为 latest；
- Pack beta 失败不删除 ZotFlow beta，但 Release Notes 必须说明 Pack 功能尚不可测。

### stable 构建或 Draft 验证失败

- 不合入 `master`；
- 在 release 分支修复并重新验证；
- 尚未公开的错误 Draft 可以删除后重建；
- 不用强制移动已经公开的稳定 tag。

### 正式发布后发现严重问题

- 不覆盖正式 Release 资产或移动 tag；
- 从 `master` 创建 hotfix，经过 `staging`/beta 验证后发布新的 patch；
- 如果仅 Pack 不兼容，优先发布 Pack 修复；ZotFlow 保持明确降级。

## 9. 权限与保护规则

- `master` 禁止直接 push，只允许已发布 release 分支合入；
- `staging` 要求 CI 通过；是否要求 PR 可按改单规模决定；
- stable release job 使用最小 `contents: write`、`id-token: write` 和 `attestations: write`；
- beta Pack dispatch 使用专用、最小权限 token；
- stable 发布可以绑定 GitHub protected environment 和人工审批；
- release workflow 使用 concurrency，避免同一渠道并发发布；
- secrets 不写入日志、Release Notes 或构建资产。

## 10. 示例：ZotFlow 1.6.6

```text
staging @ A
  └─ ZotFlow 1.6.6-beta.1
       └─ Pack contract changed
            └─ Pack 2.1.0-beta.1

staging @ B (fix)
  └─ ZotFlow 1.6.6-beta.2
       └─ Pack contract unchanged
            └─ reuse Pack 2.1.0-beta.1

release/1.6.6 @ C
  └─ bump stable metadata to 1.6.6
  └─ build and publish ZotFlow 1.6.6
  └─ verify assets
  └─ merge C into master
       └─ master manifest activates 1.6.6
       └─ changed lock dispatches Pack stable synchronization
            └─ manual Pack 2.1.0 release flow
```

这个顺序保证 beta 可用于跨平台联合测试，同时将两个正式产品保持松耦合：ZotFlow 不等待 Pack，Pack 只在实际兼容契约变化时产生新版本。
