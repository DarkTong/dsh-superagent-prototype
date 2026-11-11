/** 工蜂 Source kind definition, project polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key } from '../core/index.ts'
import { GongfengAccountsSchema } from '../deployment.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { gongfengLink, sendGongfeng } from './gongfeng-channel.ts'
import { ciCounts, ciFailures, ciSummary, gongfengThreadContext, mergeChecks, readReview } from './gongfeng-read.ts'
import { mergeEndNotices, mergeOf, observeMerge, readMerge, type Merge } from './gongfeng-pull.ts'
import { ciTrigger, gongfengAddress, gongfengPage, gongfengThreadId, gongfengTime, GongfengItemSchema, GongfengNoteSchema, itemTrigger, noteTrigger, noteTriggerId,
  reviewTrigger, reviewFindingKey, SOURCE, type GongfengItem, type GongfengKind, type GongfengNote, type GongfengProjectRef,
  type GongfengReviewComment } from './gongfeng-trigger.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import type { Localized, SourceKind } from './kind.ts'

/** What each configured project does: which streams are read, and whether the Source acts on the whole project or only on what addresses it. */
const ProjectSchema = z.object({
  path: z.string().trim().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/, 'group/project'),
  /** `all` also receives new issues and merge requests nobody assigned or mentioned, and the admission table decides them. */
  listen: z.enum(['addressed', 'all']).default('addressed'),
}).strict()
/**
 * The Source's own configuration: the account fields setup reads (`cli`, a plain `projects` list of paths) plus the
 * per-project setting and the polling knobs. The stored shape keeps `projects` as rows of `{path, listen}`.
 */
const GongfengConfigSchema = GongfengAccountsSchema.omit({ projects: true }).extend({
  projects: z.array(ProjectSchema).default([]),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  /** Receive the comments of every issue and merge request in the listed projects, not only those that have a ticket. */
  observeNotes: z.boolean().default(true),
  /** Receive the AI code review findings on merge requests an open ticket follows. */
  observeReviews: z.boolean().default(true),
  /** Receive merge request CI status changes on merge requests an open ticket follows. */
  observeCi: z.boolean().default(true),
}).strict()
export type GongfengConfig = z.infer<typeof GongfengConfigSchema>
const OBSERVED = { issues: 'listen', pulls: 'listen', comments: 'observeNotes', reviews: 'observeReviews', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
/** Which admission row a Trigger belongs to, from its `meta` alone. */
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return 'ci'
  if (meta.review === true) return 'reviews'
  if (meta.noteId !== undefined) return 'comments'
  return meta.kind === 'mr' ? 'pulls' : meta.kind === 'issue' ? 'issues' : undefined
}
/** A project resolved to its id, from the deployment when setup knows it and otherwise from the Source's own cache. */
const projectsOf = (ctx: SourceContext, config: GongfengConfig): GongfengProjectRef[] =>
  config.projects.flatMap(({ path }) => {
    const id = ctx.deployment.gongfeng?.projects.find(item => item.path === path)?.id
      ?? Number(ctx.state.get(KV.gongfeng.projects)?.[path])
    return id ? [{ path, id }] : []
  })
export const gongfengKind: SourceKind<GongfengConfig> = {
  kind: SOURCE,
  title: { zh: '工蜂', en: '工蜂' },
  description: { zh: '智能体的工蜂账号；接收指派给它或在评论里 @ 它的议题与合并请求，观察 CI 与合并关闭。',
    en: 'The agent\'s 工蜂 account; receives issues and merge requests assigned to it or mentioning it, and their CI and merge or close.' },
  schema: GongfengConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '智能体的工蜂 CLI', en: 'Agent 工蜂 CLI' },
      hint: { zh: '命令名或绝对路径，指向以智能体账号访问工蜂 API 的 wrapper；执行器以 gongfeng-mcp 调用它。令牌放在 wrapper 自己的配置里，不要填在这里。保存时读取账号与项目，然后重启 dsh-superagent。',
        en: 'A command name or absolute path of a wrapper that reaches the 工蜂 API as the agent account; the Executor calls it as gongfeng-mcp. Keep the token in the wrapper\'s own configuration, not here. Saving reads the account and the projects, then restarts dsh-superagent.' } },
    { key: 'projects', type: 'rows', label: { zh: '监听的项目', en: 'Projects' },
      hint: { zh: '写作 group/project。每个项目按下面的设置接收：仅“指派给它”时，只有指派或 @ 智能体的才接收；“全部”也接收没人指派的新议题与合并请求，由策略的接收表决定是否成为候选。',
        en: 'Written group/project. Each project is received by the setting beside it: "Assigned" receives only what is assigned to or mentions the agent; "All" also receives issues and merge requests nobody assigned, and the Policy\'s admission table decides them.' },
      columns: [
        { key: 'path', type: 'text', label: { zh: '项目', en: 'Project' }, pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'addressed', label: { zh: '仅指派与 @', en: 'Assigned or @' } },
          { value: 'all', label: { zh: '全部', en: 'All' } }] },
      ] },
    { key: 'observeNotes', type: 'switch', label: { zh: '接收评论', en: 'Receive comments' },
      hint: { zh: '打开后，监听项目里所有议题和合并请求的评论都会收到；关掉就只收有工单的线程里的评论。', en: 'Every comment on issues and merge requests in the watched projects is received; with it off, only Threads that have Tickets.' } },
    { key: 'observeReviews', type: 'switch', label: { zh: '接收 AI 代码评审', en: 'Receive AI code review' },
      hint: { zh: '打开后，有工单跟着的合并请求上工蜂的 AI 代码评审意见会收到。AI 评审不是账号，永不算作人的请求；执行器逐条按结果处理。',
        en: 'AI code review findings on merge requests an open ticket follows are received. AI review is a service rather than an account, never a person\'s request; the Executor answers each by outcome.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收合并请求的 CI', en: 'Receive merge request CI' },
      hint: { zh: '打开后，有工单跟着的合并请求的 CI 失败和恢复会收到。', en: 'CI failures on merge requests an open ticket follows, and their recovery, are received.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
  ],
  // A project received in full observes everything there; otherwise only what addresses the agent is observed.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    const project = config.projects.find(item => item.path === String(meta.project ?? ''))
    if (!project) return { listened: false, reason: 'project_not_listed' }
    const observed = row === 'ci' ? config.observeCi : row === 'comments' ? config.observeNotes
      : row === 'issues' || row === 'pulls' ? project.listen === 'all' : false
    // AI findings fan out to existing Tickets, but are inadmissible as new work even without a live subscription.
    if (row === 'reviews') return { listened: true, observed: false, row: 'reviews' }
    return { listened: true, observed, ...row ? { row } : {} }
  },
  health: ['gongfeng'],
  channel: { allowed: (address, config) => config.projects.some(item => item.path === address.project), send: sendGongfeng, link: gongfengLink },
  threadContext: gongfengThreadContext,
  /** `#12`, `<project>#12`, or an issue or merge request page names that Thread. */
  find: query => {
    const found = gongfengAddress(query)
    if (!found) return { threads: [], terms: [] }
    // Stored Threads are keyed by the project id, which the query does not name; the terms still find the Trigger.
    return { threads: [], terms: [`${found.project}#${found.iid}`] }
  },
  // A comment's Trigger is named after the comment, so the one it answers is named after its parent.
  repliesTo: trigger => typeof trigger.meta.parentId === 'number'
    ? noteTriggerId({ path: String(trigger.meta.project), id: Number(trigger.meta.projectId) },
      String(trigger.meta.kind) === 'mr' ? 'mr' : 'issue', Number(trigger.meta.iid), trigger.meta.parentId) : undefined,
  policy: {
    unnamed: { person: { zh: '工蜂用户', en: '工蜂 user' }, bot: { zh: '工蜂机器人', en: '工蜂 bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), name: z.string().trim().max(100).optional() }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), name: z.string().trim().max(100).optional() }).strict()).optional(),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的工蜂账号', en: '工蜂 accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号的评论在来源收到时成为推断的候选；它们不能发起明确的请求，也不能停止工单。',
        en: 'A comment of a bot account on this list becomes an inferred candidate when the Source receives it; such a comment never makes an explicit request or stops a ticket.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号把议题或合并请求指派给智能体，或在评论里 @ 智能体的账号。',
      en: 'An account on the list assigns the issue or merge request to the agent, or mentions the agent\'s account in a comment.' },
    rows(stored) {
      const config = GongfengConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅指派与 @', en: 'Assigned or @' }
      return [
        ...(config.projects ?? []).map(project => ({ id: project.path, label: project.path, note: note(project.listen === 'all'),
          cells: { listedUnaddressed: project.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: project.listen === 'all' } })),
        { id: 'comments', label: { zh: '评论', en: 'Comments' }, note: note(config.observeNotes),
          cells: { listedUnaddressed: !!config.observeNotes, unlistedAddressed: true, unlistedUnaddressed: !!config.observeNotes } },
        // Existing Tickets receive AI findings by fan-out; this row never grants a new mandate.
        { id: 'reviews', label: { zh: 'AI 代码评审（仅既有工单）', en: 'AI code review (existing Tickets only)' },
          note: { zh: '只作上下文', en: 'Context only' }, cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true } },
        // CI has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'ci', label: { zh: '合并请求的 CI', en: 'Merge request CI' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GONGFENG_ACCOUNT', description: { zh: '智能体的工蜂账号；gongfeng-mcp 以它行事', en: 'The agent\'s 工蜂 account; gongfeng-mcp acts as it' } },
      { key: 'DSH_SUPERAGENT_GONGFENG_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱；账号没报邮箱时为空',
        en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none; empty when the account reports no email' } },
      { key: 'DSH_SUPERAGENT_GONGFENG_PROJECT', description: { zh: '接下工单的工蜂项目，group/project；工单不是从工蜂来的时为空',
        en: 'The 工蜂 project that started the ticket, as group/project; empty when the ticket did not start on 工蜂' } },
      { key: 'DSH_SUPERAGENT_GONGFENG_KIND', description: { zh: '接下工单的是 issue 还是 mr；工单不是从工蜂来的时为空',
        en: 'Whether an issue or an mr started the ticket; empty when the ticket did not start on 工蜂' } },
      { key: 'DSH_SUPERAGENT_GONGFENG_IID', description: { zh: '接下工单的议题或合并请求在项目内的编号；工单不是从工蜂来的时为空',
        en: 'The iid of the issue or merge request that started the ticket; empty when the ticket did not start on 工蜂' } },
      { key: 'DSH_SUPERAGENT_GONGFENG_MERGE_REQUEST', description: { zh: '工单的合并请求编号（iid），分支末段是 DSH_SUPERAGENT_NAME 时关联到工单；没有时为空',
        en: 'The ticket\'s merge request iid; a merge request from a branch whose last path segment is DSH_SUPERAGENT_NAME binds to the ticket; empty when there is none' } },
    ],
    values: ({ deployment, trigger }) => {
      const source = trigger?.source === SOURCE ? trigger : undefined
      const project = source ? String(source.meta.project ?? '') : ''
      const kind = source ? String(source.meta.kind ?? '') : ''
      return { DSH_SUPERAGENT_GONGFENG_ACCOUNT: deployment.gongfeng?.login ?? '', DSH_SUPERAGENT_GONGFENG_COMMIT_EMAIL: deployment.gongfeng?.email ?? '', DSH_SUPERAGENT_GONGFENG_PROJECT: project,
        DSH_SUPERAGENT_GONGFENG_KIND: kind, DSH_SUPERAGENT_GONGFENG_IID: source ? String(source.meta.iid ?? '') : '',
        DSH_SUPERAGENT_GONGFENG_MERGE_REQUEST: kind === 'mr' ? String(source?.meta.iid ?? '') : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gongfeng
    ? { cli: { zh: `当前账号 @${deployment.gongfeng.login}，${deployment.gongfeng.projects.length} 个项目`, en: `Current account @${deployment.gongfeng.login}, ${deployment.gongfeng.projects.length} projects` } }
    : {},
}

/** The 工蜂 Source's settings, falling back to schema defaults while its plugin is disabled. */
export const gongfengSettings = (sources: { instance<C extends Record<string, unknown>>(id: string): { config: C } | undefined }): GongfengConfig =>
  sources.instance<GongfengConfig>(SOURCE)?.config ?? GongfengConfigSchema.parse({})

export const name = 'dsh-superagent-gongfeng'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gongfengKind), 'gongfeng: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gongfengKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gongfeng', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the account; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('gongfeng', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GongfengConfig>(SOURCE)
    if (config) {
      try { await pollRound(ctx, signal); failures = 0 }
      catch (error) {
        failures += 1
        // One network failure is retried next round; three in a row need a person.
        if (!signal.aborted && failures >= config.failuresBeforeError) {
          ctx.report('gongfeng', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    } else ctx.report('gongfeng', health('paused', 'sourceOff'))
    await pause((ctx.config<GongfengConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round { started: string; signal?: AbortSignal | undefined; failures: string[]; tally: Tally; merges: Map<string, Promise<void>> }
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, failures: [], tally: { skipped: 0 }, merges: new Map() })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
/**
 * One polling round: each configured project's streams, then the merge requests of open tickets with their CI, then the
 * Threads with Tickets. Each step and each item fails independently so every step runs before the round fails.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const round = newRound(signal)
  const config = ctx.config<GongfengConfig>(SOURCE)
  if (!config) return
  if (signal?.aborted) return
  // The project ids the Threads are keyed by, refreshed each round so a project created or renamed since setup resolves.
  ctx.state.set(KV.gongfeng.projects, Object.fromEntries(projectsOf(ctx, config).map(project => [project.path, String(project.id)])))
  // The first cursor steps back so an item created just as the round starts is not missed; ids deduplicate the overlap.
  if (ctx.state.get(KV.gongfeng.since) === undefined) ctx.state.set(KV.gongfeng.since, cursorAt(round.started))
  const since = ctx.state.get(KV.gongfeng.since) ?? cursorAt(round.started)
  for (const project of projectsOf(ctx, config)) {
    if (stopped(ctx, round)) return
    if (!project.id) { round.failures.push(`${project.path}: project not resolved`); continue }
    await pollProject(ctx, round, project, config, since)
  }
  await pollTicketMerges(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if (signal?.aborted) return
  if (round.failures.length) throw new Error(`${round.failures.length} 工蜂 reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const skipped = round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''
  ctx.report('gongfeng', { state: 'ready', detail: `${projectsOf(ctx, config).length} projects polled${skipped}`, at: round.started })
  // The cursor moves only after every project's Triggers are stored, so an interrupted round reads them again.
  ctx.state.set(KV.gongfeng.since, cursorAt(round.started))
}
/**
 * Reads one project's issues and merge requests, then the comments of each item changed since the cursor.
 * 工蜂 MCP offers no `updated_after`, so the list is read newest-first and filtered here by `updated_at` against the
 * cursor; an item's own Trigger id is stable, so re-reading the same window costs nothing.
 */
async function pollProject(ctx: SourceContext, round: Round, project: GongfengProjectRef, config: GongfengConfig, since: string): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const account = ctx.deployment.gongfeng?.login ?? ''
  const cursor = Date.parse(since)
  for (const [kind, tool] of [['issue', 'search_project_issues'], ['mr', 'search_merge_request']] as const) {
    let items: GongfengItem[]
    try {
      items = validItems(GongfengItemSchema, await commands.gongfengPages(z.unknown(), tool,
        { project_id: project.path, order_by: 'updated_at', sort: 'desc' }, round.tally), round.tally)
    } catch (error) { if (!stopped(ctx, round)) round.failures.push(`${project.path} ${kind}s: ${String(error)}`); continue }
    for (const item of items) {
      if (stopped(ctx, round)) return
      // Newest-first, so the first item the cursor already covers ends this stream.
      if (Number.isFinite(cursor) && Date.parse(gongfengTime(item.updated_at ?? item.created_at)) < cursor) break
      const trigger = itemTrigger(item, kind, project, account)
      // A person's own opening of the item is never the agent's work; only an assignment or a mention is.
      if (trigger.actor.id === account && !trigger.addressed) continue
      // Only an open item can ask for work; a merge request is still observed below so a Ticket following it ends on its close.
      if (item.state === 'opened') await ctx.receive(trigger)
      if (kind === 'mr') await observeMerge(ctx, { ...item, project })
      await pollItemNotes(ctx, round, project, kind, item, config, account)
    }
  }
}
/** Reads an item's comments after its cursor, so a comment on an older item is still found once the item is updated. */
async function pollItemNotes(ctx: SourceContext, round: Round, project: GongfengProjectRef, kind: GongfengKind, item: GongfengItem,
  config: GongfengConfig, account: string): Promise<void> {
  if (!config.observeNotes) return
  const thread = gongfengThreadId(project, kind, item.iid)
  const since = ctx.state.get(KV.gongfeng.cursor(thread)) ?? item.created_at ?? round.started
  let notes: GongfengNote[]
  try {
    notes = validItems(GongfengNoteSchema, await ctx.commands.withSignal(round.signal).gongfengPages(z.unknown(),
      kind === 'mr' ? 'search_merge_request_notes' : 'get_issue_notes',
      kind === 'mr' ? { project_id: project.path, merge_request_id: item.id, sort: 'created_asc' }
        : { project_id: project.path, issue_id: item.id }, round.tally), round.tally)
    // The notes tools have no time filter, so a comment older than the cursor is skipped here.
    notes = notes.filter(note => gongfengTime(note.updated_at ?? note.created_at) >= since)
  } catch (error) { if (!stopped(ctx, round)) round.failures.push(`${project.path} ${kind} !${item.iid} notes: ${String(error)}`); return }
  for (const note of notes) {
    if (stopped(ctx, round)) return
    const trigger = noteTrigger(note, item, kind, project, account)
    if (trigger) await ctx.receive(trigger)
  }
  ctx.state.set(KV.gongfeng.cursor(thread), cursorAt(round.started))
  nameThread(ctx, project, kind, item)
}
/** Publishes the item's title and URL on its Thread so the panel shows what a Thread is about. */
function nameThread(ctx: SourceContext, project: GongfengProjectRef, kind: GongfengKind, item: GongfengItem): void {
  const thread = gongfengThreadId(project, kind, item.iid)
  ctx.threads.describe(thread, { label: `${kind === 'mr' ? '!' : '#'}${item.iid} ${item.title}`,
    ...item.web_url ? { url: item.web_url } : {},
    facts: { number: { value: `${kind === 'mr' ? '!' : '#'}${item.iid}` }, project: { value: project.path } } })
}
/** Reads the merge request of every open ticket that follows one, ending the ticket on merge or close and reading its CI. */
export async function pollTicketMerges(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const config = ctx.config<GongfengConfig>(SOURCE)
  if (!config) return
  const projects = projectsOf(ctx, config)
  const seen = new Set<string>()
  for (const ticket of ctx.tickets.open()) {
    const bound = mergeOf(ticket, projects, true)
    if (!bound || seen.has(`${bound.project.id}:${bound.iid}`)) continue
    seen.add(`${bound.project.id}:${bound.iid}`)
    try {
      const merge = await readMerge(ctx, bound.project, bound.iid, round.signal)
      // A merge request the agent can no longer read is not an error of the round: it may have been deleted or moved.
      if (!merge) continue
      // Reviews belong to the MR Thread even when its subscription was dropped; the Engine filters new work.
      if (config.observeReviews && merge.state !== 'closed' && merge.state !== 'merged' && !merge.merged_at) await pollMergeReview(ctx, round, merge)
      else clearReview(ctx, merge)
      const ended = await observeMerge(ctx, merge)
      if (!ended && config.observeCi) await pollMergeCi(ctx, round, merge)
    } catch (error) { if (!stopped(ctx, round)) round.failures.push(`${bound.project.path} !${bound.iid}: ${String(error)}`) }
  }
}
/** Reads a merge request's combined commit status; only a change in the failing set after the first observation is a Trigger. */
async function pollMergeCi(ctx: SourceContext, round: Round, merge: Merge): Promise<void> {
  const thread = gongfengThreadId(merge.project, 'mr', merge.iid)
  // 工蜂 exposes the status by ref, and the merge request's source branch is that ref; no separate commit read is needed.
  const ref = merge.source_branch ?? String(merge.iid)
  const snapshot = await mergeChecks(ctx.commands.withSignal(round.signal), merge.project, ref)
  // No checks on this ref is the normal state of a project that runs no CI; it is not a passing result and has no facts.
  if (!snapshot) { ctx.threads.describe(thread, { facts: { ci: null } }); return }
  const fingerprint = key(JSON.stringify(snapshot.checks))
  const previous = ctx.state.get(KV.gongfeng.ci(thread))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) {
    const where = `${merge.project.path}!${merge.iid}`
    await ctx.receive(ciTrigger(merge, 'mr', merge.project, revision, ciSummary(snapshot, where, `gongfeng/${thread}/thread`)))
  }
  ctx.state.set(KV.gongfeng.ci(thread), { fingerprint, revision })
  const counts = ciCounts(snapshot)
  ctx.threads.describe(thread, { facts: { ci: counts.failed
    ? { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(counts.failed), problem: true }
    : { label: 'CI', value: counts.running ? { zh: '进行中', en: 'running' } : { zh: '通过', en: 'passed' } } } })
}
/** Removes review state once observation stops or the MR closes, so a reopened MR starts a fresh review. */
function clearReview(ctx: SourceContext, merge: Merge): void {
  const thread = gongfengThreadId(merge.project, 'mr', merge.iid)
  ctx.state.set(KV.gongfeng.review(thread), undefined)
  ctx.threads.describe(thread, { facts: { review: null } })
}
/** Reports new findings on the latest completed review to the open Ticket already following its MR. */
async function pollMergeReview(ctx: SourceContext, round: Round, merge: Merge): Promise<void> {
  const thread = gongfengThreadId(merge.project, 'mr', merge.iid)
  const previous = ctx.state.get(KV.gongfeng.review(thread))
  const review = await readReview(ctx.commands.withSignal(round.signal), merge.project, merge.iid, round.tally)
  if (!review) {
    ctx.threads.describe(thread, { facts: { review: { label: { zh: 'AI 评审', en: 'AI review' },
      value: { zh: '进行中或未启用', en: 'pending or unavailable' } } } })
    return
  }
  const seen = new Set(previous?.seen ?? [])
  const reported = review.comments.map(finding => reviewFindingKey(finding, review))
  const fresh = review.comments.filter(finding => !seen.has(reviewFindingKey(finding, review)))
  let revision = previous?.revision ?? 0
  for (const finding of fresh) {
    revision += 1
    await ctx.receive(reviewTrigger(finding, review, merge, merge.project, revision))
  }
  ctx.state.set(KV.gongfeng.review(thread), { seen: reported, revision,
    ...review.reviewId !== undefined ? { reviewId: review.reviewId } : {},
    ...review.patchSet !== undefined ? { patchSet: review.patchSet } : {}, ...review.head ? { head: review.head } : {} })
  ctx.threads.describe(thread, { facts: { review: review.comments.length
    ? { label: { zh: 'AI 评审', en: 'AI review' }, value: String(review.comments.length), problem: true }
    : { label: { zh: 'AI 评审', en: 'AI review' }, value: { zh: '无意见（不是人工批准）', en: 'clear; not a human approval' } } } })
}
/** Polls the Threads that have Tickets so a comment missed by the project streams still arrives. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const config = ctx.config<GongfengConfig>(SOURCE)
  if (!config) return
  const projects = projectsOf(ctx, config)
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    // The stored key is `gongfeng:<projectId>:<kind>:<iid>`; `pollEach` already skips Threads outside the polling horizon.
    const [, projectId, kind, iid] = thread.key.split(':')
    const project = projects.find(item => String(item.id) === projectId)
    if (!project || (kind !== 'issue' && kind !== 'mr') || !Number(iid)) return
    await pollThread(ctx, round, project, kind, Number(iid), config)
  })
}
async function pollThread(ctx: SourceContext, round: Round, project: GongfengProjectRef, kind: GongfengKind, iid: number, config: GongfengConfig): Promise<void> {
  const account = ctx.deployment.gongfeng?.login ?? ''
  // The list tools answer at most the one item asked for, which is how an iid is read through the MCP contract.
  const found = await ctx.commands.withSignal(round.signal)
    .gongfeng(z.union([z.array(GongfengItemSchema), GongfengItemSchema.transform(item => [item])]),
      kind === 'mr' ? 'search_merge_request' : 'search_project_issues', { project_id: project.path, iid })
  const item = found[0]
  if (!item) return
  await pollItemNotes(ctx, round, project, kind, item, config, account)
}
/** Notices an ended ticket's other conversations receive when its merge request merged or closed. */
export { gongfengThreadId, mergeEndNotices, type GongfengItem, type GongfengNote, type GongfengProjectRef }
