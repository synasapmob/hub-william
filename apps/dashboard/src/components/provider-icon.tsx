import { useProviderIcons } from "@/components/provider-icons-context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { providerIconUrl } from "@/utils/utils.provider-icon";

interface ProviderIconProps {
  provider: string;
  /** `lg` unless it sits in a list of agents, where `sm` fits a row. */
  size?: "default" | "sm" | "lg";
  /** The label to show, as the first letter, when there is no icon. */
  label?: string;
}

/**
 * An agent's icon, or its first letter when it has none: the one the shop chose
 * for it, else the one Hub William ships with.
 */
export default function ProviderIcon({
  label,
  provider,
  size = "lg",
}: ProviderIconProps) {
  const { iconOf } = useProviderIcons();
  const url = iconOf(provider)?.url ?? providerIconUrl(provider);

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
