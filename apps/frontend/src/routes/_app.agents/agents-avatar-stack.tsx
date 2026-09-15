import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import type { AgentPoolPerson } from "@/services/agent-pools";

interface AgentsAvatarStackProps {
  people: AgentPoolPerson[];
}

export default function AgentsAvatarStack({ people }: AgentsAvatarStackProps) {
  const visiblePeople = people.slice(0, 2);
  const remaining = Math.max(people.length - visiblePeople.length, 0);

  if (people.length === 0) return null;

  return (
    <AvatarGroup>
      {visiblePeople.map((person) => (
        <Avatar key={person.username} size="sm">
          <AvatarFallback className="bg-zinc-900 text-[9px] font-semibold text-white">
            {person.avatarLabel}
            <span className="sr-only">{person.username}</span>
          </AvatarFallback>
        </Avatar>
      ))}
      {remaining > 0 ? (
        <AvatarGroupCount className="bg-zinc-200 text-[9px] font-bold text-zinc-700">
          +{remaining}
        </AvatarGroupCount>
      ) : null}
    </AvatarGroup>
  );
}
