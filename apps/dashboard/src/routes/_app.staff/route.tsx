import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";

import { useDashboardSession } from "@/components/dashboard-shell/dashboard-session-context";
import PageBody from "@/components/page-body";
import PageHeader from "@/components/page-header";
import PermissionGate from "@/components/permission-gate";
import { Button } from "@/components/ui/button";
import { roleLabels } from "@/services/sales/sales-labels";
import type { Role, StaffMember } from "@/services/sales/sales-types";
import { staffService } from "@/services/staff/staff-service";

import StaffDeleteDialog from "./staff-delete-dialog";
import StaffFormDialog from "./staff-form-dialog";
import StaffPermissionMatrix from "./staff-permission-matrix";
import StaffTable from "./staff-table";

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : undefined;
}

export default function StaffRoute() {
  const queryClient = useQueryClient();
  const session = useDashboardSession();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<StaffMember | null>(null);

  const staff = useQuery({
    // A role without the staff permission is shown the refusal, not an error.
    enabled: session.can("staff"),
    queryFn: () => staffService.list(),
    queryKey: staffService.queryKey,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: staffService.queryKey });
  const add = useMutation({
    mutationFn: ({ role, username }: { role: Role; username: string }) =>
      staffService.add(username, role),
    onSettled: refresh,
  });
  const changeRole = useMutation({
    mutationFn: ({ member, role }: { member: StaffMember; role: Role }) =>
      staffService.changeRole(member.id, role),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (member: StaffMember) => staffService.remove(member.id),
    onSettled: refresh,
  });

  return (
    <PermissionGate permission="staff">
      <PageBody>
        <PageHeader
          description="Mỗi người một tài khoản Hub William. Nhân viên chỉ thấy và làm được những gì vai trò của họ cho phép."
          title="Nhân viên"
        >
          <Button onClick={() => setAdding(true)}>
            <UserPlus data-icon="inline-start" />
            Thêm nhân viên
          </Button>
        </PageHeader>

        <StaffTable
          error={messageOf(staff.error) ?? null}
          members={staff.data ?? []}
          selfId={session.staff.id}
          status={staff.status}
          onChangeRole={async (member, role) => {
            try {
              await changeRole.mutateAsync({ member, role });
            } catch (error) {
              toast.error("Không đổi được vai trò", {
                description: messageOf(error),
              });

              return;
            }

            toast.success(
              `${member.username} giờ là ${roleLabels[role].toLowerCase()}`,
            );
          }}
          onRemove={setRemoving}
          onRetry={() => void staff.refetch()}
        />

        <StaffPermissionMatrix />

        {adding && (
          <StaffFormDialog
            takenUsernames={(staff.data ?? []).map((member) =>
              member.username.toLowerCase(),
            )}
            onClose={() => setAdding(false)}
            onSave={async (member) => {
              let added;

              try {
                added = await add.mutateAsync(member);
              } catch (error) {
                toast.error("Không thêm được nhân viên", {
                  description: messageOf(error),
                });

                // The dialog stays, with the username typed, to be fixed.
                throw error;
              }

              setAdding(false);
              toast.success(`Đã thêm ${added.username}`, {
                description: `Đăng nhập bằng tài khoản ${added.username} với vai trò ${roleLabels[added.role].toLowerCase()}.`,
              });
            }}
          />
        )}

        {removing && (
          <StaffDeleteDialog
            member={removing}
            onClose={() => setRemoving(null)}
            onDelete={async () => {
              try {
                await remove.mutateAsync(removing);
              } catch (error) {
                toast.error("Không xóa được", {
                  description: messageOf(error),
                });

                throw error;
              }

              setRemoving(null);
              toast(`Đã xóa ${removing.username}`);
            }}
          />
        )}
      </PageBody>
    </PermissionGate>
  );
}
