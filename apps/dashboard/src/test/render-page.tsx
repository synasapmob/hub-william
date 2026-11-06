import type { ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import DashboardSession from "@/components/dashboard-shell/dashboard-session";
import { rolePermissions } from "@/services/sales/sales-labels";
import type { Role } from "@/services/sales/sales-types";
import createQueryClient from "@/utils/utils.query-client";

// Made-up accounts, one per role.
const USERNAMES: Record<Role, string> = {
  owner: "minhanh",
  manager: "quocbao",
  cashier: "thuha",
  "stock-keeper": "ducthinh",
};

/**
 * Renders a page the way the shell does: inside a router, a query client and a
 * session of a member of staff in the given role. The session is what the API
 * would answer, so no request is made for it.
 */
export default function renderPage(page: ReactElement, role: Role = "owner") {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <DashboardSession
          identity={{
            id: `account-${role}`,
            permissions: rolePermissions[role],
            role,
            username: USERNAMES[role],
          }}
          onSignOut={() => {}}
        >
          {page}
        </DashboardSession>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
