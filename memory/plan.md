# 持续迭代计划

- [x] ✅ 需求澄清：运行 AI CLI 时在 log 中实时显示其输出（stdout/stderr），每行带时间戳。
- [x] ✅ 设计与方案：runCommand 支持流式输出；runAi 默认开启流式并使用 AI CLI 名称前缀区分输出来源。
- [x] ✅ 开发实现：扩展命令执行能力并接入 AI CLI；新增流式输出单元测试覆盖 stdout/stderr。
- [x] ✅ 自审：确认多行拆分与缓冲 flush 逻辑正确，不影响现有命令执行与日志级别控制。
- [x] ✅ 测试：运行 `yarn test` 与 `yarn e2e`，记录结果（均因缺少 `ts-node/register` 失败）。
- [ ] PR：准备摘要、测试结果、风险，使用 `gh` 创建 PR（待依赖安装与测试通过）。
