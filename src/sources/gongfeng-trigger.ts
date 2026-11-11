/** 工蜂 issues, merge requests, and comments as domain Triggers, with the Thread ids and Channel addresses replies use. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'gongfeng'
/**
 * The machine-readable mark of this agent's own writing. 工蜂 has no separate bot account here, so the agent acts as a
 * person's account and must be told apart from that person by what it writes: every comment it posts ends with this
 * marker, and every issue or merge request it opens begins with `DISCLOSURE`.
 */
export const AUTOMATION_MARKER = /<!--\s*dsh-superagent:[^\s>]+\s*-->\s*$/
/** True when `text` was written by this agent rather than by the account it shares with a person. */
export const automated = (text: string | null | undefined): boolean => AUTOMATION_MARKER.test(text ?? '')
/** The human-visible line that begins every issue, merge request and comment this agent writes on 工蜂. */
export const DISCLOSURE = 'This is by an automated agent, not a human.'
/**
 * True when an issue's or merge request's body is this agent's own work. Its description opens with `DISCLOSURE`, since a
 * description carries no marker; a person quoting that line from further down their text is not claiming to be the agent.
 */
export const automatedBody = (text: string | null | undefined): boolean => (text ?? '').trimStart().startsWith(DISCLOSURE)
/** Who a 工蜂 account is: an ordinary user, or a bot the project provisions for a group access token. */
export const GongfengUserSchema = z.looseObject({ id: z.number(), username: z.string(), name: z.string().nullish(), state: z.string().nullish() })
export type GongfengUser = z.infer<typeof GongfengUserSchema>
/** An issue or merge request as the list and detail endpoints return it. */
export const GongfengItemSchema = z.looseObject({
  id: z.number(), iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), author: GongfengUserSchema,
  assignees: z.array(GongfengUserSchema).nullish(), assignee: GongfengUserSchema.nullish(),
  web_url: z.string().nullish(), project_id: z.number().nullish(),
  source_branch: z.string().nullish(), target_branch: z.string().nullish(), merged_at: z.string().nullish(), closed_at: z.string().nullish(),
})
export type GongfengItem = z.infer<typeof GongfengItemSchema>
/** A comment on an issue or merge request; `parent_id` names the comment it answers. */
export const GongfengNoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), parent_id: z.number().nullish(), author: GongfengUserSchema.nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(), system: z.boolean().nullish(),
  noteable_type: z.string().nullish(), noteable_id: z.number().nullish(),
  file_path: z.string().nullish(), line_code: z.string().nullish(),
})
export type GongfengNote = z.infer<typeof GongfengNoteSchema>
/** Which 工蜂 object a Thread belongs to; merge requests and issues number independently, so the kind is part of the id. */
export type GongfengKind = 'issue' | 'mr'
/** The project a Trigger names, kept in `meta` so `scope` and the admission table can find its row. */
export interface GongfengProjectRef { path: string; id: number }

/** `gongfeng:<project id>:issue:<iid>` and `gongfeng:<project id>:mr:<iid>`: project renames do not move a stored Thread. */
export const gongfengThreadId = (project: GongfengProjectRef, kind: GongfengKind, iid: number): string => `${project.id}:${kind}:${iid}`
/** Reply address of one issue or merge request conversation; `id` is the internal one the comment tools take. */
export const gongfengChannel = (project: GongfengProjectRef, kind: GongfengKind, item: { iid: number; id: number }, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: gongfengThreadId(project, kind, item.iid),
    address: { project: project.path, projectId: String(project.id), kind, iid: String(item.iid), id: String(item.id), ...(url ? { url } : {}) } })
/** `line_code` encodes an inline comment's line as `<sha>_<old>_<new>`. */
export const gongfengLine = (note: Pick<GongfengNote, 'line_code'>): number | undefined => {
  const value = Number((note.line_code ?? '').split('_').at(-1))
  return Number.isFinite(value) && value > 0 ? value : undefined
}
/** The project's page for one issue or merge request. */
export const gongfengPage = (project: string, kind: GongfengKind, iid: number): string =>
  `https://git.woa.com/${project}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
/** Parses a `git.woa.com` page URL for an issue or merge request, or `project#12`, into the Thread it names. */
export function gongfengAddress(query: string): { project: string; kind: GongfengKind; iid: number } | undefined {
  const url = /^(?:https?:\/\/)?git\.woa\.com\/([^/\s]+(?:\/[^/\s]+)*)\/-\/(issues|merge_requests)\/(\d+)\/?$/.exec(query.trim())
  if (url) return { project: url[1]!, kind: url[2] === 'issues' ? 'issue' : 'mr', iid: Number(url[3]) }
  const short = /^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)#(\d+)$/.exec(query.trim())
  return short ? { project: short[1]!, kind: 'issue', iid: Number(short[2]) } : undefined
}
/** 工蜂 keeps timestamps in `+0000` form; the domain stores ISO strings so they compare lexicographically. */
export const gongfengTime = (value: string | null | undefined, fallback = new Date().toISOString()): string => {
  const time = Date.parse(value ?? '')
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback
}
/**
 * True when `text` addresses `login` by mention. 工蜂 has no mention payload, only `@username` in the body, so this matches
 * the login at a word boundary: `@shiyu` matches `@shiyugguo` only when the longer name is not the account.
 */
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^A-Za-z0-9_.@-])@${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_.-])`, 'i').test(text)
/** True when `login` is assigned the item, which 工蜂 counts as giving the work to that account. */
export const assignedTo = (item: GongfengItem, login: string): boolean =>
  [...item.assignees ?? [], ...item.assignee ? [item.assignee] : []].some(user => user.username === login)
/**
 * Who wrote an issue, merge request or comment. 工蜂 here has no bot account of its own, so the agent posts as a person's
 * account; what tells its writing apart is the marker or disclosure line it always writes (see `automated`), not the login.
 * Without that, the account's own people would look like the agent and every comment they post would be dropped.
 */
const author = (user: GongfengUser | null | undefined, account: string, own: boolean) =>
  ({ actor: { source: SOURCE, id: user?.username ?? 'unknown' }, human: !!user && !(own && user.username === account) })
/** The Trigger of one issue or merge request, whose `addressed` records why the Source decided it asks the agent. */
export function itemTrigger(item: GongfengItem, kind: GongfengKind, project: GongfengProjectRef, account: string): Trigger {
  const who = author(item.author, account, automatedBody(item.description))
  const at = gongfengTime(item.created_at ?? item.updated_at)
  const url = item.web_url ?? gongfengPage(project.path, kind, item.iid)
  // An assignment and a mention both ask the agent for work; the channel distinguishes which, for the panel and for follow-ups.
  const assigned = assignedTo(item, account)
  const text = `${item.title}\n\n${item.description ?? ''}`
  return { id: key('gongfeng-item', String(project.id), kind, String(item.iid)),
    source: SOURCE, threads: [{ source: SOURCE, id: gongfengThreadId(project, kind, item.iid) }], ...who, at, text,
    ...assigned || mentions(text, account) ? { addressed: 'mention' as const } : {},
    channel: gongfengChannel(project, kind, item, url), url,
    meta: { project: project.path, projectId: project.id, kind, iid: item.iid, id: item.id, title: item.title, state: item.state,
      via: assigned ? 'assignee' : mentions(text, account) ? 'mention' : undefined, url,
      ...item.source_branch ? { sourceBranch: item.source_branch } : {}, ...item.target_branch ? { targetBranch: item.target_branch } : {} } }
}
/** The Trigger of one comment; the id includes the edit time, so an edited comment is a new event. */
export function noteTrigger(note: GongfengNote, item: GongfengItem, kind: GongfengKind, project: GongfengProjectRef, account: string): Trigger | undefined {
  if (!note.author) return undefined
  // The agent's own comments and 工蜂's system notes are not events: nothing addressed the agent, and it may not answer itself.
  // A comment on the agent's own account is the agent's own only when it carries the marker; a person sharing that account
  // writes comments this agent must still receive.
  if (note.author.username === account && automated(note.body)) return undefined
  if (note.system === true) return undefined
  const version = note.updated_at ?? note.created_at ?? ''
  const body = note.body ?? ''
  const at = gongfengTime(note.updated_at ?? note.created_at)
  const url = item.web_url ? `${item.web_url}#note_${note.id}` : gongfengPage(project.path, kind, item.iid)
  const placeholder = /^\s*\+{2,}\s*$/m.test(body) && body.trim().length < 20
  // An empty comment such as a review approval still reaches the ticket; a placeholder body carries nothing to act on.
  if (!body.trim() && note.system !== false) return undefined
  return { id: key('gongfeng-note', String(project.id), kind, String(item.iid), String(note.id), version),
    source: SOURCE, threads: [{ source: SOURCE, id: gongfengThreadId(project, kind, item.iid) }], ...author(note.author, account, automated(body)),
    at, text: body, ...mentions(body, account) || assignedTo(item, account) ? { addressed: 'mention' as const } : {},
    channel: gongfengChannel(project, kind, item, url), url,
    meta: { project: project.path, projectId: project.id, kind, iid: item.iid, noteId: note.id, title: item.title, url,
      ...note.parent_id != null ? { parentId: note.parent_id } : {},
      ...note.file_path ? { path: note.file_path, ...lineOf(note) != null ? { line: lineOf(note) } : {} } : {},
      // An approval or a change request is a review decision without a body, and must reach a worker waiting on it.
      ...placeholder || !body.trim() ? { bodyless: true } : {} } }
}
/** The line a 工蜂 inline comment sits on, which `line_code` encodes as `<sha>_<old>_<new>`. */
export function lineOf(note: Pick<GongfengNote, 'line_code'>): number | undefined {
  const parts = (note.line_code ?? '').split('_')
  const value = Number(parts.at(-1))
  return Number.isFinite(value) && value > 0 ? value : undefined
}
/** The comment a Trigger answers, so a reply shows the message it answers. */
export const noteTriggerId = (project: GongfengProjectRef, kind: GongfengKind, iid: number, noteId: number): string =>
  key('gongfeng-note', String(project.id), kind, String(iid), String(noteId))
/** A CI status change on a merge request's head, produced only when the set of failing statuses changes. */
export function ciTrigger(item: GongfengItem, kind: GongfengKind, project: GongfengProjectRef, revision: number, summary: string): Trigger {
  return { id: key('gongfeng-ci', String(project.id), kind, String(item.iid), String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: gongfengThreadId(project, kind, item.iid) }], actor: { source: SOURCE, id: '' }, human: false,
    at: new Date().toISOString(), text: summary, channel: gongfengChannel(project, kind, item, item.web_url ?? undefined),
    ...item.web_url ? { url: item.web_url } : {},
    meta: { project: project.path, projectId: project.id, kind, iid: item.iid, ci: true, revision, title: item.title } }
}
/** One AI code-review finding, as 工蜂's review service reports it. */
export const GongfengReviewCommentSchema = z.looseObject({
  id: z.number(), content: z.string().nullish(), content_hash: z.string().nullish(), category: z.string().nullish(),
  level: z.number().nullish(), file_path: z.string().nullish(), start_line: z.number().nullish(), end_line: z.number().nullish(),
})
export type GongfengReviewComment = z.infer<typeof GongfengReviewCommentSchema>
/** The completed review of one MR patch set and head. */
export interface GongfengReview {
  reviewId?: number; patchSet?: number; head?: string; comments: GongfengReviewComment[]
}
/** A finding's identity includes its revision and text, so a new patch or an edit arrives again. */
export const reviewFindingKey = (comment: GongfengReviewComment, review?: Pick<GongfengReview, 'patchSet' | 'head'>): string =>
  `${review?.patchSet ?? review?.head ?? 'latest'}:${comment.id}:${comment.content_hash ?? comment.content ?? ''}`
/**
 * The Trigger of one AI code-review finding on a merge request. AI review is a service, not an account: 工蜂 reports it
 * beside the comments rather than among them, so it has no author and is never a person's request. It arrives as context on
 * the merge request's Thread — the worker reads it and answers by outcome — and never grants authority.
 */
export function reviewTrigger(comment: GongfengReviewComment, review: GongfengReview, item: GongfengItem, project: GongfengProjectRef,
  revision: number): Trigger {
  const path = comment.file_path ?? ''
  const line = comment.start_line ?? comment.end_line ?? undefined
  const where = path ? `${path}${line ? `:${line}` : ''}` : 'the change'
  const url = item.web_url ?? gongfengPage(project.path, 'mr', item.iid)
  const findingId = `review-${review.reviewId ?? 'mr'}-patch-${review.patchSet ?? 'latest'}-finding-${comment.id}`
  return { id: key('gongfeng-review', String(project.id), String(item.iid), String(revision), reviewFindingKey(comment)),
    source: SOURCE, threads: [{ source: SOURCE, id: gongfengThreadId(project, 'mr', item.iid) }],
    actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text: `AI code review on ${where}: ${comment.content ?? ''}\nRead gongfeng/mr/${item.iid}/review for its current review; this is not an ordinary MR comment.`,
    channel: gongfengChannel(project, 'mr', item, url), url,
    meta: { project: project.path, projectId: project.id, kind: 'mr', iid: item.iid, id: item.id, title: item.title, url,
      review: true, reviewId: review.reviewId, reviewFindingId: comment.id, findingId, revision,
      ...review.patchSet !== undefined ? { patchSet: review.patchSet } : {}, ...review.head ? { head: review.head } : {},
      ...path ? { path } : {}, ...line ? { line } : {} } }
}
