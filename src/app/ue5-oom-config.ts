/** Idempotent policy and prompt additions for UE5 OOM crash triage. */
import type { PromptConfig } from './prompts.ts'
import type { Rule, Settings } from '../policy.ts'

export const OOM_SKILL_NAME = 'ue5-oom-crash-triage'
export const OOM_RUNTIME_SKILL_NAME = `dsh-superagent-${OOM_SKILL_NAME}`
export const OOM_SKILL_ROOT = 'D:\\code\\SkillManager\\ue5-oom-crash-triage'
export const OOM_SKILL_ROUTING = '处理UE5/S1Game的OOM、内存耗尽、Ran out of memory崩溃单：被@要求分析TAPD缺陷单、CrashSight链接或日志时，先核实OOM，再按本技能取证、定责和回写。'
export const OOM_SKILL = [OOM_SKILL_ROUTING,
  '先读正本 `D:\\code\\SkillManager\\ue5-oom-crash-triage\\SKILL.md`，完整遵循其取证顺序、判定规则、凭据约定和回写条件，不用标题中的 OOM 代替证据。',
  '需要打 CrashSight 标签时先读同目录 `crashsight_tag_library.md`；核对历史设备和记录游戏侧、疑似游戏侧、爆发式或未知形态时读并追加 `leak_registry.md`，保留已有记录。',
  '脚本位于正本同目录 `scripts/`。先核对本单 crashId/deviceId/崩溃时间，再取日志和解析；TAPD 回写先 dry-run，实际写入后复核评论与状态。',
  '本条 OOM 分诊的交付物是原工单的结论和回写结果，不要求代码修改或 PR；未经证据确认，不写 OOM 结论、打内存标签或改变 TAPD 状态。'].join('\n')

export const OOM_RULE: Rule = { id: OOM_SKILL_NAME, name: 'UE5 OOM 崩溃单分诊', enabled: true, instruction: [
  '人 @ 智能体，明确要求推进 UE5/S1Game 崩溃工单，且给出 TAPD 缺陷单、CrashSight 链接或对应日志/附件时接单。OOM、Ran out of memory、Out of video memory、内存耗尽等措辞是接单线索，不是最终判定。',
  'worker 必须调用 `dsh-superagent-ue5-oom-crash-triage`，读取它指向的技能正本，按流程核实本单崩溃、取证、定责和回写。一个来源线程只保留一个工单，后续消息并入已有工单。',
  '未确认 OOM 前不写 OOM 结论、打内存标签或改变 TAPD 状态；核实为非 OOM 时只返回非 OOM 结论和证据，不套用 OOM 定责或回写。只有原请求明确要求时，才走技能的一般非 OOM 崩溃取证分支。',
  '没有具体工单或日志目标、只询问方法、普通讨论和纯机器人通知不接。',
].join('\n') }

export const OOM_SCOPE = [
  'UE5/S1Game OOM 分诊：人被 @ 要求处理具体崩溃工单时，先读原始消息和工单，调用 `dsh-superagent-ue5-oom-crash-triage` 并遵循其正本；非 OOM 不套用该分诊流程。',
  '这是调查与回写工单，不要求代码修改或 PR。按技能既定授权完成 TAPD 评论、必要的状态流转、台账和 CrashSight 标签，不自行扩大写入范围。',
].join('\n')
export const OOM_DELIVERY = [
  'UE5/S1Game OOM 分诊在原来源会话交付简洁结论和 TAPD 链接，不因无代码改动而创建 PR、MR 或额外飞书文档。',
  'TAPD 回写先 dry-run；用户环境/硬件类只从 new/in_progress 转已修复（外部原因），游戏侧、未知、哨兵及规则 9 只评论。回写后复核评论、status、resolution、fixer，部分失败要如实报告。',
].join('\n')

function section(original: string, addition: string): string {
  return original.includes(addition) ? original : `${original.trimEnd()}\n${addition}`
}

/** Adds only this integration, preserving all other policy, prompt, source and execution settings. */
export function withOomTriage(settings: Settings, prompts: PromptConfig): { settings: Settings; prompts: PromptConfig } {
  const at = settings.policy.rules.findIndex(rule => rule.id === OOM_RULE.id)
  const rules = at < 0 ? [...settings.policy.rules, OOM_RULE] : settings.policy.rules.map((rule, index) => index === at ? OOM_RULE : rule)
  return { settings: { ...settings, policy: { ...settings.policy, rules } },
    prompts: { ...prompts, scope: section(prompts.scope, OOM_SCOPE), delivery: section(prompts.delivery, OOM_DELIVERY),
      skills: { ...prompts.skills, [OOM_SKILL_NAME]: OOM_SKILL } } }
}

/** The description Sessions exposes for a team skill: its first 120 characters, not YAML frontmatter. */
export const teamSkillDescription = (body: string): string => body.replace(/\s+/g, ' ').slice(0, 120)
