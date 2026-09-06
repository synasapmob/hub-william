# Answer tags

All answer modes suppress execution handoffs. Never append a
`## Delivery summary` block, `Touched:`, or any `LINEAR:`, `GITHUB:`,
`EVIDENCE:`, `PLAYWRIGHT:` or other report-summary subsection. This remains
true when an answer tag is combined with action tags because answer precedence
prevents those actions.

## `[answer]`

Answer the question only. Do not plan a project, edit files, create a worktree,
run tests, use a browser, create Linear work, touch GitHub, deploy or perform
other writes. Small read-only inspection is allowed only when it is necessary
to answer accurately. End after the answer.

Use a direct natural response with no forced process or ranking structure.

## `[answer-step-by-step]`

Answer only, using an operational walkthrough rather than performing the work.
Use this structure and adapt the number of steps to the question:

- `Chuẩn bị:` tools, documents, access and conditions required first.
- `Bước 1 - Khởi tạo:` the exact first action and expected state.
- `Bước 2 - Xử lý cốt lõi:` the main operation, important logic and cautions.
- Continue numbered steps in execution order when needed.
- `Kiểm tra kết quả:` how the operator proves the procedure succeeded.

Do not turn the walkthrough into a project plan, edit code, run the steps or
perform writes. Include commands only as instructions for the operator.

## `[answer-priority]`

Answer only, ranking findings or recommendations by urgency and impact. Use
`Ưu tiên 1 (Critical)`, `Ưu tiên 2 (High)`, then Medium or Low only when useful.
For each priority state what it is, why it has that rank, what to do and the
expected outcome. Put prerequisites and blocking risks before optimizations;
do not invent filler items merely to populate every level. Do not implement or
perform writes.
