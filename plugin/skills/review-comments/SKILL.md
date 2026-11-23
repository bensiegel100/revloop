---
name: review-comments
description: Address all open Revloop review comments in the current repository and reply to each thread with the outcome.
---

# Review Revloop comments

Use the Revloop MCP tools to complete the current review cycle.

1. Determine the absolute current repository root with `git rev-parse --show-toplevel`.
2. Call `read_comments` with that `repositoryRoot` and `status: "unresolved"`.
3. If there are no unresolved threads, report that and stop.
4. For every returned thread:
   - Read its full conversation, original selected text, and current range.
   - If the current range is `null`, use the selected text and repository tools to locate the user's intended code.
   - Inspect the relevant repository code before deciding what to do.
   - Make the requested code change when appropriate.
   - Treat questions, disagreements, impossible requests, and non-actionable feedback as valid threads that still require replies.
5. Run the smallest relevant validation for any code changes.
6. Call `reply_to_comment` exactly once for every thread handled in this invocation, passing the same `repositoryRoot`:
   - Use `changed` when code was changed.
   - Use `answered` for questions or explanations.
   - Use `declined` when intentionally not making the requested change.
   - Use `blocked` when the request cannot be completed.
   - State concretely what changed, what was verified, or why no change was made.
7. Never resolve, reopen, delete, or move a thread. Resolution belongs only to the user.
8. Finish with a concise summary of changed files, validation performed, and any declined or blocked threads.
