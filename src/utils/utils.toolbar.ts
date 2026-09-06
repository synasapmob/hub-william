/**
 * The canvas toolbar's own control.
 *
 * Two popovers sit in that header — which catalogue is open, and how to take it
 * away — and a reader reads them as one row rather than as two components that
 * happen to be adjacent. The string lives here rather than in either of them
 * because a class two files read from two places is one that drifts the first
 * time somebody restyles one of them.
 */
export const toolbarTrigger =
  "flex items-center gap-1.5 rounded-xl border border-slate-200/80 bg-slate-100 px-3 py-2 font-mono text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden";
