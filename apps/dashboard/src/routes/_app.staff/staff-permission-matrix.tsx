import { Check, Minus } from "lucide-react";

import Panel from "@/components/panel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  permissionLabels,
  roleLabels,
  rolePermissions,
} from "@/services/sales/sales-labels";
import type { Permission, Role } from "@/services/sales/sales-types";

/** What each role may do, so nobody has to open an account to find out. */
export default function StaffPermissionMatrix() {
  return (
    <Panel className="space-y-3" padded={false}>
      <div className="space-y-0.5 px-4 pt-4">
        <h2 className="text-sm font-semibold">Quyền theo vai trò</h2>

        <p className="text-xs text-muted-foreground">
          Trang nào cũng kiểm tra quyền trước khi mở. Vai trò không có quyền
          không thấy mục đó trên menu.
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Quyền</TableHead>

            {(Object.keys(roleLabels) as Role[]).map((role) => (
              <TableHead key={role} className="text-center">
                {roleLabels[role]}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>

        <TableBody>
          {(Object.keys(permissionLabels) as Permission[]).map((permission) => (
            <TableRow key={permission}>
              <TableCell>{permissionLabels[permission]}</TableCell>

              {(Object.keys(roleLabels) as Role[]).map((role) => (
                <TableCell key={role} className="text-center">
                  {rolePermissions[role].includes(permission) ? (
                    <>
                      <Check
                        aria-hidden={true}
                        className="mx-auto size-4 text-emerald-600"
                      />

                      <span className="sr-only">Có</span>
                    </>
                  ) : (
                    <>
                      <Minus
                        aria-hidden={true}
                        className="mx-auto size-4 text-zinc-300"
                      />

                      <span className="sr-only">Không</span>
                    </>
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
