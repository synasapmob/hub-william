import { useState } from "react";

import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";

import DashboardGateScreen from "./dashboard-gate-screen";
import DashboardLoginForm from "./dashboard-login-form";
import DashboardRegisterForm from "./dashboard-register-form";

/** The way in: sign in, or make the account first. Both are Hub William accounts. */
export default function DashboardLogin() {
  const [registering, setRegistering] = useState(false);

  return (
    <DashboardGateScreen
      description={
        registering
          ? "This is a Hub William account, shared with the storefront. Once it is made, send your username to the shop owner to be added to the staff list."
          : "Use your Hub William account. The shop owner has to add it to the staff list first."
      }
      title={registering ? "Register" : "Dashboard login"}
    >
      {registering ? <DashboardRegisterForm /> : <DashboardLoginForm />}

      <Flex className="items-center justify-center gap-1 text-sm text-muted-foreground">
        {registering ? "Already have an account?" : "No account yet?"}

        <Button
          className="h-auto p-0"
          type="button"
          variant="link"
          onClick={() => setRegistering(!registering)}
        >
          {registering ? "Login" : "Register"}
        </Button>
      </Flex>
    </DashboardGateScreen>
  );
}
