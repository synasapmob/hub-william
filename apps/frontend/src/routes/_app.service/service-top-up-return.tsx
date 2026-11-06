import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import { serviceBillingService } from "@/services/service-billing/service-billing-service";

// Stripe confirms a payment with a webhook that can arrive a moment after the
// customer is back, so the balance is read again a few times.
const REREAD_AFTER_MS = [0, 2_000, 5_000, 10_000];

// Where Stripe sends the customer back to (`?topup=success` or `?topup=cancelled`):
// says how the payment went, and looks for the new balance.
export default function ServiceTopUpReturn() {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const outcome = params.get("topup");
  const userId = session.user?.id;
  const handled = useRef(false);

  useEffect(() => {
    // The balance is looked for under the customer's own key, which is known once
    // the session has loaded.
    if (!outcome || handled.current || session.status !== "authenticated")
      return;

    handled.current = true;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);

        next.delete("topup");

        return next;
      },
      { replace: true },
    );

    if (outcome === "cancelled") {
      toast("Payment cancelled. Nothing was charged.");

      return;
    }

    if (outcome !== "success") return;

    toast.success("Payment received. Your balance updates in a moment.");
    const reread = () =>
      queryClient.invalidateQueries({
        queryKey: serviceBillingService.walletQueryKey(userId),
      });

    for (const delay of REREAD_AFTER_MS)
      window.setTimeout(() => void reread(), delay);
  }, [outcome, queryClient, session.status, setParams, userId]);

  return null;
}
