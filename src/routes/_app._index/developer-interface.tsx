import CopyCommand from "@/components/copy-command";

interface WorkspaceCommand {
  caption: string;
  command: string;
}

const commands: WorkspaceCommand[] = [
  {
    caption: "1. Initialize a new agent workspace",
    command: "npx hub-william init --harness=frontend-engineer",
  },
  {
    caption: "2. Install community skills and hooks",
    command: "hub add @william/react-code-review @william/auto-test-hook",
  },
  {
    caption: "3. Run agent with live telemetry observation",
    command: "hub run --observe --trace-tokens",
  },
];

export default function DeveloperInterface() {
  return (
    <div className="space-y-3">
      {commands.map((entry) => (
        <div
          key={entry.command}
          className="space-y-1.5 rounded-xl border border-border bg-card p-3.5"
        >
          <p className="font-mono text-xs text-muted-foreground">
            {entry.caption}
          </p>

          <CopyCommand command={entry.command} />
        </div>
      ))}
    </div>
  );
}
