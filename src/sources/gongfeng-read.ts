/** Read-only 工蜂 issue, merge request, comment, and CI status inspection through the agent's 工蜂 MCP tools. */
import { z } from 'zod'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { gongfengLine, gongfengTime, GongfengItemSchema, GongfengNoteSchema, GongfengReviewCommentSchema, type GongfengKind, type GongfengProjectRef,
  type GongfengReview } from './gongfeng-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/**
 * 工蜂's AI code review answers by review, not by merge request, and reports its own state beside the findings.
 * `status` 0 with `status_text` beginning `SUCCESS` is a finished review; a project that never enabled AI review
 * answers `1001` and has nothing to read. A project with AI review switched off answers with no findings at all.
 */
const IntelligentReviewSchema = z.union([
  z.array(z.unknown()).transform(() => ({ comments: [] as unknown[], status: 1001, status_text: 'NO_HISTORY',
    patch_set_no: null, review_id: null, head_commit_sha: null })),
  z.looseObject({ comments: z.array(z.unknown()).nullish(), status: z.number().nullish(), status_text: z.string().nullish(),
    patch_set_no: z.number().nullish(), review_id: z.number().nullish(), head_commit_sha: z.string().nullish() }),
])
/** A completed review, or undefined while none has finished. Neither absence nor no findings means human approval. */
export async function readReview(commands: Commands, project: GongfengProjectRef, iid: number, tally?: Tally): Promise<GongfengReview | undefined> {
  const answer = await commands.gongfeng(IntelligentReviewSchema, 'get_review_intelligent_result', { project_id: project.path, merge_request_iid: iid })
  if (answer.status !== 0 || answer.status_text?.toUpperCase().startsWith('SUCCESS') !== true) return undefined
  const comments = validItems(GongfengReviewCommentSchema, answer.comments ?? [], tally)
  return { comments, ...answer.review_id !== null && answer.review_id !== undefined ? { reviewId: answer.review_id } : {},
    ...answer.patch_set_no !== null && answer.patch_set_no !== undefined ? { patchSet: answer.patch_set_no } : {},
    ...answer.head_commit_sha ? { head: answer.head_commit_sha } : {} }
}

/**
 * 工蜂's CI answer: a combined status object, or `{message}` when the ref has no check data at all.
 * The gateway answers the same way for both, so the shapes are told apart rather than read as "passed".
 */
const CombinedStatusSchema = z.union([
  z.looseObject({ message: z.string() }).transform(() => undefined),
  z.looseObject({ state: z.string().nullish(), status: z.string().nullish(), checks: z.array(z.unknown()).nullish(),
    statuses: z.array(z.unknown()).nullish() }),
])
export interface CiSnapshot { ref: string; state?: string; checks: { name: string; state: string }[] }
/** Check states that count as a failure; `success`, `pending`, `skipped` and an absent state do not. */
const FAILING = new Set(['failed', 'failure', 'canceled', 'cancelled', 'error', 'timeout'])
/** How many checks failed and how many still run, from one combined-status answer. */
export function ciCounts(snapshot: CiSnapshot): { failed: number; running: number } {
  const states = snapshot.checks.map(item => item.state.toLowerCase())
  return { failed: states.filter(state => FAILING.has(state)).length, running: states.filter(state => state === 'pending' || state === 'running').length }
}
/** The failing checks, sorted, so a change in the set is a change worth a Trigger. */
export const ciFailures = (snapshot: CiSnapshot): string[] =>
  snapshot.checks.filter(item => FAILING.has(item.state.toLowerCase())).map(item => item.name).sort()
/**
 * Reads a ref's combined commit status. `undefined` means 工蜂 has no checks for that ref, which is the normal state of a
 * project that runs no CI, and must not be reported as passing.
 */
export async function mergeChecks(commands: Commands, project: GongfengProjectRef, ref: string, tally?: Tally): Promise<CiSnapshot | undefined> {
  const answer = await commands.gongfeng(CombinedStatusSchema, 'get_commit_combined_status', { project_id: project.path, ref, per_page: 100 })
  if (!answer) return undefined
  // The tool documents `checks` and `statuses`; whichever is present carries each check's state.
  const checks = [...answer.checks ?? [], ...answer.statuses ?? []].flatMap(item => {
    const record = (item ?? {}) as Record<string, unknown>
    const name = String(record.context ?? record.name ?? record.check_name ?? 'check')
    const state = String(record.state ?? record.status ?? record.result ?? '')
    return state ? [{ name, state }] : []
  })
  void tally
  return { ref, ...answer.state || answer.status ? { state: String(answer.state ?? answer.status) } : {}, checks: checks.sort((a, b) => a.name.localeCompare(b.name)) }
}
/** One line for the model: which checks failed, or that all passed. */
export function ciSummary(snapshot: CiSnapshot, where: string, read: string): string {
  const { failed, running } = ciCounts(snapshot)
  const names = (list: string[]) => list.slice(0, 5).join(', ') + (list.length > 5 ? `, and ${list.length - 5} more` : '')
  const at = `on ${where} at ${snapshot.ref.slice(0, 7)}`
  const line = failed ? `CI failed ${failed}/${snapshot.checks.length} ${at}: ${names(ciFailures(snapshot))}`
    : running ? `CI running ${running}/${snapshot.checks.length} ${at}` : `CI passed ${snapshot.checks.length}/${snapshot.checks.length} ${at}`
  return `${line}\nRead ${read} for every check.`
}
/** One comment as a model-facing message, marking a reply and an inline comment's file and line. */
function noteMessage(note: z.infer<typeof GongfengNoteSchema>): ContextMessage {
  const line = gongfengLine(note)
  return { id: String(note.id), from: note.author?.username ?? 'unknown', at: gongfengTime(note.created_at), text: note.body ?? '',
    ...note.parent_id != null ? { reply_to: String(note.parent_id) } : {},
    ...note.file_path ? { path: note.file_path, ...line ? { line } : {} } : {} }
}
/** Reads one item by iid, as the list tools answer it: an array with at most that item. */
async function readItem(commands: Commands, project: GongfengProjectRef, kind: GongfengKind, iid: number) {
  const tool = kind === 'mr' ? 'search_merge_request' : 'search_project_issues'
  const found = await commands.gongfeng(z.union([z.array(GongfengItemSchema), GongfengItemSchema.transform(item => [item])]), tool,
    { project_id: project.path, iid })
  return found[0]
}
/**
 * Reads one page of an issue's or merge request's comments as model-facing messages.
 * The MCP tools take the item's internal id rather than its iid, which is why a Trigger carries both.
 */
export async function readGongfeng(commands: Commands, project: GongfengProjectRef, kind: GongfengKind, iid: number, id: number,
  page: number, tally?: Tally): Promise<{ messages: ContextMessage[]; next_resource: string | null }> {
  const messages: ContextMessage[] = []
  if (page === 1) {
    const item = await readItem(commands, project, kind, iid)
    if (item) messages.push({ id: String(item.iid), from: item.author.username, at: gongfengTime(item.created_at),
      text: `${item.title}\n\n${item.description ?? ''}`, ...item.web_url ? { url: item.web_url } : {} })
  }
  const notes = await commands.gongfengPages(z.unknown(), kind === 'mr' ? 'search_merge_request_notes' : 'get_issue_notes',
    kind === 'mr' ? { project_id: project.path, merge_request_id: id, sort: 'created_asc' } : { project_id: project.path, issue_id: id }, tally)
  messages.push(...validItems(GongfengNoteSchema, notes, tally).filter(note => note.system !== true).map(note => noteMessage(note)))
  // A full page may hide later comments, so a caller keeps reading until one comes back short.
  return { messages, next_resource: notes.length >= 100 ? String(page + 1) : null }
}
/**
 * Context reader for a 工蜂 Trigger: the conversation of the issue or merge request it belongs to, by page, with the
 * comment a reply answers read on its own.
 */
export const gongfengThreadContext: ThreadContext<unknown> = {
  messageId: trigger => String(trigger.meta.findingId ?? trigger.meta.noteId ?? trigger.meta.iid ?? ''),
  read: async (commands, trigger, part, cursor) => {
    const project = { path: String(trigger.meta.project ?? ''), id: Number(trigger.meta.projectId) }
    const kind = (trigger.meta.kind === 'mr' ? 'mr' : 'issue') as GongfengKind
    if (trigger.meta.review === true) {
      const review = await readReview(commands, project, Number(trigger.meta.iid))
      const id = String(trigger.meta.reviewFindingId ?? '')
      const comment = review?.comments.find(item => String(item.id) === id)
      const message: ContextMessage = { id: String(trigger.meta.findingId ?? id), from: '工蜂 AI 代码评审', at: trigger.at,
        text: comment?.content ?? trigger.text, bot: true, url: trigger.url,
        ...comment?.file_path ? { path: comment.file_path } : {}, ...comment?.start_line ? { line: comment.start_line } : {} }
      return { messages: [message], body: { review: review ?? null, messages: [message] }, status: 'ai_review' }
    }
    const body = await readGongfeng(commands, project, kind, Number(trigger.meta.iid), Number(trigger.meta.id), Number(cursor ?? '1'))
    const parentId = trigger.meta.parentId
    const messages = part === 'parent' && parentId != null ? body.messages.filter(message => message.id === String(parentId)) : body.messages
    return { messages: messages.length ? messages : body.messages, ...body.next_resource ? { next: body.next_resource } : {},
      body: { ...body, ...messages !== body.messages ? { messages } : {} } }
  },
}
/** Reads one issue or merge request, with its CI for a merge request, as a `gongfeng/` resource. */
export async function readGongfengResource(commands: Commands, project: GongfengProjectRef, resource: string): Promise<unknown> {
  const item = /^(issue|mr)\/([1-9]\d*)(?:\/(comments|review)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!item) throw new Error('Use gongfeng/<trigger-id>/<thread|root|parent>, or issue/<iid> and mr/<iid> with /comments or /review')
  const kind = item[1] as GongfengKind, iid = Number(item[2])
  const found = await readItem(commands, project, kind, iid)
  if (!found) throw new Error(`No 工蜂 ${kind} ${iid} in ${project.path}`)
  if (item[3] === 'comments') {
    const page = Number(item[4] ?? '1')
    const read = await readGongfeng(commands, project, kind, iid, found.id, page)
    return { ...read, read: `gongfeng/${item[1]}/${iid}/comments/${page + 1}` }
  }
  if (item[3] === 'review') {
    if (kind !== 'mr' || item[4]) throw new Error('AI code review is available as gongfeng/mr/<iid>/review')
    return { ...(await readReview(commands, project, iid) ?? { status: 'pending_or_unavailable', comments: [] }), approval: false }
  }
  if (kind !== 'mr') return { ...found, kind }
  const snapshot = await mergeChecks(commands, project, found.source_branch ?? String(found.iid))
  return { ...found, kind, ...snapshot ? { ci: snapshot, ...ciCounts(snapshot).failed ? { ci_failed: true } : {} } : { ci: null } }
}
