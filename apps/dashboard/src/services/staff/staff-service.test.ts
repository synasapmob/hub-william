import { afterEach, describe, expect, it, vi } from "vitest";

import { answer, json, sent } from "@/test/mock-fetch";

import { staffService } from "./staff-service";

const ID = "3f2b8c1e-6d4a-4b7e-9a10-2c5d7e8f9a0b";

const API_MEMBER = {
  id: ID,
  last_active_at: "2026-11-05T07:30:00Z",
  locked: false,
  orders_today: 2,
  revenue_today_vnd: 458_000,
  role: "cashier",
  username: "thuha",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("staffService.list", () => {
  it("answers the members, with a never-seen account as null", async () => {
    const spy = answer(
      json(200, {
        members: [
          { ...API_MEMBER, locked: true, role: "owner", username: "minhanh" },
          { ...API_MEMBER, last_active_at: undefined, username: "ducthinh" },
        ],
      }),
    );

    const members = await staffService.list();

    expect((await sent(spy)).path).toBe("/dashboard/staff");
    expect(members[0]).toEqual({
      id: ID,
      last_active_at: "2026-11-05T07:30:00Z",
      locked: true,
      orders_today: 2,
      revenue_today_vnd: 458_000,
      role: "owner",
      username: "minhanh",
    });
    expect(members[1]).toMatchObject({
      last_active_at: null,
      username: "ducthinh",
    });
  });

  it("fails with the API's message, and its status", async () => {
    answer(
      json(403, { code: "forbidden", message: "Your role cannot do that." }),
    );

    await expect(staffService.list()).rejects.toMatchObject({
      message: "Your role cannot do that.",
      status: 403,
    });
  });

  it("fails clearly when the server cannot be reached", async () => {
    answer(new TypeError("Failed to fetch"));

    await expect(staffService.list()).rejects.toMatchObject({
      message: "Không kết nối được tới máy chủ.",
      status: null,
    });
  });
});

describe("staffService.add", () => {
  it("posts the username and the role, and answers the new member", async () => {
    const spy = answer(json(201, API_MEMBER));

    const member = await staffService.add("thuha", "cashier");

    const request = await sent(spy);

    expect(request.method).toBe("POST");
    expect(request.path).toBe("/dashboard/staff");
    expect(JSON.parse(String(request.body))).toEqual({
      role: "cashier",
      username: "thuha",
    });
    expect(member).toMatchObject({
      id: ID,
      role: "cashier",
      username: "thuha",
    });
  });

  it.each([
    [422, "validation_error", "No account has that username."],
    [409, "already_exists", "That account is already staff."],
  ])(
    "fails with the API's own words when it answers %i",
    async (status, code, message) => {
      answer(json(status, { code, message }));

      await expect(staffService.add("thuha", "cashier")).rejects.toMatchObject({
        code,
        message,
        status,
      });
    },
  );
});

describe("staffService.changeRole", () => {
  it("puts the role to the member and answers them", async () => {
    const spy = answer(json(200, { ...API_MEMBER, role: "manager" }));

    const member = await staffService.changeRole(ID, "manager");

    const request = await sent(spy);

    expect(request.method).toBe("PUT");
    expect(request.path).toBe(`/dashboard/staff/${ID}`);
    expect(JSON.parse(String(request.body))).toEqual({ role: "manager" });
    expect(member.role).toBe("manager");
  });

  it("fails with the API's message when the member is the last owner", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message:
          "The shop needs at least one owner: make another account an owner first.",
      }),
    );

    await expect(staffService.changeRole(ID, "cashier")).rejects.toMatchObject({
      message: expect.stringContaining("at least one owner"),
      status: 422,
    });
  });
});

describe("staffService.remove", () => {
  it("deletes the member", async () => {
    const spy = answer(new Response(null, { status: 204 }));

    await expect(staffService.remove(ID)).resolves.toBeUndefined();

    const request = await sent(spy);

    expect(request.method).toBe("DELETE");
    expect(request.path).toBe(`/dashboard/staff/${ID}`);
  });

  it("fails with the API's message when one may not remove themselves", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message: "You cannot remove yourself.",
      }),
    );

    await expect(staffService.remove(ID)).rejects.toMatchObject({
      message: "You cannot remove yourself.",
      status: 422,
    });
  });

  it("fails clearly when the server cannot be reached", async () => {
    answer(new TypeError("Failed to fetch"));

    await expect(staffService.remove(ID)).rejects.toMatchObject({
      message: "Không kết nối được tới máy chủ.",
      status: null,
    });
  });
});
