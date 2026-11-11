import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Ticket, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { gongfengKind, pollRound, pollThreads, type GongfengConfig } from '../src/sources/gongfeng.ts'
import { apply as applyGongfeng } from '../src/sources/gongfeng.ts'
import { ciCounts, ciFailures, gongfengThreadContext, mergeChecks, readGongfengResource, readReview } from '../src/sources/gongfeng-read.ts'
import { gongfengLink, sendGongfeng } from '../src/sources/gongfeng-channel.ts'
import { claimMerge, mergeEndNotices, mergeOf, observeMerge, type Merge } from '../src/sources/gongfeng-pull.ts'
import { assignedTo, automated, automatedBody, DISCLOSURE, gongfengAddress, gongfengPage, gongfengThreadId, itemTrigger, mentions, noteTrigger, noteTriggerId,
  reviewTrigger } from '../src/sources/gongfeng-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { readResource, type ResourceHost } from '../src/app/resources.ts'
import { TextCache } from '../src/app/cache.ts'

const PROJECT = { path: 'group/project', id: 42 }
const OTHER = { path: 'group/other', id: 43 }
const ACCOUNT = 'agent-bot'
/** Polling skips items older than the round's cursor, so fixtures are stamped now. */
const NOW = new Date().toISOString().replace('Z', '+0000')
const settings = () => SettingsSchema.parse({
  policy: { sources: { gongfeng: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto' },
  sources: { gongfeng: { enabled: true, config: {
    cli: '/bin/false', projects: [{ path: PROJECT.path, listen: 'addressed' }, { path: OTHER.path, listen: 'all' }],
    observeNotes: true, observeReviews: true, observeCi: true } } },
})
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gongfeng-')), 'db.sqlite'))
  store.saveSettings(settings())
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = testDeployment({ gongfeng: { cli: '/bin/false', login: ACCOUNT, id: 7, projects: [PROJECT, OTHER] } })
  sources.register(gongfengKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn(async () => {}) } as Assessor,
    executor: { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) } as Executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const ctx = sourceContextOf(parts, gongfengKind)
  return { ...parts, ctx, store, engine, sources, commands, board, receive, health: board.all }
}
type Answers = Record<string, unknown>
/**
 * Answers 工蜂 MCP tools by name from `tools`, as the agent's CLI prints them, and records which were called.
 * A value may be a function of the call's arguments, for a tool whose answer depends on them.
 */
function gongfeng(h: ReturnType<typeof host>, tools: Answers) {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  vi.spyOn(h.commands, 'gongfengText').mockImplementation(async (tool: string, args: Record<string, unknown> = {}) => {
    calls.push({ tool, args })
    const route = tools[tool] ?? []
    const value = typeof route === 'function' ? (route as (args: Record<string, unknown>) => unknown)(args) : route
    if (value instanceof Error) throw value
    return JSON.stringify(value)
  })
  vi.spyOn(h.commands, 'gongfeng').mockImplementation((async (schema: { parse(value: unknown): unknown }, tool: string,
    args: Record<string, unknown> = {}) => schema.parse(JSON.parse(await h.commands.gongfengText(tool, args)))) as never)
  vi.spyOn(h.commands, 'gongfengPages').mockImplementation((async (item: { safeParse(value: unknown): { success: boolean; data?: unknown } },
    tool: string, args: Record<string, unknown> = {}) => {
    const listed = JSON.parse(await h.commands.gongfengText(tool, { ...args, page: 1, per_page: 100 })) as unknown[]
    if (!Array.isArray(listed)) return []
    return listed.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  }) as never)
  return calls
}
const user = (username: string) => ({ id: 1, username })
/** A ticket that started on 工蜂, optionally following merge requests. */
const mergeTicket = (id: string, follows: Ticket['follows'] = [], name = 'fix-1'): Ticket =>
  ({ id, title: id, decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'gongfeng', id: 'alice' }, scope: '' },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
    origin: { triggerId: `source-${id}`, triggerIds: [] }, execution: { name, directory: `/w/${name}`, assignment: '' }, follows })
const note = (id: number, body: string, extra: Record<string, unknown> = {}) =>
  ({ id, body, author: user('alice'), created_at: NOW, system: false, ...extra })
const issue = (iid: number, extra: Record<string, unknown> = {}) =>
  ({ id: 7000 + iid, iid, title: `Issue ${iid}`, description: 'Please fix it', state: 'opened', author: user('alice'),
    created_at: NOW, updated_at: NOW, assignees: [], web_url: `https://git.woa.com/${PROJECT.path}/-/issues/${iid}`, ...extra })
const merge = (iid: number, extra: Record<string, unknown> = {}) =>
  ({ id: 9000 + iid, iid, title: `MR ${iid}`, description: 'Change it', state: 'opened', author: user('alice'),
    created_at: NOW, updated_at: NOW, assignees: [],
    source_branch: 'agent/fix-1', target_branch: 'master', web_url: `https://git.woa.com/${PROJECT.path}/-/merge_requests/${iid}`, ...extra })

describe('gongfeng translation', () => {
  it('names one Thread per issue or merge request by project id, so a project rename keeps stored Threads', () => {
    expect(gongfengThreadId(PROJECT, 'issue', 7)).toBe('42:issue:7')
    expect(gongfengThreadId(PROJECT, 'mr', 7)).toBe('42:mr:7')
    expect(gongfengThreadId(PROJECT, 'issue', 7)).not.toBe(gongfengThreadId(PROJECT, 'mr', 7))
  })
  it('turns a mention or an assignment into addressed, and records which one it was', () => {
    expect(mentions('hi @agent-bot please', ACCOUNT)).toBe(true)
    expect(mentions('hi @agent-botx please', ACCOUNT)).toBe(false)
    expect(mentions('mail me at a@agent-bot.example', ACCOUNT)).toBe(false)
    const assigned = itemTrigger(issue(1, { assignees: [user(ACCOUNT)] }), 'issue', PROJECT, ACCOUNT)
    expect(assigned.addressed).toBe('mention')
    expect(assigned.meta.via).toBe('assignee')
    const mentioned = itemTrigger(issue(2, { description: 'ping @agent-bot' }), 'issue', PROJECT, ACCOUNT)
    expect(mentioned.meta.via).toBe('mention')
    expect(itemTrigger(issue(3), 'issue', PROJECT, ACCOUNT)).not.toHaveProperty('addressed')
    expect(assignedTo(issue(1, { assignee: user(ACCOUNT) }), ACCOUNT)).toBe(true)
  })
  it('carries the internal id beside the iid, since the comment tools take the internal one', () => {
    const trigger = itemTrigger(issue(1), 'issue', PROJECT, ACCOUNT)
    expect(trigger.meta).toMatchObject({ iid: 1, id: 7001 })
    expect(trigger.channel!.address).toMatchObject({ iid: '1', id: '7001', kind: 'issue', project: PROJECT.path })
  })
  it('gives an item Trigger a stable id and drops the agent\'s own comments and system notes', () => {
    const first = itemTrigger(issue(1), 'issue', PROJECT, ACCOUNT)
    expect(first.id).toBe(itemTrigger(issue(1, { title: 'Edited' }), 'issue', PROJECT, ACCOUNT).id)
    expect(first).toMatchObject({ source: 'gongfeng', threads: [{ source: 'gongfeng', id: '42:issue:1' }], actor: { source: 'gongfeng', id: 'alice' }, human: true })
    expect(noteTrigger(note(5, 'mine\n\n<!-- dsh-superagent:x -->', { author: user(ACCOUNT) }), issue(1), 'issue', PROJECT, ACCOUNT)).toBeUndefined()
    expect(noteTrigger(note(6, 'system', { system: true }), issue(1), 'issue', PROJECT, ACCOUNT)).toBeUndefined()
  })
  it('keeps a person\'s comment on the account the agent shares with them, since only the marker makes a comment the agent\'s', () => {
    // 工蜂 gives this deployment no bot account of its own: the agent posts as the same login a person uses, so the login
    // cannot mean "the agent wrote this" and dropping every comment carrying it would lose that person's requests.
    const kept = noteTrigger(note(7, 'please also fix the retry', { author: user(ACCOUNT) }), issue(1), 'issue', PROJECT, ACCOUNT)!
    expect(kept).toMatchObject({ human: true, actor: { source: 'gongfeng', id: ACCOUNT }, text: 'please also fix the retry' })
    expect(noteTrigger(note(8, 'done\n\n<!-- dsh-superagent:abc -->', { author: user(ACCOUNT) }), issue(1), 'issue', PROJECT, ACCOUNT))
      .toBeUndefined()
    // A different person's comment is theirs whether or not it carries a marker.
    expect(noteTrigger(note(9, 'hi'), issue(1), 'issue', PROJECT, ACCOUNT)).toMatchObject({ human: true })
  })
  it('makes an edited comment a new event and keeps the comment it answers', () => {
    const base = note(5, 'one', { updated_at: '2026-11-08T02:00:00+0000', parent_id: 4 })
    const edited = { ...base, updated_at: '2026-11-08T03:00:00+0000' }
    expect(noteTrigger(base, issue(1), 'issue', PROJECT, ACCOUNT)!.id).not.toBe(noteTrigger(edited, issue(1), 'issue', PROJECT, ACCOUNT)!.id)
    const trigger = noteTrigger(base, issue(1), 'issue', PROJECT, ACCOUNT)!
    expect(trigger.meta).toMatchObject({ noteId: 5, parentId: 4, kind: 'issue', iid: 1 })
    expect(trigger).not.toHaveProperty('addressed')
    expect(gongfengKind.repliesTo!(trigger)).toBe(noteTriggerId(PROJECT, 'issue', 1, 4))
    expect(noteTrigger(note(7, 'ping @agent-bot'), issue(1), 'issue', PROJECT, ACCOUNT)!.addressed).toBe('mention')
    expect(noteTrigger(note(8, 'plain'), issue(1, { assignees: [user(ACCOUNT)] }), 'issue', PROJECT, ACCOUNT)!.addressed).toBe('mention')
  })
  it('reads a page URL or group/project#iid back into an item, and builds the page URLs', () => {
    expect(gongfengAddress('https://git.woa.com/group/sub/project/-/merge_requests/9')).toEqual({ project: 'group/sub/project', kind: 'mr', iid: 9 })
    expect(gongfengAddress('group/project#12')).toEqual({ project: 'group/project', kind: 'issue', iid: 12 })
    expect(gongfengAddress('nonsense')).toBeUndefined()
    expect(gongfengPage('group/project', 'mr', 3)).toBe('https://git.woa.com/group/project/-/merge_requests/3')
    expect(gongfengPage('group/project', 'issue', 3)).toBe('https://git.woa.com/group/project/-/issues/3')
  })
})
describe('gongfeng polling', () => {
  it('stores each issue and comment once, and moves the cursor after them', async () => {
    const h = host()
    gongfeng(h, { search_project_issues: [issue(1)], search_merge_request: [],
      search_merge_request_notes: [], get_issue_notes: [note(5, 'ping @agent-bot'), note(6, 'noise')] })
    await pollRound(h.ctx)
    const stored = h.receive.mock.calls.map(call => call[0] as Trigger)
    expect(stored.map(trigger => trigger.id)).toContain(key('gongfeng-item', String(PROJECT.id), 'issue', '1'))
    expect(stored.map(trigger => trigger.id)).toContain(key('gongfeng-note', String(PROJECT.id), 'issue', '1', '5', NOW))
    expect(h.store.get(KV.gongfeng.since)).toBeDefined()
  })
  it('skips items the cursor already covers, because the list has no time filter', async () => {
    const h = host()
    // A cursor in the future covers every fixture, so the newest-first stream ends at its first item.
    h.store.set(KV.gongfeng.since, new Date(Date.now() + 3_600_000).toISOString())
    gongfeng(h, { search_project_issues: [issue(1), issue(2)], search_merge_request: [], get_issue_notes: [] })
    await pollRound(h.ctx)
    expect(h.receive.mock.calls.map(call => (call[0] as Trigger).meta.kind)).not.toContain('issue')
  })
  it('reports a project it cannot read without failing the whole round', async () => {
    const h = host()
    gongfeng(h, { search_project_issues: commandError({ stderr: 'HTTP 500' }), search_merge_request: [] })
    await expect(pollRound(h.ctx)).rejects.toThrow(/工蜂 reads failed/)
    expect(h.health.gongfeng?.state).not.toBe('error')
  })
  it('treats a ref with no CI data as no checks, not as a passing result', async () => {
    const h = host()
    gongfeng(h, { get_commit_combined_status: { message: '404 commit check data not found' } })
    expect(await mergeChecks(h.commands, PROJECT, 'master')).toBeUndefined()
  })
  it('reads CI of a merge request an open ticket follows, producing a Trigger only when the checks change', async () => {
    const h = host()
    h.store.tickets.save(mergeTicket('t1', [{ thread: `gongfeng:${PROJECT.id}:mr:3`, own: true }]))
    const checks = [{ name: 'build', state: 'failed' }]
    gongfeng(h, { search_project_issues: [], search_merge_request: [], search_merge_request_notes: [],
      search_merge_request__one: merge(3),
      get_commit_combined_status: () => ({ state: 'failed', checks }) })
    // The ticket's merge request is read by iid through the list tool, so answer that one with the merge.
    vi.spyOn(h.commands, 'gongfeng').mockImplementation((async (schema: { parse(value: unknown): unknown }, tool: string,
      args: Record<string, unknown> = {}) => {
      const value = tool === 'search_merge_request' && args.iid === 3 ? [merge(3)] : JSON.parse(await h.commands.gongfengText(tool, args))
      return schema.parse(value)
    }) as never)
    await pollRound(h.ctx)
    // The first observation only records the baseline.
    expect(h.receive.mock.calls.map(call => (call[0] as Trigger).meta.ci === true)).not.toContain(true)
    checks[0]!.state = 'success'
    await pollRound(h.ctx)
    const changed = h.receive.mock.calls.map(call => call[0] as Trigger).filter(trigger => trigger.meta.ci === true)
    expect(changed.length).toBeGreaterThan(0)
    expect(changed[0]!.meta).toMatchObject({ ci: true, iid: 3, revision: 1 })
    expect(changed[0]!.text).toContain('CI passed')
  })
  it('reads a merge request\'s AI code review, reporting each finding once as context on its thread', async () => {
    const h = host()
    h.store.tickets.save(mergeTicket('t1'))
    expect(claimMerge(h.ctx, 't1', { ...merge(3, { author: user(ACCOUNT) }), project: PROJECT })).toBeUndefined()
    expect(h.store.threads.get('gongfeng:42:mr:3')?.subscriptions).toContain('t1')
    const findings = [{ id: 80049045, content: 'assert on the real string', file_path: 'a/b.py', start_line: 12, level: 2 }]
    gongfeng(h, { search_project_issues: [], search_merge_request: [], search_merge_request_notes: [],
      get_commit_combined_status: { message: '404 commit check data not found' },
      get_review_intelligent_result: () => ({ comments: findings, status: 0, status_text: 'SUCCESS｜已成功', review_id: 119, patch_set_no: 2, head_commit_sha: 'head-2' }) })
    vi.spyOn(h.commands, 'gongfeng').mockImplementation((async (schema: { parse(value: unknown): unknown }, tool: string,
      args: Record<string, unknown> = {}) => {
      const value = tool === 'search_merge_request' && args.iid === 3 ? [merge(3)] : JSON.parse(await h.commands.gongfengText(tool, args))
      return schema.parse(value)
    }) as never)
    await pollRound(h.ctx)
    const reported = () => h.receive.mock.calls.map(call => call[0] as Trigger).filter(trigger => trigger.meta.review === true)
    expect(reported()).toHaveLength(1)
    // AI review is a service, not a person: its findings reach the thread as context and never address the agent.
    expect(reported()[0]).toMatchObject({ human: false, actor: { source: 'gongfeng', id: '' }, threads: [{ source: 'gongfeng', id: '42:mr:3' }] })
    expect(reported()[0]!.text).toContain('assert on the real string')
    expect(reported()[0]!.text).toContain('Read gongfeng/mr/3/review')
    expect(reported()[0]!.meta).toMatchObject({ review: true, reviewId: 119, reviewFindingId: 80049045, patchSet: 2, head: 'head-2', path: 'a/b.py', line: 12 })
    expect(reported()[0]).not.toHaveProperty('addressed')
    expect(reported()[0]!.url).not.toContain('#note_')
    expect(gongfengThreadContext.messageId(reported()[0]!)).toBe('review-119-patch-2-finding-80049045')
    expect(h.store.triggers.disposition(reported()[0]!.id)?.fanout).toContain('t1')
    const input = h.store.tickets.get('t1')!.inputs.find(item => item.kind === 'trigger' && item.triggerId === reported()[0]!.id)!
    expect(input).not.toHaveProperty('human')
    expect(h.store.tickets.get('t1')!.undelivered).toContain(input.id)
    // A repeated poll of the same finding says nothing again.
    await pollRound(h.ctx)
    expect(reported()).toHaveLength(1)
    // An edited finding is a new event, and each report counts a revision so a later one never reuses an earlier Trigger id.
    findings[0]!.content = 'assert on the real string, twice'
    await pollRound(h.ctx)
    expect(reported()).toHaveLength(2)
    expect(reported()[1]!.meta.revision).toBeGreaterThan(reported()[0]!.meta.revision as number)
    expect(reported()[1]!.id).not.toBe(reported()[0]!.id)
  })
  it('delivers AI review to a ready Ticket with an open MR, and keeps same-batch finding ids distinct', async () => {
    const h = host()
    const ticket = mergeTicket('t1')
    h.store.tickets.save(ticket)
    claimMerge(h.ctx, 't1', { ...merge(3, { author: user(ACCOUNT) }), project: PROJECT })
    h.store.tickets.save({ ...h.store.tickets.get('t1')!, assignments: [{ id: 'a1', state: 'running', createdAt: NOW,
      report: { state: 'ready', summary: 'MR ready', at: NOW } }] })
    gongfeng(h, { search_project_issues: [], search_merge_request: [], search_merge_request_notes: [],
      get_commit_combined_status: { message: '404 commit check data not found' },
      get_review_intelligent_result: { status: 0, status_text: 'SUCCESS', review_id: 119, patch_set_no: 2,
        comments: [{ id: 88, content: 'review this head' }, { id: 89, content: 'review this too' }] } })
    vi.spyOn(h.commands, 'gongfeng').mockImplementation((async (schema: { parse(value: unknown): unknown }, tool: string,
      args: Record<string, unknown> = {}) => {
      const value = tool === 'search_merge_request' && args.iid === 3 ? [merge(3)] : JSON.parse(await h.commands.gongfengText(tool, args))
      return schema.parse(value)
    }) as never)
    await pollRound(h.ctx)
    const findings = h.receive.mock.calls.map(call => call[0] as Trigger).filter(trigger => trigger.meta.review === true)
    expect(new Set(findings.map(trigger => trigger.id)).size).toBe(2)
    const reported = findings[0]!
    expect(h.store.tickets.get('t1')!.ended).toBeUndefined()
    expect(h.store.tickets.get('t1')!.inputs.some(input => input.kind === 'trigger' && input.triggerId === reported.id)).toBe(true)
    expect(h.store.tickets.get('t1')!.undelivered.length).toBeGreaterThan(0)
  })
  it('reads no AI review when its switch is off', async () => {
    const h = host()
    h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources,
      gongfeng: { enabled: true, config: { ...h.sources.instance<GongfengConfig>('gongfeng')!.config, observeReviews: false } } } })
    h.store.tickets.save(mergeTicket('t1', [{ thread: `gongfeng:${PROJECT.id}:mr:3`, own: true }]))
    const calls = gongfeng(h, { search_project_issues: [], search_merge_request: [], search_merge_request_notes: [],
      get_commit_combined_status: { message: '404 commit check data not found' }, get_review_intelligent_result: [] })
    vi.spyOn(h.commands, 'gongfeng').mockImplementation((async (schema: { parse(value: unknown): unknown }, tool: string,
      args: Record<string, unknown> = {}) => {
      const value = tool === 'search_merge_request' && args.iid === 3 ? [merge(3)] : JSON.parse(await h.commands.gongfengText(tool, args))
      return schema.parse(value)
    }) as never)
    await pollRound(h.ctx)
    expect(calls.some(call => call.tool === 'get_review_intelligent_result')).toBe(false)
    expect(h.receive.mock.calls.map(call => (call[0] as Trigger).meta.review === true)).not.toContain(true)
  })
  it('keeps an unfinished or unavailable review pending rather than calling it approved', async () => {
    const h = host()
    gongfeng(h, { get_review_intelligent_result: { status: 1001, status_text: 'NO_HISTORY', comments: [] } })
    expect(await readReview(h.commands, PROJECT, 3)).toBeUndefined()
    gongfeng(h, { get_review_intelligent_result: [] })
    expect(await readReview(h.commands, PROJECT, 3)).toBeUndefined()
    gongfeng(h, { get_review_intelligent_result: { status: 0, status_text: 'SUCCESS', comments: [], review_id: 119, patch_set_no: 2, head_commit_sha: 'head-2' } })
    expect(await readReview(h.commands, PROJECT, 3)).toMatchObject({ comments: [], reviewId: 119, patchSet: 2, head: 'head-2' })
  })
  it('reports a finding again on a new patch, not as a note on the old one', async () => {
    const h = host()
    h.store.tickets.save(mergeTicket('t1', [{ thread: `gongfeng:${PROJECT.id}:mr:3`, own: true }]))
    let patch = 2
    const finding = { id: 80049045, content: 'check this', content_hash: 'hash-1', file_path: 'a.py' }
    gongfeng(h, { search_project_issues: [], search_merge_request: [], search_merge_request_notes: [],
      get_commit_combined_status: { message: '404 commit check data not found' },
      get_review_intelligent_result: () => ({ comments: [finding], status: 0, status_text: 'SUCCESS', review_id: 119, patch_set_no: patch, head_commit_sha: `head-${patch}` }) })
    vi.spyOn(h.commands, 'gongfeng').mockImplementation((async (schema: { parse(value: unknown): unknown }, tool: string,
      args: Record<string, unknown> = {}) => {
      const value = tool === 'search_merge_request' && args.iid === 3 ? [merge(3)] : JSON.parse(await h.commands.gongfengText(tool, args))
      return schema.parse(value)
    }) as never)
    await pollRound(h.ctx)
    patch = 3
    await pollRound(h.ctx)
    const reported = h.receive.mock.calls.map(call => call[0] as Trigger).filter(trigger => trigger.meta.review === true)
    expect(reported).toHaveLength(2)
    expect(reported.map(trigger => trigger.meta.patchSet)).toEqual([2, 3])
    expect(new Set(reported.map(trigger => trigger.id)).size).toBe(2)
    expect(h.store.get(KV.gongfeng.review('42:mr:3'))).toMatchObject({ patchSet: 3, head: 'head-3', revision: 2 })
  })
  it('reads an AI finding from its review service, never from ordinary MR notes', async () => {
    const h = host()
    const calls = gongfeng(h, { search_merge_request_notes: [{ id: 1, body: 'wrong conversation' }],
      get_review_intelligent_result: { status: 0, status_text: 'SUCCESS', review_id: 119, patch_set_no: 2, head_commit_sha: 'head-2',
        comments: [{ id: 88, content: 'actual AI finding', file_path: 'a.py', start_line: 4 }] } })
    const trigger = reviewTrigger({ id: 88 }, { reviewId: 119, patchSet: 2, comments: [] }, merge(3), PROJECT, 1)
    h.store.tickets.save(mergeTicket('t1'))
    claimMerge(h.ctx, 't1', { ...merge(3, { author: user(ACCOUNT) }), project: PROJECT })
    h.store.triggers.save(trigger)
    expect(h.store.triggers.get(trigger.id)).toBeDefined()
    gongfeng(h, { search_merge_request: [merge(3)], search_merge_request_notes: [{ id: 1, body: 'wrong conversation' }],
      get_review_intelligent_result: { status: 0, status_text: 'SUCCESS', review_id: 119, patch_set_no: 2, head_commit_sha: 'head-2',
        comments: [{ id: 88, content: 'actual AI finding', file_path: 'a.py', start_line: 4 }] } })
    const body = await gongfengThreadContext.read(h.commands, trigger, 'thread', undefined, h.sources.instance<GongfengConfig>('gongfeng')!.config)
    expect(body.status).toBe('ai_review')
    expect(body.messages[0]).toMatchObject({ id: 'review-119-patch-2-finding-88', text: 'actual AI finding', bot: true, path: 'a.py', line: 4 })
    expect(calls.some(call => call.tool === 'search_merge_request_notes')).toBe(false)
    expect(await readGongfengResource(h.commands, PROJECT, 'mr/3/review')).toMatchObject({ reviewId: 119, patchSet: 2, approval: false })
    // The worker reads this resource through its own Ticket, not the AI finding as a human Trigger.
    vi.spyOn(h.commands, 'deployment', 'get').mockReturnValue({ ...h.commands.deployment, gongfeng: { ...h.deployment.gongfeng!, projects: [PROJECT] } })
    const resources = { store: h.store, pages: new TextCache(10000), masterId: 'master', commands: h.commands,
      promptVersion: () => { throw new Error('not used') }, mayRead: () => false, feishuPageSize: () => 20,
      sourceLink: async () => ({}), threadContext: () => undefined } as unknown as ResourceHost
    const page = await readResource(resources, 'gongfeng/mr/3/review', 0, undefined, 't1')
    expect(page).toMatchObject({ resource: 'gongfeng/mr/3/review', text: expect.stringContaining('actual AI finding') })
  })
  it('does not resume an ended Ticket for an AI finding', async () => {
    const h = host()
    const ticket = { ...mergeTicket('t1', [{ thread: `gongfeng:${PROJECT.id}:mr:3`, own: true }]),
      ended: { at: NOW, by: 'executor' as const, reason: 'closed', outcome: 'closed' as const } }
    h.store.tickets.save(ticket)
    const trigger = reviewTrigger({ id: 88, content: 'finding' }, { comments: [] }, merge(3), PROJECT, 1)
    h.receive(trigger)
    expect(h.store.tickets.get('t1')!.ended).toBeDefined()
    expect(h.store.tickets.get('t1')!.inputs).toEqual([])
  })
  it('receives an open item only, while still observing a merge request so a ticket following it can end', async () => {
    const h = host()
    h.store.tickets.save(mergeTicket('t1', [{ thread: `gongfeng:${PROJECT.id}:mr:3`, own: true }]))
    // PROJECT listens to addressed items only, so this issue has to name the agent to be received at all.
    gongfeng(h, { search_project_issues: [issue(1, { description: 'ping @agent-bot' }), issue(2, { state: 'closed' })],
      search_merge_request: [merge(3, { state: 'merged', merged_at: NOW })],
      get_issue_notes: [], search_merge_request_notes: [] })
    await pollRound(h.ctx)
    // A comment Trigger carries the item's iid too, so the item Triggers are told apart by their own id.
    const itemId = key('gongfeng-item', String(PROJECT.id), 'issue', '1')
    const items = h.receive.mock.calls.map(call => call[0] as Trigger).filter(trigger => trigger.id === itemId)
    expect(items.map(trigger => trigger.meta.iid)).toEqual([1])
    expect(h.store.tickets.get('t1')!.ended).toMatchObject({ outcome: 'merged' })
  })
  it('polls the threads that have tickets', async () => {
    const h = host()
    h.store.threads.save({ key: `gongfeng:${PROJECT.id}:issue:1`, ref: { source: 'gongfeng', id: `${PROJECT.id}:issue:1` },
      createdAt: new Date().toISOString(), subscriptions: ['t1'], correlated: [], pending: [], meta: {} })
    gongfeng(h, { search_project_issues: [issue(1)], get_issue_notes: [note(5, 'ping @agent-bot')] })
    await pollThreads(h.ctx)
    expect(h.receive.mock.calls.map(call => (call[0] as Trigger).meta.noteId)).toContain(5)
  })
})
describe('gongfeng scope and policy', () => {
  const config: GongfengConfig = { cli: '', projects: [{ path: PROJECT.path, listen: 'addressed' }, { path: OTHER.path, listen: 'all' }],
    pollSeconds: 60, failuresBeforeError: 3, observeNotes: true, observeReviews: true, observeCi: true }
  it('receives only configured projects, and observes the ones set to all', () => {
    expect(gongfengKind.scope!({ meta: { project: PROJECT.path, kind: 'issue' } }, config)).toEqual({ listened: true, observed: false, row: 'issues' })
    expect(gongfengKind.scope!({ meta: { project: OTHER.path, kind: 'issue' } }, config)).toEqual({ listened: true, observed: true, row: 'issues' })
    expect(gongfengKind.scope!({ meta: { project: 'group/unlisted', kind: 'issue' } }, config)).toEqual({ listened: false, reason: 'project_not_listed' })
    expect(gongfengKind.scope!({ meta: { project: PROJECT.path, ci: true } }, config)).toEqual({ listened: true, observed: true, row: 'ci' })
  })
  it('offers projects, comments, AI review and CI, with review fixed to context-only', () => {
    const rows = gongfengKind.policy!.rows!(config)
    expect(rows.map(row => row.id)).toEqual([PROJECT.path, OTHER.path, 'comments', 'reviews', 'ci'])
    const scoped = gongfengKind.scope!({ meta: { project: PROJECT.path, noteId: 1 } }, config)
    expect('row' in scoped && rows.some(row => row.id === scoped.row)).toBe(true)
    expect(rows[0]!.cells.listedUnaddressed).toBe(false)
    expect(rows[1]!.cells.listedUnaddressed).toBe(true)
    expect(gongfengKind.scope!({ meta: { project: PROJECT.path, review: true } }, config)).toEqual({ listened: true, observed: false, row: 'reviews' })
    expect(rows.at(-2)!.note.en).toBe('Context only')
    expect(rows.at(-1)!.cells.unlistedUnaddressed).toBe(true)
  })
  it('names the reason a person\'s assignment or mention reaches the agent', () => {
    expect(gongfengKind.policy!.explicit.en).toContain('assigns')
  })
})
describe('gongfeng channel', () => {
  const target = { project: PROJECT.path, kind: 'issue', iid: '1', id: '7001' }
  const message = { id: 'reply-1', channel: { source: 'gongfeng', thread: '42:issue:1', address: target }, text: 'Fixed.', kind: 'reply' as const }
  it('posts a comment once, and finds its marker before posting again', async () => {
    const h = host()
    let written = false
    const calls = gongfeng(h, { get_issue_notes: () => written ? [{ id: 1, body: 'Fixed.\n\n<!-- dsh-superagent:reply-1 -->' }] : [] })
    expect(await sendGongfeng(h, message as never)).toBe('sent')
    const posted = calls.filter(call => call.tool === 'create_issue_note')
    expect(posted).toHaveLength(1)
    expect(posted[0]!.args).toMatchObject({ project_id: PROJECT.path, issue_id: 7001 })
    expect(String(posted[0]!.args.note_message)).toContain('<!-- dsh-superagent:reply-1 -->')
    written = true
    expect(await sendGongfeng(h, message as never)).toBe('sent')
    expect(calls.filter(call => call.tool === 'create_issue_note')).toHaveLength(1)
  })
  it('says an automated agent wrote every comment, since it posts as a person\'s account rather than a bot', async () => {
    const h = host()
    const calls = gongfeng(h, { get_issue_notes: [] })
    await sendGongfeng(h, message as never)
    const body = String(calls.find(call => call.tool === 'create_issue_note')!.args.note_message)
    // The line leads, so a reader sees it before the content, and the marker closes, so this Source reads it back as its own.
    expect(body.startsWith(DISCLOSURE)).toBe(true)
    expect(automated(body)).toBe(true)
    expect(body).toContain('Fixed.')
  })
  it('answers gone for a deleted item and throws so the outbox retries anything else', async () => {
    const h = host()
    gongfeng(h, { get_issue_notes: commandError({ stderr: 'HTTP 404' }) })
    expect(await sendGongfeng(h, message as never)).toBe('gone')
    const h2 = host()
    gongfeng(h2, { get_issue_notes: commandError({ stderr: 'HTTP 500' }) })
    await expect(sendGongfeng(h2, message as never)).rejects.toThrow()
  })
  it('links an address to its page and refuses one the Source no longer receives', () => {
    expect(gongfengLink({ project: PROJECT.path, kind: 'mr', iid: '3' }, {}).url).toBe(gongfengPage(PROJECT.path, 'mr', 3))
    const config: GongfengConfig = { cli: '', projects: [{ path: PROJECT.path, listen: 'addressed' }], pollSeconds: 60,
      failuresBeforeError: 3, observeNotes: true, observeReviews: true, observeCi: true }
    expect(gongfengKind.channel!.allowed!({ project: PROJECT.path }, config)).toBe(true)
    expect(gongfengKind.channel!.allowed!({ project: 'gone/project' }, config)).toBe(false)
  })
})
describe('gongfeng merge requests', () => {
  const opened = (iid: number, extra: Record<string, unknown> = {}): Merge => ({ ...merge(iid, extra), project: PROJECT } as Merge)
  const ticket = mergeTicket
  it('binds the agent\'s merge request from the ticket branch and refuses another ticket\'s', () => {
    const h = host()
    h.store.tickets.save(ticket('t1'))
    expect(claimMerge(h.ctx, 't1', opened(3, { author: user(ACCOUNT) }))).toBeUndefined()
    expect(mergeOf(h.store.tickets.get('t1')!, [PROJECT], true)).toEqual({ project: PROJECT, iid: 3 })
    h.store.tickets.save(ticket('t2'))
    expect(claimMerge(h.ctx, 't2', opened(3, { author: user(ACCOUNT) }))).toBe('Merge request already belongs to another active ticket')
    h.store.tickets.save(ticket('t3', [], 'elsewhere'))
    expect(claimMerge(h.ctx, 't3', opened(4, { author: user('someone'), source_branch: 'other' }))).toContain('does not belong to this ticket')
  })
  it('ends the tickets that follow a merged or closed merge request', async () => {
    const h = host()
    h.store.tickets.save(ticket('t1', [{ thread: `gongfeng:${PROJECT.id}:mr:3`, own: true }]))
    expect(await observeMerge(h.ctx, opened(3, { state: 'merged', merged_at: '2026-11-08T02:00:00Z' }))).toBe(true)
    expect(h.store.tickets.get('t1')!.ended).toMatchObject({ outcome: 'merged' })
  })
  it('notices a merge to the ticket\'s other conversations, and not to 工蜂 itself', () => {
    const ended = { ...ticket('t1'),
      channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1' } }, { source: 'gongfeng', thread: '42:mr:3', address: {} }],
      follows: [{ thread: `gongfeng:${PROJECT.id}:mr:3`, own: true, closed: { at: '2026-11-08T02:00:00Z', outcome: 'merged' as const } }],
      ended: { at: '2026-11-08T02:00:00Z', by: 'executor' as const, reason: 'merged', outcome: 'merged' as const } }
    const notices = mergeEndNotices(ended as Ticket, '请修一下这个 bug', [PROJECT])
    expect(notices).toHaveLength(1)
    expect(notices[0]!.channel.source).toBe('feishu')
    expect(notices[0]!.text).toContain('已合并')
  })
})
describe('gongfeng reads', () => {
  it('counts failing and running checks, and names the failures', async () => {
    const h = host()
    gongfeng(h, { get_commit_combined_status: { state: 'failed', checks: [{ name: 'build', state: 'failed' }, { name: 'lint', state: 'pending' }] } })
    const snapshot = (await mergeChecks(h.commands, PROJECT, 'agent/fix-1'))!
    expect(ciCounts(snapshot)).toEqual({ failed: 1, running: 1 })
    expect(ciFailures(snapshot)).toEqual(['build'])
  })
  it('reads a conversation with its description first, and the next page by cursor', async () => {
    const h = host()
    gongfeng(h, { search_project_issues: [issue(1)],
      get_issue_notes: Array.from({ length: 100 }, (_, i) => note(i + 1, `comment ${i + 1}`)) })
    const trigger = itemTrigger(issue(1), 'issue', PROJECT, ACCOUNT)
    const first = await gongfengThreadContext.read(h.commands, trigger, 'thread', undefined, undefined)
    expect(first.messages[0]!.text).toContain('Issue 1')
    expect(first.next).toBe('2')
    expect(gongfengThreadContext.messageId(trigger)).toBe('1')
    gongfeng(h, { search_project_issues: [issue(1)], get_issue_notes: [] })
    expect((await gongfengThreadContext.read(h.commands, trigger, 'thread', '2', undefined)).next).toBeUndefined()
  })
  it('reads its own `gongfeng/` resource paths and refuses another shape', async () => {
    const h = host()
    gongfeng(h, { search_project_issues: [issue(1)] })
    expect(await readGongfengResource(h.commands, PROJECT, 'issue/1')).toMatchObject({ iid: 1, kind: 'issue' })
    await expect(readGongfengResource(h.commands, PROJECT, 'nonsense')).rejects.toThrow(/Use gongfeng/)
  })
})
describe('gongfeng plugin', () => {
  it('registers its kind, reports setup pending before setup resolves, and unregisters on disposal', async () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'gongfeng-plugin-')), 'db.sqlite'))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    const deployment = testDeployment({ gongfeng: undefined })
    const parts: SourceContextDeps = { store, engine: { bindThread: vi.fn(), threadClosed: vi.fn() }, outbox: { send: vi.fn() },
      commands: new Commands(() => deployment, {}, new AbortController().signal), sources, deployment,
      ready: Promise.resolve(), configured: () => false, receive: vi.fn() }
    const disposers: (() => unknown)[] = []
    applyGongfeng({ orchestrator: { sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) },
      effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(board.all.gongfeng).toBeDefined())
    expect(sources.kind('gongfeng')).toBe(gongfengKind)
    expect(board.all.gongfeng).toMatchObject({ state: 'paused', code: 'setupPending' })
    for (const dispose of disposers) await dispose()
    expect(sources.kind('gongfeng')).toBeUndefined()
    store.close()
  })
})
