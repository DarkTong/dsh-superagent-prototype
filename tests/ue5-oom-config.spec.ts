import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Prompts, defaultPrompts } from '../src/app/prompts.ts'
import { OOM_DELIVERY, OOM_RULE, OOM_RUNTIME_SKILL_NAME, OOM_SCOPE, OOM_SKILL, OOM_SKILL_NAME, OOM_SKILL_ROOT,
  teamSkillDescription, withOomTriage } from '../src/app/ue5-oom-config.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'

it('puts every OOM trigger branch in the 120-character routing description, before any heading or path', () => {
  const description = teamSkillDescription(OOM_SKILL)
  const routing = OOM_SKILL.split('\n')[0]!.trim()
  expect(routing.length).toBeLessThan(120)
  expect(description.startsWith(routing)).toBe(true)
  expect(OOM_SKILL.startsWith('处理UE5/S1Game')).toBe(true)
  expect(OOM_SKILL.startsWith('#') || OOM_SKILL.startsWith('---')).toBe(false)
  for (const term of ['OOM', 'Ran out of memory', '被@', 'TAPD', 'CrashSight', '先核实OOM', '取证、定责和回写']) {
    expect(description).toContain(term)
  }
  expect(OOM_SKILL).toContain(OOM_SKILL_ROOT)
  expect(OOM_SKILL).toContain('crashsight_tag_library.md')
  expect(OOM_SKILL).toContain('leak_registry.md')
})

it('adds one rule, one team skill and two worker instructions without changing existing configuration', () => {
  const settings = SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { cli: 'lark' } } },
    policy: { rules: [{ id: 'existing', name: 'Existing', enabled: true, instruction: 'Keep this rule.' }],
      sources: { feishu: { allowed: [{ id: 'ou_person' }] } } },
    eval: { mode: 'auto' }, executor: { maxWorkers: 7 } })
  const prompts = { ...defaultPrompts(), scope: 'Existing scope.', delivery: 'Existing delivery.',
    skills: { existing: 'Existing skill.' } }
  const next = withOomTriage(settings, prompts)
  expect(next.settings.policy.rules).toEqual([settings.policy.rules[0], OOM_RULE])
  expect(next.settings.sources).toBe(settings.sources)
  expect(next.settings.policy.sources).toBe(settings.policy.sources)
  expect(next.settings.eval).toBe(settings.eval)
  expect(next.settings.executor).toBe(settings.executor)
  expect(next.prompts.skills).toEqual({ existing: 'Existing skill.', [OOM_SKILL_NAME]: OOM_SKILL })
  expect(next.prompts.scope).toBe(`Existing scope.\n${OOM_SCOPE}`)
  expect(next.prompts.delivery).toBe(`Existing delivery.\n${OOM_DELIVERY}`)
  expect(OOM_SCOPE).toContain(OOM_RUNTIME_SKILL_NAME)
  expect(withOomTriage(next.settings, next.prompts)).toEqual(next)
})

it('persists a validated team skill that worker prompts reference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ue5-oom-config-'))
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  try {
    const settings = store.settings()
    const prompts = new Prompts(store, () => 100000, () => [], () => false)
    const current = prompts.current()
    const next = withOomTriage(settings, current.config)
    store.saveSettings(next.settings, { source: 'panel', block: 'policy', policyVersion: '', policyChanged: true, notified: [] })
    prompts.save(next.prompts, current.revision, 'panel')
    expect(prompts.skills(prompts.current().config)).toContainEqual([OOM_SKILL_NAME, OOM_SKILL])
    expect(prompts.compose(prompts.current().config, 'worker')).toContain(OOM_SCOPE)
    expect(prompts.compose(prompts.current().config, 'worker')).toContain(OOM_DELIVERY)
    expect(prompts.compose(prompts.current().config, 'orchestrator')).toContain(OOM_RULE.instruction.replace(/\s*\n\s*/g, ' '))
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})
