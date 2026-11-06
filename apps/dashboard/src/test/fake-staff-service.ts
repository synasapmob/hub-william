import { ServiceError } from "@/services/api/api-client";
import type { Role, StaffMember } from "@/services/sales/sales-types";

// The team a test starts from, shaped like the API's answer: the one owner (the last
// one, so locked), and three people added by hand.
const FIXTURE: StaffMember[] = [
  {
    id: "account-owner",
    last_active_at: "2026-11-05T14:32:00+07:00",
    locked: true,
    orders_today: 0,
    revenue_today_vnd: 0,
    role: "owner",
    username: "minhanh",
  },
  {
    id: "account-manager",
    last_active_at: "2026-11-05T14:12:00+07:00",
    locked: false,
    orders_today: 1,
    revenue_today_vnd: 459_000,
    role: "manager",
    username: "quocbao",
  },
  {
    id: "account-cashier",
    last_active_at: "2026-11-05T14:30:00+07:00",
    locked: false,
    orders_today: 2,
    revenue_today_vnd: 458_000,
    role: "cashier",
    username: "thuha",
  },
  {
    id: "account-stock-keeper",
    last_active_at: null,
    locked: false,
    orders_today: 0,
    revenue_today_vnd: 0,
    role: "stock-keeper",
    username: "ducthinh",
  },
];

// Accounts that exist and are not staff yet, which is all the API can add.
const REGISTERED = ["anbinh_01", "kimlien"];

let members: StaffMember[] = structuredClone(FIXTURE);

/** Puts the team back as every test starts. */
export function resetFakeStaff() {
  members = structuredClone(FIXTURE);
}

function find(id: string) {
  const member = members.find((candidate) => candidate.id === id);

  if (!member)
    throw new ServiceError(
      "The requested resource was not found.",
      404,
      "not_found",
    );

  return member;
}

const LAST_OWNER =
  "The shop needs at least one owner: make another account an owner first.";

/** The last active owner is the one that is locked, as the server marks it. */
function relock() {
  const owners = members.filter((member) => member.role === "owner");

  for (const member of members)
    member.locked = member.role === "owner" && owners.length === 1;
}

function refuseLastOwner(member: StaffMember, nextRole?: Role) {
  if (member.locked && nextRole !== "owner")
    throw new ServiceError(LAST_OWNER, 422, "validation_error");
}

/**
 * The staff service as the server would behave, kept in memory: an account that
 * does not exist or is staff already is refused, and the last owner cannot be
 * demoted or removed. A test replaces one method with a spy to see what was asked,
 * or to make it fail.
 */
export const fakeStaffService = {
  queryKey: ["dashboard", "staff"] as const,

  async list(): Promise<StaffMember[]> {
    return structuredClone(members);
  },

  async add(username: string, role: Role): Promise<StaffMember> {
    const known = [...REGISTERED, ...members.map((member) => member.username)];

    if (!known.includes(username.toLowerCase()))
      throw new ServiceError(
        "No account has that username.",
        422,
        "validation_error",
      );

    if (members.some((member) => member.username === username.toLowerCase()))
      throw new ServiceError(
        "That account is already staff.",
        409,
        "already_exists",
      );

    const added: StaffMember = {
      id: `account-${username.toLowerCase()}`,
      last_active_at: null,
      locked: false,
      orders_today: 0,
      revenue_today_vnd: 0,
      role,
      username: username.toLowerCase(),
    };

    members = [...members, added];
    relock();

    return structuredClone(members.find((member) => member.id === added.id)!);
  },

  async changeRole(id: string, role: Role): Promise<StaffMember> {
    const member = find(id);

    refuseLastOwner(member, role);
    member.role = role;
    relock();

    return structuredClone(member);
  },

  async remove(id: string): Promise<void> {
    refuseLastOwner(find(id));
    members = members.filter((member) => member.id !== id);
    relock();
  },
};
