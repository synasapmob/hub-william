import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { authService } from "@/services/auth/auth-service";
import type { AuthenticatedUser } from "@/services/auth/auth-types";

interface WorkspaceShellAvatarProps {
  user: AuthenticatedUser;
}

export default function WorkspaceShellAvatar({
  user,
}: WorkspaceShellAvatarProps) {
  const imageUrl = authService.githubAvatarUrl(user.username);
  return (
    <Avatar key={`${user.id}:${user.username}`} size="sm">
      {imageUrl ? (
        <AvatarImage
          src={imageUrl}
          alt={user.username}
          referrerPolicy="no-referrer"
        />
      ) : null}

      <AvatarFallback className="bg-zinc-900 text-[10px] text-white">
        {user.username.slice(0, 3)}
      </AvatarFallback>
    </Avatar>
  );
}
