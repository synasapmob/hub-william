-- Clean up any old-parser exports that arrived after the first repair began
-- but before codex-otel version 2 finished deploying.

insert into public.agent_project_usage as destination (
  project_id,
  period_start,
  period_end,
  model,
  input_tokens,
  output_tokens,
  cached_input_tokens,
  reasoning_tokens,
  request_count,
  prompt_count,
  observed_at
)
select
  project_id,
  date_trunc('hour', observed_at),
  date_trunc('hour', observed_at) + interval '1 hour',
  model,
  sum(input_tokens),
  sum(output_tokens),
  sum(cached_input_tokens),
  sum(reasoning_tokens),
  sum(request_count),
  sum(prompt_count),
  max(observed_at)
from public.agent_project_usage
where period_start < timestamptz '2020-01-01 00:00:00+00'
group by project_id, date_trunc('hour', observed_at), model
on conflict (project_id, period_start, model)
do update set
  input_tokens = destination.input_tokens + excluded.input_tokens,
  output_tokens = destination.output_tokens + excluded.output_tokens,
  cached_input_tokens = destination.cached_input_tokens + excluded.cached_input_tokens,
  reasoning_tokens = destination.reasoning_tokens + excluded.reasoning_tokens,
  request_count = destination.request_count + excluded.request_count,
  prompt_count = destination.prompt_count + excluded.prompt_count,
  observed_at = greatest(destination.observed_at, excluded.observed_at);

delete from public.agent_project_usage
where period_start < timestamptz '2020-01-01 00:00:00+00';
