---
name: dsh-superagent-gongfeng
description: Read 工蜂 issues and merge requests, and reply to them with gongfeng-mcp.
---

Workers use orchestrator_read for 工蜂 context when needed: gongfeng/<trigger-id>/<thread> for the conversation, gongfeng/<trigger-id>/<root> for the issue or merge request description, and gongfeng/<trigger-id>/<parent> for the comment a reply answers. A page holds 100 entries and names next_resource while another may follow. A comment is `{ id, from, at, text, reply_to?, path?, line?, url }`: `id` is the 工蜂 comment id, `reply_to` the comment it answers, and `path` and `line` an inline review comment's file and line. Follow next_offset to finish the current response; offset 0 reads afresh, later offsets the same snapshot. Reading does not create tickets or send replies.

Use `gongfeng-mcp call <tool> '<json>'` for every 工蜂 call beyond these shortcuts. It prints the tool's JSON. The tools are 工蜂's MCP tools, not REST paths: `search_project_issues`, `get_issue_detail`, `search_merge_request`, `get_merge_request_changes`, `search_merge_request_notes`, `get_issue_notes`, `get_commit_combined_status`, `create_issue_note`, `create_merge_request_note`, and `reply_merge_request_note` cover most work. Pass `project_id` as the project's path such as `group/project`; pass an item's **internal id** to the comment tools, which is `id` in a Trigger's meta and not its `iid`. Never pass a token: the command carries the agent's own account.

`get_commit_combined_status` answers `{"message": "404 commit check data not found"}` when the ref has no checks at all. That means the project runs no CI for it, never that CI passed.

`get_review_intelligent_result` answers AI review with `merge_request_iid`, separate from MR comments. A result names its `review_id`, `patch_set_no` and `head_commit_sha`; findings are `{ id, content, file_path, start_line, level }`. `1001` or unfinished review means nothing to answer, not approval. Read `gongfeng/mr/<iid>/review` directly, not `trigger/<finding-trigger-id>`; finding ids are not note ids.

This deployment has **no separate 工蜂 account for you**: you post as a person's account, and `<!-- dsh-superagent:... -->` marks a comment as yours. Write `This is by an automated agent, not a human.` at the top of any issue or merge request you open — the Source reads that line, not the login, to tell your writing from that person's, so a merge request description without it looks like the person's own work. Comments the channel posts get the line for you.

A tool that rejects an argument names the missing one on stderr with exit 5, so a guess costs one call: `{"code": -32603, "message": "Invalid arguments: <field>: Required"}`. Several names are not what they look like. Comment and update tools want the **internal id**, not the `iid`, while `get_issue_detail` takes `issue_iid`. Assigning is `assignee_users` with logins: `assignee_ids` and `assignee_id` are accepted and ignored, leaving the issue unassigned with no error, so check `assignee` afterwards. The two merge request searches differ in `state`: `search_merge_request_by_user` takes `all`, but `search_merge_request` accepts only `opened`, `merged`, `reopened`, or `closed`.

Reply in the conversation that asked, not somewhere else. A merge request's discussion, inline review comments and AI review findings are separate; answer an inline comment in its own thread, and use review tools for AI findings rather than an ordinary MR note reply. Say what you changed and what you verified, without internal file paths, commit hashes or test inventories; the merge request description keeps the technical record.

Before substantial work on a new human request, call `orchestrator_ack` with its original trigger ID and a brief request-specific `text`, even within an existing ticket; the host replies once in that source thread. Do not acknowledge bots or CI.

Immediately after creating or adopting a ticket's merge request, call `orchestrator_report` with `state: progress` and `merge_request` set to its iid; do not wait for checks or handoff. Read each original trigger and acknowledge new human requests before substantial work.

When Delivery permits, `merge_merge_request` takes the MR's internal `id`, not `iid`, and merges at once; never merge against a hold or without required head approval.
