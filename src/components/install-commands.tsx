import CopyCommand from "@/components/copy-command";
import { GITHUB_REPOSITORY_URL } from "@/services/catalog";

/**
 * The install, in full, because there is nothing shorter that is true.
 *
 * Nothing is published to a package registry and there is deliberately no
 * wrapper command to install first — a wrapper is one more thing that has to be
 * present and correct before you can fix anything, and this is the tool you
 * reach for when a machine is not set up yet. So the installer is a script in
 * the repository, and cloning it is the install.
 *
 * It is one component because the specification and the catalogue sheet both
 * print it, and an install command that drifts between the two is one a reader
 * cannot trust.
 */
const installCommands = [
  `git clone ${GITHUB_REPOSITORY_URL}.git`,
  "cd hub-william/scripts/machine",
  "./install.sh init",
];

export default function InstallCommands() {
  return (
    <div className="space-y-2">
      {installCommands.map((command) => (
        <CopyCommand key={command} command={command} />
      ))}
    </div>
  );
}
