# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 取消 mock 默认：平台默认改用真实模型 deepseek-v4-flash

- 需求/问题: 用户要求取消 Mock 默认，新建角色/项目默认即用真实模型（deepseek-v4-flash）。
- 类型: 配置 + 代码(微调) + 文档
- 改动范围:
  1. `config.yaml`：`models.default: mock → deepseek-v4-flash`（providers 已含该 provider；Key 仍走 `DEEPSEEK_API_KEY` 环境变量，不入库）。
  2. `src/application/team/team-service.ts`：TeamService 增加可选 `modelsDefault`（=config.models.default）；实例快照模型解析 = 显式覆盖 → (模板 defaultModel 为 mock 占位且平台默认已设时 → 用 modelsDefault) → 模板 defaultModel。内置模板 defaultModel 保留 mock 占位（测试/无 Key 可回退），生产建实例自动落到真实 provider。
  3. `src/application/composition.ts`：注入 `config.models.default`。
  4. `README.md`：快速开始更新（默认真实模型 + Key 环境变量；无 Key 离线演示临时改回 mock）。
- 原因: 默认体验直接用真实模型；Mock 仅保留为内置无网络兜底/测试/离线演示。
- 行为变化: 新项目实例 model 默认 = deepseek-v4-flash（此前 mock）；无 Key 时会收到 ERR_MODEL 提示需设 `DEEPSEEK_API_KEY`（或改回 mock 演示）。
- 验证: `npm run test` 109/109；tsc/eslint/build 0 错；冒烟 3112：新建项目(product 未手动指定模型) 实例 model=deepseek-v4-flash，发中文消息返回真实模型内容。
- 测试: 现有套件不变（测试 config 默认 mock 路径不受影响；TeamService 直构未传 modelsDefault 保持模板默认）。
- 遗留(说明): 既有已创建项目/实例仍用创建时快照的模型（改 model 走 PATCH /team/:iid）；Mock 模型实现保留未删。
