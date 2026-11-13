import {
  apiClient,
  guarded,
  serviceError,
  sessionFetch,
} from "@/services/api/api-client";
import type { components } from "@/services/api/api.generated";
import { apiUrl } from "@/utils/utils.api-url";

/** The icon a provider shows: where to load it, and its name in the bucket. */
export type IconAssignment = components["schemas"]["IconAssignment"];

/** An icon in the bucket, to choose from. */
export type LibraryIcon = components["schemas"]["LibraryIcon"];

/** What the dashboard shows beside each provider. */
export interface ProviderIcons {
  /** False when the bucket is not set up, so no icon is shown or changed. */
  enabled: boolean;
  assignments: IconAssignment[];
}

/** The most the API takes of an icon, and the kinds it takes. */
export const MAXIMUM_ICON_BYTES = 256 * 1024;
export const ICON_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

class IconService {
  readonly queryKey = ["dashboard", "icons"] as const;

  /** Under `queryKey`, so a change to the icons refreshes the list too. */
  readonly libraryKey = [...this.queryKey, "library"] as const;

  async list(): Promise<ProviderIcons> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.GET("/dashboard/icons");

      if (!data)
        throw serviceError(
          response,
          error,
          "Không tải được icon nhà cung cấp.",
        );

      return data;
    });
  }

  async library(): Promise<LibraryIcon[]> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.GET(
        "/dashboard/icons/library",
      );

      if (!data)
        throw serviceError(response, error, "Không tải được danh sách icon.");

      return data.icons;
    });
  }

  /** Puts a picture in the bucket; the name is what its own name starts with. */
  async upload(file: File, name: string): Promise<string> {
    return guarded(async () => {
      const response = await sessionFetch(
        apiUrl(`/dashboard/icons?name=${encodeURIComponent(name)}`),
        {
          body: file,
          credentials: "include",
          headers: { "content-type": "application/octet-stream" },
          method: "POST",
        },
      );
      const body = (await response.json().catch(() => undefined)) as
        | (components["schemas"]["UploadedIcon"] &
            components["schemas"]["ErrorResponse"])
        | undefined;

      if (!response.ok || !body?.key)
        throw serviceError(response, body, "Không tải được icon lên.");

      return body.key;
    });
  }

  /** Makes a provider show this icon, or none for `null`. */
  async assign(provider: string, key: string | null): Promise<void> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.PUT(
        "/dashboard/icons/providers/{provider}",
        { body: { key }, params: { path: { provider } } },
      );

      if (!data) throw serviceError(response, error, "Không đổi được icon.");
    });
  }
}

export const iconService = new IconService();
