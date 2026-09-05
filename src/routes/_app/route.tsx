import WorkspaceShell from "./workspace-shell";

/**
 * The workspace layout is open.
 *
 * It used to redirect anyone without an approved profile to `/login`, because
 * every page under it read that account's usage. The pages under it now are the
 * specification, the public component catalogue, and telemetry that is fixture
 * data until a runtime writes real rows — none of which belong to a reader. The
 * account pages remain at `/login` and `/register`.
 */
export default function AppLayoutRoute() {
  return <WorkspaceShell />;
}
