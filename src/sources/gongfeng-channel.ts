/** 工蜂 outbound channel: comments on issues and merge requests as the agent account, once per message. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { gongfengPage, DISCLOSURE, type GongfengKind } from './gongfeng-trigger.ts'

/** True when 工蜂 permanently rejects a comment because its item or project is gone or unreadable by the agent. */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 403)
const NoteListSchema = z.array(z.looseObject({ id: z.number(), body: z.string().nullish() }))
/** The tool that reads an item's comments, and the argument naming it: the MCP tools take the item's internal id. */
const notesOf = (kind: GongfengKind, id: number, project: string): { tool: string; args: Record<string, unknown> } =>
  kind === 'mr' ? { tool: 'search_merge_request_notes', args: { project_id: project, merge_request_id: id, per_page: 100 } }
    : { tool: 'get_issue_notes', args: { project_id: project, issue_id: id, per_page: 100 } }
/**
 * Posts a comment with an HTML marker so a retry does not comment twice. 工蜂 offers no delete and no idempotency key, so
 * the marker is looked for before posting: a delivery that already landed must not land again.
 *
 * The comment opens with `DISCLOSURE` because the agent posts as a person's account rather than a bot of its own: readers,
 * and this Source's own reading of the account's later comments, tell its writing from that person's by that line.
 */
export async function sendGongfeng(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { project, kind, id: itemId, noteId } = message.channel.address
  if (!project || !kind || !itemId) throw new Error('Missing 工蜂 reply target')
  const id = Number(itemId)
  const marker = `<!-- dsh-superagent:${message.id} -->`
  const { tool, args } = notesOf(kind as GongfengKind, id, project)
  try {
    const listed = await commands.gongfengText(tool, args)
    const recent = NoteListSchema.parse(JSON.parse(listed) as unknown)
    if (recent.some(note => (note.body ?? '').includes(marker))) return 'sent'
    const body = `${DISCLOSURE}\n\n${message.text}\n\n${marker}`
    if (noteId && kind === 'mr') {
      // An inline review comment is answered in its own thread, which the reply tool keeps.
      await commands.gongfeng(z.unknown(), 'reply_merge_request_note',
        { project_id: project, merge_request_id: id, note_id: Number(noteId), body })
    } else if (kind === 'mr') {
      await commands.gongfeng(z.unknown(), 'create_merge_request_note', { project_id: project, merge_request_id: id, body })
    } else {
      await commands.gongfeng(z.unknown(), 'create_issue_note', { project_id: project, issue_id: id, note_message: body })
    }
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** Page of an issue or merge request. */
export function gongfengLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const project = address.project ?? '', iid = Number(address.iid ?? 0), kind = (address.kind === 'mr' ? 'mr' : 'issue') as GongfengKind
  return { url: address.url ?? (project && iid ? gongfengPage(project, kind, iid) : ''),
    label: kind === 'mr' ? { zh: `工蜂 !${iid}`, en: `工蜂 !${iid}` } : { zh: `工蜂 #${iid}`, en: `工蜂 #${iid}` } }
}
