/**
 * 配置 superagent 的 UE5 OOM 规则和执行器技能，不改工蜂授权或其他已有设置。
 *   npx tsx scripts/ue5-oom-into-superagent.ts           # 预览
 *   npx tsx scripts/ue5-oom-into-superagent.ts --write   # 备份后落库
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prompts } from '../src/app/prompts.ts'
import { Store } from '../src/app/store.ts'
import { policyVersion } from '../src/policy.ts'
import { OOM_RULE, OOM_SKILL_NAME, OOM_RUNTIME_SKILL_NAME, OOM_SKILL_ROOT, teamSkillDescription, withOomTriage } from '../src/app/ue5-oom-config.ts'

const HOME = process.env.USERPROFILE ?? ''
const STATE = join(HOME, '.dsh', 'state', 'superagent')
const store = new Store(join(STATE, 'orchestrator.sqlite'))
try {
  const settings = store.settings()
  const prompts = new Prompts(store, () => 100000, () => undefined, () => false)
  const current = prompts.current()
  const next = withOomTriage(settings, current.config)
  prompts.validate(next.prompts)
  const policyChanged = JSON.stringify(settings) !== JSON.stringify(next.settings)
  const promptsChanged = JSON.stringify(current.config) !== JSON.stringify(next.prompts)
  const skill = next.prompts.skills[OOM_SKILL_NAME]!
  const description = teamSkillDescription(skill)
  const routing = skill.split('\n')[0]!.trim()
  if (routing.length > 120 || !description.startsWith(routing) || !skill.startsWith('处理UE5/S1Game')) {
    throw new Error('The OOM routing sentence must fit completely in the first 120 characters')
  }
  for (const path of ['SKILL.md', 'crashsight_tag_library.md', 'leak_registry.md'].map(name => join(OOM_SKILL_ROOT, name))) {
    if (!existsSync(path)) throw new Error(`Missing OOM skill resource: ${path}`)
  }

  console.log(`policy changed: ${policyChanged} (revision ${store.blockRevision('policy')})`)
  console.log(`prompts changed: ${promptsChanged} (revision ${current.revision})`)
  console.log(`runtime skill: ${OOM_RUNTIME_SKILL_NAME}`)
  console.log(`description (${description.length} chars): ${description}`)
  console.log(`--- ${OOM_RULE.id} ---\n${OOM_RULE.instruction}`)

  if (process.argv.includes('--write')) {
    if (!policyChanged && !promptsChanged) { console.log('\nAlready configured; no version written.'); process.exitCode = 0 }
    else {
      const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
      const backup = join(STATE, 'backups', `ue5-oom-${stamp}`)
      mkdirSync(backup, { recursive: true })
      writeFileSync(join(backup, 'settings.json'), JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 })
      writeFileSync(join(backup, 'prompts.json'), JSON.stringify(current, null, 2), { encoding: 'utf8', mode: 0o600 })
      store.atomic(() => {
        if (policyChanged) store.saveSettings(next.settings, { source: 'panel', block: 'policy',
          policyVersion: policyVersion(next.settings), policyChanged: true, notified: [] })
        if (promptsChanged) prompts.save(next.prompts, current.revision, 'panel')
      })
      console.log(`\nBackup: ${backup}`)
      console.log(`Written: policy=${store.blockRevision('policy')}, prompts=${prompts.current().revision}; applies on subsequent model requests.`)
    }
  } else console.log('\n(dry run; pass --write to back up and save)')
} finally { store.close() }
