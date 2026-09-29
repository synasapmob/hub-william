import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, Mail } from "lucide-react";
import { Link, useMatch } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import organizationsService from "@/services/organizations";
import { MY_ORGANIZATION_PATH } from "@/utils/utils.organization-tabs";

import { useWorkspaceSession } from "./workspace-shell-session-context";

const skeletonNotifications = [0, 1];

interface WorkspaceShellNotificationsProps {
  onNavigate?: () => void;
}

// Organization invitations are the only notification today. Each one opens
// My organizations, where the user accepts or declines it.
export default function WorkspaceShellNotifications({
  onNavigate,
}: WorkspaceShellNotificationsProps) {
  const session = useWorkspaceSession();
  const userId = session.user?.id;
  const inPlayground = Boolean(useMatch("/playground"));
  const [open, setOpen] = useState(false);
  // Same query as the Organization page, so the two never disagree.
  const invitationsQuery = useQuery({
    enabled: Boolean(userId),
    queryFn: organizationsService.invitations,
    queryKey: [
      ...organizationsService.queryKey,
      "invitations",
      userId ?? "guest",
    ],
    // Playground keeps its setup stable while a chat or call is running.
    refetchOnWindowFocus: !inPlayground,
    refetchOnReconnect: !inPlayground,
  });
  const invitations = invitationsQuery.data ?? [];

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          className="relative"
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Bell aria-hidden="true" />
          {invitations.length > 0 ? (
            <Badge
              aria-hidden="true"
              className="absolute -top-1 -right-1 h-4 min-w-4 bg-indigo-600 px-1 text-[10px] text-white"
            >
              {invitations.length > 9 ? "9+" : invitations.length}
            </Badge>
          ) : null}
          <span className="sr-only">
            {invitations.length > 0
              ? `Notifications, ${invitations.length} pending ${invitations.length === 1 ? "invitation" : "invitations"}`
              : "Notifications"}
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="w-72"
        collisionPadding={16}
        side="top"
        sideOffset={8}
      >
        <PopoverHeader>
          <PopoverTitle>Notifications</PopoverTitle>
        </PopoverHeader>

        {invitationsQuery.isPending ? (
          <ul aria-hidden="true" className="space-y-1">
            {skeletonNotifications.map((key) => (
              <li key={key} className="flex items-start gap-2.5 p-2">
                <Skeleton className="size-8 shrink-0 rounded-lg bg-zinc-200" />

                <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
                  <Skeleton className="h-3 w-24 bg-zinc-200" />

                  <Skeleton className="h-2.5 w-full bg-zinc-100" />
                </div>
              </li>
            ))}
          </ul>
        ) : invitationsQuery.error ? (
          <Flex className="flex-col items-start gap-2 p-1">
            <p role="alert" className="text-xs text-destructive">
              Notifications could not be loaded.
            </p>

            <Button
              onClick={() => void invitationsQuery.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </Flex>
        ) : invitations.length > 0 ? (
          <ul className="space-y-1">
            {invitations.map((invitation) => (
              <li key={invitation.id}>
                <Link
                  className="flex items-start gap-2.5 rounded-lg p-2 hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                  onClick={() => {
                    setOpen(false);
                    onNavigate?.();
                  }}
                  to={MY_ORGANIZATION_PATH}
                >
                  <Center className="size-8 shrink-0 rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-600">
                    <Mail aria-hidden="true" className="size-4" />
                  </Center>

                  <div className="min-w-0">
                    <p className="text-xs font-semibold wrap-anywhere text-zinc-900">
                      Invitation to {invitation.organizationName}
                    </p>

                    <p className="mt-0.5 text-[11px] text-zinc-500">
                      @{invitation.invitedByUsername ?? "someone"} invited you.
                      Review and accept.
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/50 p-4 text-center text-xs text-zinc-500">
            You're all caught up. Organization invitations show up here.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
