# 持续迭代计划

- [x] ✅ 需求澄清：确认 codex 无法联网多半来自 AI CLI 环境变量未加载/工作区切换导致 `.env` 丢失。
- [x] ✅ 设计与方案：新增 env 解析与加载逻辑，支持 CLI 传入 env 与 env 文件；默认自动加载仓库或 worktree 的 `.env`。
- [x] ✅ 开发实现：补充 env 工具模块；CLI/config/loop 透传 env；README 更新；新增 env 单测与 fixture。
- [x] ✅ 自审：检查 env 合并优先级、worktree 兼容性与错误提示。
- [x] ✅ 测试：运行 `yarn test` 与 `yarn e2e`，记录结果。
- [ ] PR：准备摘要、测试结果、风险，使用 `gh` 创建 PR。
