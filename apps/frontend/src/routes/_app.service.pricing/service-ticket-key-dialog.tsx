import { useState } from "react";
import { Copy, KeyRound, LoaderCircle } from "lucide-react";
import { Link } from "react-router";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ServiceBillingError } from "@/services/service-billing/service-billing-service";
import type { PurchasedTicket } from "@/services/service-billing/service-billing-types";
import { copyText } from "@/utils/utils.clipboard";

import { formatMoment } from "./service-ticket-text";

interface ServiceTicketKeyDialogProps {
  title: string;
  description: string;
  // The button that does it: "Buy for $4.00", "Get a new key".
  confirmLabel: string;
  // Does it, and answers the key, which is shown once.
  run: () => Promise<PurchasedTicket>;
  // What is said for a failure, by the status the API answered with.
  explain?: (error: ServiceBillingError) => string;
  // The key was made; the page refreshes what it shows.
  onDone: () => void;
  onClose: () => void;
}

// Two steps of one dialog: ask first, since it takes money or kills the key that
// was, then show the new key once. Closing it after the key is shown is the only
// way to lose the key, and the dialog says where to get another.
export default function ServiceTicketKeyDialog({
  confirmLabel,
  description,
  explain,
  onClose,
  onDone,
  run,
  title,
}: ServiceTicketKeyDialogProps) {
  const [ticket, setTicket] = useState<PurchasedTicket | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);

    try {
      setTicket(await run());
      onDone();
    } catch (failure) {
      setError(
        failure instanceof ServiceBillingError
          ? (explain?.(failure) ?? failure.message)
          : "The request could not be completed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        {ticket ? (
          <>
            <DialogHeader>
              <DialogTitle>Your key</DialogTitle>

              <DialogDescription>
                {ticket.name} runs on its account until{" "}
                {formatMoment(ticket.expiresAt)}.
              </DialogDescription>
            </DialogHeader>

            <section className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50 p-3">
              <Label htmlFor="ticket-key">
                Copy now — this key is shown once
              </Label>

              <Flex className="items-center gap-2">
                <Input
                  className="font-mono text-xs"
                  id="ticket-key"
                  readOnly
                  value={ticket.key}
                />

                <Button
                  aria-label="Copy key"
                  onClick={() => void copyText(ticket.key)}
                  size="icon"
                  type="button"
                  variant="outline"
                >
                  <Copy aria-hidden="true" />
                </Button>
              </Flex>
            </section>

            <p className="text-xs text-zinc-500">
              Use it like any Hub key: see{" "}
              <Link
                className="font-medium text-indigo-600 hover:underline"
                onClick={onClose}
                to="/tools?node=gateway"
              >
                Tools → Gateway
              </Link>
              . If you lose it, ask for a new one under Your tickets.
            </p>

            <DialogFooter>
              <Button onClick={onClose} type="button">
                I have copied it
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>

              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button
                disabled={pending}
                onClick={onClose}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>

              <Button
                disabled={pending}
                onClick={() => void confirm()}
                type="button"
              >
                {pending ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : (
                  <KeyRound aria-hidden="true" />
                )}
                {confirmLabel}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
