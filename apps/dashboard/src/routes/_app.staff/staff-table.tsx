import { Trash2 } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { roleLabels } from "@/services/sales/sales-labels";
import type { Role, StaffMember } from "@/services/sales/sales-types";
import { formatDateTime, formatVnd, initials } from "@/utils/utils.format";

// Every role can be given, the owner's included; the last owner is the one the server locks.
const GRANTABLE_ROLES: Role[] = ["owner", "manager", "cashier", "stock-keeper"];

interface StaffTableProps {
  /** The state of the request for the staff. */
  status: "pending" | "error" | "success";
  /** The message of the failed request, when it failed. */
  error: string | null;
  members: StaffMember[];
  /** The member who is looking, who cannot be removed by themselves. */
  selfId: string;
  onChangeRole: (member: StaffMember, role: Role) => void;
  onRemove: (member: StaffMember) => void;
  onRetry: () => void;
}

export default function StaffTable({
  error,
  members,
  onChangeRole,
  onRemove,
  onRetry,
  selfId,
  status,
}: StaffTableProps) {
  if (status === "pending") {
    return (
      <div className="space-y-2 rounded-xl border bg-card p-4" role="status">
        <span className="sr-only">Đang tải nhân viên…</span>

        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="space-y-3 rounded-xl border bg-card py-10 text-center">
        <p className="text-sm text-destructive" role="alert">
          {error ?? "Không tải được nhân viên."}
        </p>

        <Button variant="outline" onClick={onRetry}>
          Thử lại
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nhân viên</TableHead>

            <TableHead>Vai trò</TableHead>

            <TableHead>Hôm nay</TableHead>

            <TableHead>Hoạt động gần nhất</TableHead>

            <TableHead className="w-12">
              <span className="sr-only">Xóa</span>
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {members.map((member) => (
            <TableRow key={member.id}>
              <TableCell>
                <Flex className="items-center gap-3">
                  <Avatar>
                    <AvatarFallback>{initials(member.username)}</AvatarFallback>
                  </Avatar>

                  <p className="font-medium">
                    {member.username}
                    {member.id === selfId && (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        (bạn)
                      </span>
                    )}
                  </p>
                </Flex>
              </TableCell>

              <TableCell>
                {member.locked ? (
                  <span className="text-sm">{roleLabels[member.role]}</span>
                ) : (
                  <Select
                    value={member.role}
                    onValueChange={(next) => onChangeRole(member, next as Role)}
                  >
                    <SelectTrigger
                      aria-label={`Vai trò của ${member.username}`}
                      className="w-36"
                    >
                      <SelectValue />
                    </SelectTrigger>

                    <SelectContent>
                      {GRANTABLE_ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          {roleLabels[role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </TableCell>

              <TableCell className="tabular-nums">
                <p>{member.orders_today} đơn</p>

                <p className="text-xs text-muted-foreground">
                  {formatVnd(member.revenue_today_vnd)}
                </p>
              </TableCell>

              <TableCell className="text-muted-foreground tabular-nums">
                {member.last_active_at
                  ? formatDateTime(member.last_active_at)
                  : "Chưa đăng nhập"}
              </TableCell>

              <TableCell>
                {!member.locked && member.id !== selfId && (
                  <Button
                    aria-label={`Xóa ${member.username}`}
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => onRemove(member)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
