import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface OrganizationCreateValues {
  description: string;
  name: string;
}

interface OrganizationCreateFormProps {
  onCancel?: () => void;
  onCreate: (values: OrganizationCreateValues) => Promise<void>;
}

export default function OrganizationCreateForm({
  onCancel,
  onCreate,
}: OrganizationCreateFormProps) {
  const schema = z.object({
    description: z
      .string()
      .trim()
      .refine((value) => Array.from(value).length <= 350, {
        message: "Use 350 characters or fewer.",
      }),
    name: z.string().trim().min(1, "Enter a name.").max(80),
  });
  const form = useForm<OrganizationCreateValues>({
    defaultValues: { description: "", name: "" },
    resolver: zodResolver(schema),
  });
  const description = useWatch({ control: form.control, name: "description" });

  async function submit(values: OrganizationCreateValues) {
    try {
      await onCreate({
        description: values.description.trim(),
        name: values.name.trim(),
      });
      form.reset();
    } catch (error) {
      form.setError("root", {
        message:
          error instanceof Error
            ? error.message
            : "The organization could not be created.",
      });
    }
  }

  return (
    <form className="space-y-3" onSubmit={form.handleSubmit(submit)}>
      <div className="space-y-1.5">
        <Label htmlFor="organization-name">Organization name</Label>
        <Input
          id="organization-name"
          autoComplete="organization"
          placeholder="Team Mây"
          aria-invalid={Boolean(form.formState.errors.name)}
          {...form.register("name")}
        />
        {form.formState.errors.name ? (
          <p className="text-xs text-destructive">
            {form.formState.errors.name.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Flex className="items-center justify-between gap-2">
          <Label htmlFor="organization-description">
            Description (optional)
          </Label>
          <span className="font-mono text-xs text-muted-foreground">
            {Array.from(description).length}/350
          </span>
        </Flex>
        <Textarea
          id="organization-description"
          aria-invalid={Boolean(form.formState.errors.description)}
          placeholder="What is this team for?"
          rows={3}
          {...form.register("description")}
        />
        {form.formState.errors.description ? (
          <p className="text-xs text-destructive">
            {form.formState.errors.description.message}
          </p>
        ) : null}
      </div>

      {form.formState.errors.root ? (
        <p className="text-sm text-destructive">
          {form.formState.errors.root.message}
        </p>
      ) : null}

      <Flex className="flex-wrap gap-2">
        <Button disabled={form.formState.isSubmitting} type="submit">
          {form.formState.isSubmitting ? "Creating…" : "Create organization"}
        </Button>
        {onCancel ? (
          <Button onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
        ) : null}
      </Flex>
    </form>
  );
}
