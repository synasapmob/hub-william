import CopyCommand from "@/components/copy-command";
import catalogService from "@/services/catalog";
import useSiteOrigin from "@/utils/utils.site-origin";

/**
 * One dependency-free bootstrap command, shared by every surface that prints
 * the global install so the copy never drifts.
 */
export default function InstallCommands() {
  const siteOrigin = useSiteOrigin();

  return (
    <CopyCommand
      command={`curl -fsSL ${catalogService.installerUrl(siteOrigin)} | python3 -`}
    />
  );
}
