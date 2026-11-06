import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { roleLabels } from "@/services/sales/sales-labels";
import type { Role } from "@/services/sales/sales-types";

// The username rule of an account: 3 to 32 letters, digits, underscores or hyphens.
const USERNAME = /^[A-Za-z0-9_-]{3,32}$/;

// Every role can be given, the owner's included: an owner is a member like any other.
const INVITABLE_ROLES: Role[] = ["owner", "manager", "cashier", "stock-keeper"];

interface StaffFormDialogProps {
  /** Usernames already on the team, since each person has one account. */
  takenUsernames: string[];
  onClose: () => void;
  /** Rejects when the account could not be added; the page says why, and the dialog stays. */
  onSave: (member: { username: string; role: Role }) => Promise<void>;
}

export default function StaffFormDialog({
  onClose,
  onSave,
  takenUsernames,
}: StaffFormDialogProps) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("cashier");
  const [saving, setSaving] = useState(false);

  const usernameValid = USERNAME.test(username);
  const usernameTaken = takenUsernames.includes(username.toLowerCase());
  const valid = usernameValid && !usernameTaken;

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Thêm nhân viên</DialogTitle>

          <DialogDescription>
            Nhập username mà nhân viên đã đăng ký trên Hub William. Họ đăng nhập
            đúng tài khoản đó và chỉ thấy các trang mà vai trò cho phép.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="staff-username">Username</Label>

            <Input
              aria-invalid={
                username !== "" && (!usernameValid || usernameTaken)
              }
              id="staff-username"
              placeholder="Username đã đăng ký"
              value={username}
              onChange={(event) => setUsername(event.target.value.trim())}
            />

            {username !== "" && !usernameValid && (
              <p className="text-xs text-destructive">
                Username dài 3 đến 32 ký tự: chữ, số, dấu gạch dưới hoặc gạch
                ngang.
              </p>
            )}

            {usernameTaken && (
              <p className="text-xs text-destructive">
                Username này đã có trong danh sách nhân viên.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="staff-role">Vai trò</Label>

            <Select
              value={role}
              onValueChange={(next) => setRole(next as Role)}
            >
              <SelectTrigger className="w-full" id="staff-role">
                <SelectValue />
              </SelectTrigger>

              <SelectContent>
                {INVITABLE_ROLES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {roleLabels[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button disabled={saving} variant="outline" onClick={onClose}>
            Hủy
          </Button>

          <Button
            disabled={!valid || saving}
            onClick={async () => {
              setSaving(true);

              try {
                await onSave({ role, username });
              } catch {
                // The page has said why; the dialog stays for another try.
              } finally {
                setSaving(false);
              }
            }}
          >
            Thêm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
