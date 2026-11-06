import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import type { OwnedTicket } from "@/services/service-billing/service-billing-types";

import { formatDay } from "./service-ticket-text";

interface ServiceOwnedTicketsProps {
  tickets: OwnedTicket[];
  onReplace: (ticket: OwnedTicket) => void;
}

// What the signed-in user bought: the key is never shown again, so a lost one is
// replaced here.
export default function ServiceOwnedTickets({
  onReplace,
  tickets,
}: ServiceOwnedTicketsProps) {
  return (
    <section className="space-y-3">
      <h2 className="font-heading text-lg font-semibold tracking-tight">
        Your tickets
      </h2>

      <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white shadow-xs">
        {tickets.map((ticket) => (
          <li key={ticket.keyId} className="p-4">
            <Flex className="flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium wrap-anywhere">
                  {ticket.name}
                </p>

                <p className="text-xs text-zinc-500">
                  <span className="font-mono">
                    hw_tkt_********{ticket.lastFour}
                  </span>
                  {" · "}
                  {ticket.status === "active" ? "ends" : "ended"}{" "}
                  {formatDay(ticket.expiresAt)}
                </p>
              </div>

              <Badge
                variant={ticket.status === "active" ? "default" : "secondary"}
              >
                {ticket.status === "active" ? "Active" : "Ended"}
              </Badge>

              {ticket.status === "active" && (
                <Button
                  aria-label={`Get a new key for ${ticket.name}`}
                  onClick={() => onReplace(ticket)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  New key
                </Button>
              )}
            </Flex>
          </li>
        ))}
      </ul>
    </section>
  );
}
