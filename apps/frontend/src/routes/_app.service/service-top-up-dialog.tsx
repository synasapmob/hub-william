import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import { serviceBillingService } from "@/services/service-billing/service-billing-service";
import { redirectTo } from "@/utils/utils.navigation";
import {
  dollarsToMicro,
  formatDollars,
  MICRO_PER_DOLLAR,
} from "@/utils/utils.money";

// The API enforces the same range; this only keeps the button honest.
const MIN_TOP_UP_MICRO = MICRO_PER_DOLLAR;
const MAX_TOP_UP_MICRO = 1_000 * MICRO_PER_DOLLAR;
// A card payment is a whole number of cents.
const MICRO_PER_CENT = 10_000;

interface ServiceTopUpFormProps {
  // Pay by card on a Stripe page; otherwise the wallet is credited at once.
  card: boolean;
  onDone: () => void;
}

function ServiceTopUpForm({ card, onDone }: ServiceTopUpFormProps) {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("10");
  const micro = dollarsToMicro(amount);
  const inRange =
    micro !== null && micro >= MIN_TOP_UP_MICRO && micro <= MAX_TOP_UP_MICRO;
  const wholeCents = micro !== null && micro % MICRO_PER_CENT === 0;
  const valid = inRange && (!card || wholeCents);
  const topUp = useMutation({
    mutationFn: (amountMicro: number) =>
      serviceBillingService.topUp(amountMicro),
    onSuccess: (result) => {
      // Paying by card leaves this page; the wallet changes when Stripe says so.
      if (result.checkoutUrl) {
        redirectTo(result.checkoutUrl);

        return;
      }

      queryClient.setQueryData(
        serviceBillingService.walletQueryKey(session.user?.id),
        { walletMicro: result.walletMicro },
      );
      onDone();
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) topUp.mutate(micro);
      }}
    >
      <Flex className="flex-wrap gap-2">
        {[5, 10, 20, 50].map((preset) => (
          <Button
            key={preset}
            onClick={() => setAmount(String(preset))}
            size="sm"
            type="button"
            variant={amount === String(preset) ? "default" : "outline"}
          >
            ${preset}
          </Button>
        ))}
      </Flex>

      <div className="space-y-1.5">
        <Label htmlFor="top-up-amount">Amount (USD)</Label>

        <Input
          id="top-up-amount"
          inputMode="decimal"
          onChange={(event) => setAmount(event.target.value)}
          value={amount}
        />

        <p className="text-xs text-muted-foreground">
          From {formatDollars(MIN_TOP_UP_MICRO)} to{" "}
          {formatDollars(MAX_TOP_UP_MICRO)} at a time.
          {card
            ? " You pay on Stripe's page, and the balance updates when the payment is confirmed."
            : ""}
        </p>
      </div>

      {topUp.error ? (
        <Alert variant="destructive">
          <AlertDescription>{topUp.error.message}</AlertDescription>
        </Alert>
      ) : null}

      <Button
        className="w-full"
        disabled={!valid || topUp.isPending || topUp.isSuccess}
        type="submit"
      >
        {topUp.isSuccess && card
          ? "Opening Stripe…"
          : valid
            ? card
              ? `Pay ${formatDollars(micro)} by card`
              : `Top up ${formatDollars(micro)}`
            : micro === null
              ? "Enter an amount"
              : !inRange
                ? "Amount out of range"
                : "Use whole cents"}
      </Button>
    </form>
  );
}

interface ServiceTopUpDialogProps {
  // Whether a top-up is paid by card, on a Stripe page.
  cardTopUp: boolean;
  // Whether topping up works without a payment, which is staging only.
  testTopUp: boolean;
}

export default function ServiceTopUpDialog({
  cardTopUp,
  testTopUp,
}: ServiceTopUpDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" type="button">
          <Plus aria-hidden="true" />
          Top up
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Top up your wallet</DialogTitle>

          <DialogDescription>
            Money you add goes to your balance. Each request you send is charged
            from it, at the price of the model the request uses.
          </DialogDescription>
        </DialogHeader>

        {cardTopUp || testTopUp ? (
          <ServiceTopUpForm card={cardTopUp} onDone={() => setOpen(false)} />
        ) : (
          <Alert>
            <AlertDescription>
              Top up is not available yet. Payments are coming soon.
            </AlertDescription>
          </Alert>
        )}
      </DialogContent>
    </Dialog>
  );
}
