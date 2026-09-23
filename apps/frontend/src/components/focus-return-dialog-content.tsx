import { useRef, type ComponentProps, type ReactNode } from "react";

import { DialogContent } from "@/components/ui/dialog";

interface FocusReturnDialogContentProps extends ComponentProps<
  typeof DialogContent
> {
  children: ReactNode;
}

// Controlled dialogs without a DialogTrigger still return focus to their opener.
export default function FocusReturnDialogContent({
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: FocusReturnDialogContentProps) {
  const openerRef = useRef<HTMLElement | null>(null);
  const parentDialogRef = useRef<HTMLElement | null>(null);

  return (
    <DialogContent
      {...props}
      onOpenAutoFocus={(event) => {
        openerRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        parentDialogRef.current =
          openerRef.current?.closest('[role="dialog"]') ?? null;
        onOpenAutoFocus?.(event);
      }}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        if (event.defaultPrevented) return;
        const opener = openerRef.current;
        const target =
          opener?.isConnected && !opener.matches(":disabled")
            ? opener
            : parentDialogRef.current;
        if (!target?.isConnected) return;
        event.preventDefault();
        target.focus({ preventScroll: true });
      }}
    />
  );
}
