import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import {
  requireAdmin,
  requireApprovedUser,
  serviceClient,
} from "../_shared/database.ts";
import {
  jsonResponse,
  optionsResponse,
  ProviderRequestError,
  publicError,
} from "../_shared/http.ts";
import {
  fetchSource,
  JOB_PARSER_VERSION,
  jobSources,
  parseJob,
  type ParsedJob,
  type SourceFetchAudit,
  type SourceDefinition,
} from "../_shared/job-market.ts";

interface ExistingJobRow {
  id: string;
  external_id: string;
  content_hash: string;
  parser_version: string;
  processed_at: string | null;
}

interface SourceSyncResult {
  sourceId: string;
  status: "succeeded" | "skipped" | "failed";
  coverageStatus: SourceFetchAudit["coverageStatus"];
  fetched: number;
  created: number;
  updated: number;
  error: string | null;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Source synchronization failed.";
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function postingRow(job: ParsedJob) {
  return {
    source_id: job.sourceId,
    company_id: job.companyId,
    external_id: job.externalId,
    source_url: job.sourceUrl,
    title: job.title,
    company_name: job.companyName,
    company_logo_url: job.companyLogoUrl,
    description_text: job.descriptionText,
    description_quality: job.descriptionQuality,
    excerpt: job.excerpt,
    category: job.category,
    role_tags: job.roleTags,
    location_city: job.locationCity,
    location_text: job.locationText,
    remote: job.remote,
    employment_type: job.employmentType,
    seniority: job.seniority,
    seniority_source: job.senioritySource,
    minimum_experience_years: job.minimumExperienceYears,
    salary_text: job.salaryText,
    posted_at: job.postedAt,
    last_seen_at: new Date().toISOString(),
    inactive_at: null,
    missing_sync_count: 0,
    dedupe_key: job.dedupeKey,
    content_hash: job.contentHash,
    parser_version: JOB_PARSER_VERSION,
    updated_at: new Date().toISOString(),
  };
}

async function storeParsedJobs(
  client: SupabaseClient,
  jobs: ParsedJob[],
  existing: Map<string, ExistingJobRow>,
) {
  let created = 0;
  let updated = 0;

  for (const batch of chunks(jobs, 100)) {
    const { data, error } = await client
      .from("job_postings")
      .upsert(batch.map(postingRow), { onConflict: "source_id,external_id" })
      .select("id, external_id, content_hash, parser_version, processed_at");
    if (error) throw error;

    const stored = (data ?? []) as ExistingJobRow[];
    const byExternalId = new Map(stored.map((row) => [row.external_id, row]));
    const changedJobs = batch.filter((job) => {
      const previous = existing.get(job.externalId);
      if (!previous) {
        created += 1;
        return true;
      }
      const changed =
        previous.content_hash !== job.contentHash ||
        previous.parser_version !== JOB_PARSER_VERSION ||
        previous.processed_at === null;
      if (changed) updated += 1;
      return changed;
    });

    const storedChangedJobs = changedJobs.flatMap((job) => {
      const storedJob = byExternalId.get(job.externalId);
      return storedJob ? [{ job, storedJob }] : [];
    });
    const changedIds = storedChangedJobs.map(({ storedJob }) => storedJob.id);
    if (changedIds.length > 0) {
      const { error: pendingError } = await client
        .from("job_postings")
        .update({ processed_at: null })
        .in("id", changedIds);
      if (pendingError) throw pendingError;

      const { error: deleteError } = await client
        .from("job_posting_skills")
        .delete()
        .in("job_posting_id", changedIds);
      if (deleteError) throw deleteError;

      const skills = storedChangedJobs.flatMap(({ job, storedJob }) =>
        job.skills.map((skill) => ({
          job_posting_id: storedJob.id,
          skill_slug: skill.slug,
          skill_name: skill.name,
          skill_group: skill.group,
          requirement: skill.requirement,
          evidence: skill.evidence,
          parser_version: JOB_PARSER_VERSION,
        })),
      );
      if (skills.length > 0) {
        const { error: skillError } = await client
          .from("job_posting_skills")
          .insert(skills);
        if (skillError) throw skillError;
      }

      const { error: payloadError } = await client.rpc("store_job_payloads", {
        p_payloads: storedChangedJobs.map(({ job, storedJob }) => ({
          job_posting_id: storedJob.id,
          raw_payload: job.payload,
        })),
      });
      if (payloadError) throw payloadError;

      const { error: processedError } = await client
        .from("job_postings")
        .update({ processed_at: new Date().toISOString() })
        .in("id", changedIds);
      if (processedError) throw processedError;
    }
  }

  return { created, updated };
}

async function markMissingJobs(
  client: SupabaseClient,
  source: SourceDefinition,
  seenIds: string[],
  deactivationAllowed: boolean,
) {
  if (!deactivationAllowed) return;

  const { data, error } = await client
    .from("job_postings")
    .select("id, external_id, missing_sync_count")
    .eq("source_id", source.id)
    .is("inactive_at", null);
  if (error) throw error;

  const seen = new Set(seenIds);
  for (const row of data ?? []) {
    if (seen.has(row.external_id as string)) continue;
    const missingCount = Number(row.missing_sync_count) + 1;
    const { error: updateError } = await client
      .from("job_postings")
      .update({
        missing_sync_count: missingCount,
        inactive_at: missingCount >= 3 ? new Date().toISOString() : null,
      })
      .eq("id", row.id);
    if (updateError) throw updateError;
  }
}

async function syncSource(
  client: SupabaseClient,
  runId: string,
  source: SourceDefinition,
): Promise<SourceSyncResult> {
  try {
    const result = await fetchSource(source);
    if (result === null) {
      const error = "JOOBLE_API_KEY is not configured.";
      await client.from("job_sync_source_runs").insert({
        run_id: runId,
        source_id: source.id,
        status: "skipped",
        coverage_status: "unknown",
        market_jobs_kept: 0,
        stop_reason: "missing-source-configuration",
        error,
      });
      return {
        sourceId: source.id,
        status: "skipped",
        coverageStatus: "unknown",
        fetched: 0,
        created: 0,
        updated: 0,
        error,
      };
    }

    const { audit, jobs: rawJobs } = result;

    const validByExternalId = new Map(
      rawJobs
        .filter(
          (job) =>
            job.externalId &&
            job.sourceUrl &&
            job.title &&
            job.companyName &&
            job.descriptionHtml,
        )
        .map((job) => [job.externalId, job]),
    );
    const validRawJobs = [...validByExternalId.values()];
    const parsed = (await Promise.all(validRawJobs.map(parseJob))).filter(
      (job): job is ParsedJob => job !== null,
    );
    const parsedIds = new Set(parsed.map((job) => job.externalId));
    const unclassifiedIds = validRawJobs
      .filter((job) => !parsedIds.has(job.externalId))
      .map((job) => job.externalId);
    const { data, error } = await client
      .from("job_postings")
      .select("id, external_id, content_hash, parser_version, processed_at")
      .eq("source_id", source.id);
    if (error) throw error;
    const existing = new Map(
      ((data ?? []) as ExistingJobRow[]).map((job) => [job.external_id, job]),
    );
    const counts = await storeParsedJobs(client, parsed, existing);
    if (unclassifiedIds.length > 0) {
      for (const batch of chunks(unclassifiedIds, 100)) {
        const { error: unclassifiedError } = await client
          .from("job_postings")
          .update({ inactive_at: new Date().toISOString() })
          .eq("source_id", source.id)
          .in("external_id", batch);
        if (unclassifiedError) throw unclassifiedError;
      }
    }
    await markMissingJobs(
      client,
      source,
      parsed.map((job) => job.externalId),
      audit.deactivationAllowed,
    );

    const completedAt = new Date().toISOString();
    await client
      .from("job_sources")
      .update({
        last_synced_at: completedAt,
        last_error: null,
        updated_at: completedAt,
      })
      .eq("id", source.id);
    await client.from("job_sync_source_runs").insert({
      run_id: runId,
      source_id: source.id,
      status: "succeeded",
      jobs_fetched: parsed.length,
      coverage_status: audit.coverageStatus,
      expected_jobs: audit.expectedJobs,
      raw_jobs_fetched: audit.rawJobsFetched,
      unique_jobs_fetched: audit.uniqueJobsFetched,
      market_jobs_kept: audit.marketJobsKept,
      duplicate_jobs: audit.duplicateJobs,
      pages_fetched: audit.pagesFetched,
      page_size: audit.pageSize,
      stop_reason: audit.stopReason,
      deactivation_allowed: audit.deactivationAllowed,
    });
    return {
      sourceId: source.id,
      status: "succeeded",
      coverageStatus: audit.coverageStatus,
      fetched: parsed.length,
      created: counts.created,
      updated: counts.updated,
      error: null,
    };
  } catch (error) {
    const message = errorMessage(error);
    const completedAt = new Date().toISOString();
    await client
      .from("job_sources")
      .update({
        last_error: message,
        updated_at: completedAt,
      })
      .eq("id", source.id);
    await client.from("job_sync_source_runs").insert({
      run_id: runId,
      source_id: source.id,
      status: "failed",
      coverage_status: "unknown",
      market_jobs_kept: 0,
      stop_reason: "request-or-processing-error",
      error: message,
    });
    return {
      sourceId: source.id,
      status: "failed",
      coverageStatus: "unknown",
      fetched: 0,
      created: 0,
      updated: 0,
      error: message,
    };
  }
}

async function synchronizeJobs(client: SupabaseClient, requestedBy: string) {
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
  await client
    .from("job_sync_runs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error: "Synchronization timed out.",
    })
    .eq("status", "running")
    .lt("started_at", staleCutoff);

  const { data: run, error: runError } = await client
    .from("job_sync_runs")
    .insert({ requested_by: requestedBy, sources_attempted: jobSources.length })
    .select("id")
    .single();
  if (runError) {
    if (runError.code === "23505") {
      throw new ProviderRequestError(
        "The job market is already synchronizing.",
        409,
      );
    }
    throw runError;
  }

  try {
    const results: SourceSyncResult[] = [];
    for (const source of jobSources) {
      results.push(await syncSource(client, run.id as string, source));
    }

    const succeeded = results.filter(
      (result) => result.status === "succeeded",
    ).length;
    const failed = results.filter(
      (result) => result.status === "failed",
    ).length;
    const incomplete = results.filter(
      (result) =>
        result.status === "succeeded" && result.coverageStatus !== "complete",
    ).length;
    const status =
      succeeded === 0 ? "failed" : failed > 0 ? "partial" : "succeeded";
    const totals = results.reduce(
      (sum, result) => ({
        fetched: sum.fetched + result.fetched,
        created: sum.created + result.created,
        updated: sum.updated + result.updated,
      }),
      { fetched: 0, created: 0, updated: 0 },
    );
    const completedAt = new Date().toISOString();
    const { error: completionError } = await client
      .from("job_sync_runs")
      .update({
        status,
        completed_at: completedAt,
        sources_succeeded: succeeded,
        jobs_fetched: totals.fetched,
        jobs_created: totals.created,
        jobs_updated: totals.updated,
        error:
          failed > 0
            ? `${failed} source${failed === 1 ? "" : "s"} failed.`
            : null,
      })
      .eq("id", run.id);
    if (completionError) throw completionError;

    return {
      runId: run.id as string,
      status,
      incompleteSources: incomplete,
      ...totals,
      sources: results,
    };
  } catch (error) {
    await client
      .from("job_sync_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error:
          error instanceof Error ? error.message : "Synchronization failed.",
      })
      .eq("id", run.id);
    throw error;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "Method not allowed." }, 405);
  }

  try {
    const client = serviceClient();
    const syncSecret = Deno.env.get("PROVIDER_SYNC_SECRET");
    const scheduled = Boolean(
      syncSecret && request.headers.get("x-sync-secret") === syncSecret,
    );
    let requestedBy: string;

    if (scheduled) {
      const { data: admin, error } = await client
        .from("profiles")
        .select("id")
        .eq("status", "approved")
        .eq("role", "admin")
        .order("created_at", { ascending: true })
        .limit(1)
        .single();
      if (error || !admin) throw new Error("An approved admin is required.");
      requestedBy = admin.id as string;
    } else {
      const approvedUser = await requireApprovedUser(request, client);
      requireAdmin(approvedUser);
      requestedBy = approvedUser.user.id;
    }

    return jsonResponse(request, await synchronizeJobs(client, requestedBy));
  } catch (error) {
    console.error("Job synchronization failed", error);
    const status = error instanceof ProviderRequestError ? error.status : 500;
    return jsonResponse(request, { error: publicError(error) }, status);
  }
});
