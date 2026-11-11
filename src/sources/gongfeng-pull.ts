/** 工蜂 merge request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import type { SourceContext } from './host.ts'
import { gongfengPage, gongfengThreadId, GongfengItemSchema, type GongfengItem, type GongfengKind, type GongfengProjectRef } from './gongfeng-trigger.ts'

const MergeSchema = GongfengItemSchema
export type Merge = GongfengItem & { project: GongfengProjectRef }
/** The Thread id of a merge request, and the domain's full key (`<source>:<id>`), which is what a ticket stores. */
export const mergeThreadId = (merge: Merge): string => gongfengThreadId(merge.project, 'mr', merge.iid)
export const mergeThread = (merge: Merge): { source: string; id: string } => ({ source: 'gongfeng', id: mergeThreadId(merge) })
/** The full Thread keys of the merge requests a ticket follows. */
const mergeThreads = (ticket: Pick<Ticket, 'follows'>, open = false): string[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).filter(item => item.thread.startsWith('gongfeng:')).map(item => item.thread)
/** Reads one merge request by iid in `project`, from the list tool that answers at most the one asked for. */
export const readMerge = async (ctx: SourceContext, project: GongfengProjectRef, iid: number, signal?: AbortSignal): Promise<Merge | undefined> => {
  const found = await ctx.commands.withSignal(signal).gongfeng(
    z.union([z.array(GongfengItemSchema), GongfengItemSchema.transform(item => [item])]), 'search_merge_request', { project_id: project.path, iid })
  const merge = found[0]
  return merge ? { ...merge, project } : undefined
}
/** The iid and project of a merge request a ticket follows, by the `<source>:<projectId>:mr:<iid>` key it stores. */
export function mergeOf(ticket: Pick<Ticket, 'follows'>, projects: readonly GongfengProjectRef[], open = false): { project: GongfengProjectRef; iid: number } | undefined {
  for (const thread of [...mergeThreads(ticket, open)].reverse()) {
    // The key a ticket stores is `gongfeng:<projectId>:mr:<iid>`, so the source is its first segment.
    const [, projectId, kind, iid] = thread.split(':')
    if (kind !== 'mr') continue
    const project = projects.find(item => String(item.id) === projectId)
    if (project && Number(iid)) return { project, iid: Number(iid) }
  }
  return undefined
}
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
/** True when the merge request is the agent's own, opened from a branch of the same project rather than a fork. */
export const agentMerge = (merge: Merge, deployment: Pick<Deployment, 'gongfeng'>): boolean =>
  !!deployment.gongfeng && merge.author.username === deployment.gongfeng.login
const CI_FACT = (counts: { failed: number; running: number }): ThreadFact | null => counts.failed
  ? { label: { zh: 'CI 失败', en: 'CI failed' }, value: String(counts.failed), problem: true }
  : counts.running ? { label: { zh: 'CI 进行中', en: 'CI running' }, value: String(counts.running) } : null

/**
 * Validates and binds a merge request to a ticket when the merge request is either the ticket's origin merge request or one
 * the agent opened from the ticket's branch, and enforces that one merge request binds to at most one open ticket.
 * @returns An error message when binding is rejected, or undefined when it is bound or the merge request is not open.
 */
export function claimMerge(ctx: SourceContext, ticketId: string, merge: Merge): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its merge request was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === 'gongfeng' && source.meta.kind === 'mr' && source.meta.iid === merge.iid
  const opened = agentMerge(merge, ctx.deployment) && ticketBranch(ticket, merge.source_branch ?? '')
  if (!started && !opened) {
    const login = ctx.deployment.gongfeng?.login ?? 'the agent'
    return `Merge request does not belong to this ticket: use the source merge request or one by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit merge_request when none exists`
  }
  const thread = `gongfeng:${mergeThreadId(merge)}`, own = ticket.follows?.find(item => item.thread === thread)
  const owner = ctx.tickets.open().find(item => mergeThreads(item, true).includes(thread))
  if (owner && owner.id !== ticketId) return 'Merge request already belongs to another active ticket'
  const follow = own
  if (merge.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, merge, opened)
  return undefined
}
/**
 * Reconciles a polled merge request's open, merged, or closed state with any bound or branch-matching ticket.
 * @returns whether the merge request has ended.
 */
export async function observeMerge(ctx: SourceContext, merge: Merge): Promise<boolean> {
  const ended = merge.state === 'closed' || merge.state === 'merged' || !!merge.merged_at
  const threadId = `gongfeng:${mergeThreadId(merge)}`
  if (ended) closeMerge(ctx, merge)
  else {
    const candidates = agentMerge(merge, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, merge.source_branch ?? '')) : []
    const ticket = candidates.length === 1 ? candidates[0] : undefined
    // A merge request the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === threadId && item.closed)
    if (ticket && (reopened || mergeThreads(ticket, true).every(thread => thread === threadId))) claimMerge(ctx, ticket.id, merge)
  }
  ctx.threads.describe(threadId.slice('gongfeng:'.length), { facts: { merge: { label: { zh: '合并请求', en: 'Merge request' }, value: `!${merge.iid}` } } })
  return ended
}
function bind(ctx: SourceContext, ticketId: string, merge: Merge, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, mergeThread(merge), own)
    ctx.threads.patch(mergeThreadId(merge), { title: merge.title, url: merge.web_url ?? undefined })
  })
}
/**
 * Reports a merged or closed merge request once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the merge request stays so a later human comment there resumes the ticket.
 */
function closeMerge(ctx: SourceContext, merge: Merge): void {
  const id = gongfengThreadId(merge.project, 'mr', merge.iid)
  const thread = { source: 'gongfeng', id }
  // The domain keys a Thread as `<source>:<id>`, which is the form a Ticket stores in `follows`.
  if (!ctx.tickets.open().some(ticket => mergeThreads(ticket, true).includes(`gongfeng:${id}`))) return
  const at = merge.merged_at ?? merge.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed(thread, merge.state === 'merged' || !!merge.merged_at ? 'merged' : 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its merge request, selecting the
 * last-closed merge request it opened, else the last one it followed.
 */
export function mergeEndNotices(ticket: Ticket, request: string, projects: readonly GongfengProjectRef[]): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && item.thread.startsWith('gongfeng:'))
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const [, projectId, kind, iid] = follow.thread.split(':')
  const project = projects.find(item => String(item.id) === projectId)
  if (kind !== 'mr' || !project || !Number(iid)) return []
  const number = Number(iid), url = gongfengPage(project.path, 'mr', number)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[工蜂合并请求 !${number}](${url}) 已合并。` : `[工蜂合并请求 !${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[工蜂 merge request !${number}](${url}) has merged.` : `[工蜂 merge request !${number}](${url}) was closed without merging.`
  // 工蜂 timelines already show the merge or closure, so 工蜂 channels are skipped.
  return ticket.channels.filter(channel => channel.source !== 'gongfeng').map(channel => ({
    id: key('mr-terminal', String(project.id), String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice',
    ticketId: ticket.id }))
}
export { CI_FACT, MergeSchema, type GongfengKind }
