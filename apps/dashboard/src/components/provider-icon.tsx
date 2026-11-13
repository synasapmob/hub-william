import { useProviderIcons } from "@/components/provider-icons-context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface ProviderIconProps {
  provider: string;
  /** `lg` unless it sits in a list of agents, where `sm` fits a row. */
  size?: "default" | "sm" | "lg";
  /** The label to show, as the first letter, when there is no icon. */
  label?: string;
}

/**
 * A provider's icon, the one the shop chose for it (kept in the icon bucket), or its
 * first letter while it has none, the bucket is not set up, or the picture does not load.
 */
export default function ProviderIcon({
  label,
  provider,
  size = "lg",
}: ProviderIconProps) {
  const { iconOf } = useProviderIcons();
  const url = iconOf(provider)?.url;

  return (
    <Avatar className="rounded-md after:rounded-md after:border-0" size={size}>
      {url && (
        <AvatarImage alt="" className="rounded-md object-contain" src={url} />
      )}

      <AvatarFallback className="rounded-md">
        {(label ?? provider).trim().charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
