import type { PropsWithChildren } from "react";

/** The padded column every page renders into. */
export default function PageBody({ children }: PropsWithChildren) {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-4 md:p-6">
      {children}
    </div>
  );
}
