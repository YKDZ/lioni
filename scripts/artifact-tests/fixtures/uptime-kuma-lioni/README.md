# Kuma 的 Lioni QA

QA 将 Vue I18n 消息约束拆成六项独立检查：

| 检查 ID | 职责 |
| --- | --- |
| `vue-i18n/source-syntax` | 检查源消息语法 |
| `vue-i18n/target-syntax` | 检查译文语法，包括目标语言独有的键 |
| `vue-i18n/variable-correspondence` | 比较源文与译文各分支的变量身份和次数 |
| `kuma/vue-message-call-arguments` | 比较消息调用点提供的参数与译文变量 |
| `kuma/vue-message-link-target-exists` | 检查静态关联的目标消息是否存在 |
| `kuma/vue-message-link-cycle` | 检查关联消息是否形成循环 |

每项约束独立报告诊断和覆盖状态。`incomplete` 表示检查所需资料不完整，例如消息语法无效或调用参数无法静态确定；`not-applicable` 表示该候选不属于检查范围。语法问题不会被算作变量比较通过。由资源盘点生成的缺译占位不会参加候选检查，真实保存的空译文仍会检查。

有意接受某条诊断时，优先为对应检查、原文键、目标语言和报告中的输入指纹建立例外。不同约束应分别确认，避免一次例外同时接受语法、变量或关联问题。检查器自身仍可使用明确的范围排除；数量单位、等价译法等项目规则应通过业务配置表达，不应借例外覆盖。
