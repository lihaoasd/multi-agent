# 修改记录 · Agent Haness

> 位置：docs/changes/，按日期追加；遵循项目 skill 的 change-record 约定。

## 2026-09-08 M8 真实模型验收（deepseek-v4-flash，OpenAI 兼容）

- 需求/问题: 用户提供真实模型接入参数（模型 deepseek-v4-flash + API Key），要求完成真实模型验收路径（原 M8 遗留项；Key 经环境变量注入，不入库不进 git）。
- 类型: 配置 + 代码(微调) + 验收
- 改动范围:
  1. `config.yaml`：models.providers 新增 `deepseek-v4-flash`（kind=openai-compatible、baseUrl=https://api.deepseek.com/v1、apiKeyEnv=DEEPSEEK_API_KEY、model=deepseek-v4-flash）；`models.default` 保持 `mock`（无 Key 演示默认），真实使用把实例 model 或 models.default 指向该 provider id（agent-runtime §5 口径：model 字段引用 provider id）。
  2. `src/infra/model/openai-compatible.ts`：max_tokens 缺省 2048——推理型模型先输出 reasoning_content 占用预算，缺省过小会"只推理无正文"（实测 8 token 时正文为空）。
  3. README「快速开始/换真实模型」口径已覆盖（Key 环境变量 + provider id 引用）。
- 原因: 端到端真实模型主链路验收（M8 遗留项落地）。
- 验证: 探测 HTTP 200；服务(3106)建项目→实例 model=deepseek-v4-flash→发送中文问题（UTF-8）→ agent 返回真实内容（非 Mock）：「我是…项目高级开发工程师，能将您的方案转化为可运行代码，并执行命令、汇报验证结果。」；`npm run test` 107/107、tsc/eslint 0 错。
- 测试: 现有套件不受影响（mock 默认路径）；真实模型链路为手动验收（依赖网络与 Key，不进 CI）。
- 遗留(说明): Key 仅存环境变量（本会话临时注入，未写入任何文件）；重复验收请自行设置 `DEEPSEEK_API_KEY` 后：PATCH /team/:iid {model:'deepseek-v4-flash'}（或改 models.default）→ 发消息。
