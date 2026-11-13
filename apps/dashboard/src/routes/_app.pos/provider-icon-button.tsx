import { useState } from "react";

import { useDashboardSession } from "@/components/dashboard-shell/dashboard-session-context";
import ProviderIcon from "@/components/provider-icon";
import { useProviderIcons } from "@/components/provider-icons-context";
import slugify from "@/utils/utils.slug";

import ProviderIconDialog from "./provider-icon-dialog";

interface ProviderIconButtonProps {
  provider: string;
  /** What to call the provider, when it differs from how it is written. */
  label?: string;
}

/**
 * The icon of a provider's card. For staff who manage stock, with the icon bucket
 * set up, it opens the choice of another; for anyone else it is only the picture.
 */
export default function ProviderIconButton({
  label,
  provider,
}: ProviderIconButtonProps) {
  const { enabled, iconOf } = useProviderIcons();
  const { can } = useDashboardSession();
  const [open, setOpen] = useState(false);

  if (!enabled || !can("stock") || !slugify(provider)) {
    return <ProviderIcon provider={provider} />;
  }

  return (
    <>
      <button
        aria-label={`${iconOf(provider) ? "Đổi" : "Chọn"} icon ${label ?? provider}`}
        className="rounded-md outline-none hover:opacity-80 focus-visible:ring-3 focus-visible:ring-ring/50"
        type="button"
        onClick={() => setOpen(true)}
      >
        <ProviderIcon provider={provider} />
      </button>

      {open && (
        <ProviderIconDialog
          name={label ?? provider}
          provider={provider}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
