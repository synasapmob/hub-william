import { ImageIcon } from "lucide-react";

import { useProviderIcons } from "@/components/provider-icons-context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface ProviderIconProps {
  provider: string;
  /** `lg` unless it sits in a list of agents, where `sm` fits a row. */
  size?: "default" | "sm" | "lg";
}

/**
 * A provider's icon: the one the shop chose for it, kept in the icon bucket. A
 * provider is made with one, so an empty frame means it was lost (the picture was
 * deleted, or the bucket is not set up) and not that the shop never gave it one.
 */
export default function ProviderIcon({
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

      <AvatarFallback className="rounded-md border border-dashed bg-muted/40 text-muted-foreground">
        <ImageIcon aria-hidden={true} className="size-1/2" />
      </AvatarFallback>
    </Avatar>
  );
}
