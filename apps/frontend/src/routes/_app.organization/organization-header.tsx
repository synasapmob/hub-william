import { Building2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type { Organization } from "@/services/organizations";

interface OrganizationHeaderProps {
  invitationCount: number;
  // The session or the organization list is still loading.
  loading: boolean;
  onCreate: () => void;
  onManage: () => void;
  organization: Organization | null;
  signedIn: boolean;
}

export default function OrganizationHeader({
  invitationCount,
  loading,
  onCreate,
  onManage,
  organization,
  signedIn,
}: OrganizationHeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 pb-4">
      <Flex className="min-w-0 flex-wrap items-center gap-3">
        <p className="font-mono text-xs tracking-widest text-zinc-400 uppercase">
          Organization
        </p>

        {loading || organization ? (
          <Separator
            className="h-4 data-vertical:self-center"
            orientation="vertical"
          />
        ) : null}

        {loading ? (
          <Skeleton className="h-8 w-36 rounded-4xl bg-zinc-200" />
        ) : organization ? (
          <Badge className="h-8 max-w-full px-4 text-sm font-semibold">
            <span className="truncate">{organization.name}</span>
          </Badge>
        ) : null}
      </Flex>

      {loading || signedIn ? (
        <Flex className="flex-wrap items-center gap-2">
          {loading ? (
            <>
              <Skeleton className="h-9 w-44 rounded-lg bg-zinc-200" />

              <Skeleton className="h-9 w-44 rounded-lg bg-zinc-200" />
            </>
          ) : (
            <>
              <Button
                className="px-4"
                onClick={onManage}
                size="lg"
                type="button"
                variant="outline"
              >
                <Building2 aria-hidden="true" />
                My organizations
                {invitationCount > 0 ? (
                  <Badge className="h-4 min-w-4 bg-indigo-600 px-1 text-[10px] text-white">
                    {invitationCount}
                    <span className="sr-only"> pending invitations</span>
                  </Badge>
                ) : null}
              </Button>

              {organization ? (
                <Button
                  className="px-4"
                  onClick={onCreate}
                  size="lg"
                  type="button"
                  variant="outline"
                >
                  <Plus aria-hidden="true" />
                  New organization
                </Button>
              ) : null}
            </>
          )}
        </Flex>
      ) : null}
    </header>
  );
}
