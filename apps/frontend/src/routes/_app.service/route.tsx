import { Outlet } from "react-router";

import ServiceTopUpReturn from "./service-top-up-return";
import ServiceWalletBar from "./service-wallet-bar";

/**
 * Layout of the SERVICE pages: the wallet and credit stay on top of every page,
 * with the Top up button beside them.
 */
export default function ServiceRoute() {
  return (
    <section className="mx-auto w-full max-w-7xl space-y-5 px-4 pt-5 pb-8 sm:px-6 lg:px-8">
      <ServiceTopUpReturn />

      <ServiceWalletBar />

      <Outlet />
    </section>
  );
}
