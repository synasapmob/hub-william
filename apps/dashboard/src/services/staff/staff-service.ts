import { apiClient, guarded, serviceError } from "@/services/api/api-client";
import type { components } from "@/services/api/api.generated";
import type { Role, StaffMember } from "@/services/sales/sales-types";

type ApiMember = components["schemas"]["StaffMember"];

function memberFromApi(member: ApiMember): StaffMember {
  return {
    id: member.id,
    last_active_at: member.last_active_at ?? null,
    locked: member.locked,
    orders_today: member.orders_today,
    revenue_today_vnd: member.revenue_today_vnd,
    role: member.role,
    username: member.username,
  };
}

/** Who may use the dashboard. */
class StaffService {
  readonly queryKey = ["dashboard", "staff"] as const;

  async list(): Promise<StaffMember[]> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.GET("/dashboard/staff");

      if (!data)
        throw serviceError(response, error, "Không tải được nhân viên.");

      return data.members.map(memberFromApi);
    });
  }

  /** Makes an existing account staff; the person registers it themselves. */
  async add(username: string, role: Role): Promise<StaffMember> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST(
        "/dashboard/staff",
        {
          body: { role, username },
        },
      );

      if (!data)
        throw serviceError(response, error, "Không thêm được nhân viên.");

      return memberFromApi(data);
    });
  }

  async changeRole(id: string, role: Role): Promise<StaffMember> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.PUT(
        "/dashboard/staff/{user_id}",
        { body: { role }, params: { path: { user_id: id } } },
      );

      if (!data) throw serviceError(response, error, "Không đổi được vai trò.");

      return memberFromApi(data);
    });
  }

  async remove(id: string): Promise<void> {
    return guarded(async () => {
      const { error, response } = await apiClient.DELETE(
        "/dashboard/staff/{user_id}",
        { params: { path: { user_id: id } } },
      );

      if (error)
        throw serviceError(response, error, "Không xóa được nhân viên.");
    });
  }
}

export const staffService = new StaffService();
