const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080"
).replace(/\/$/, "");

/** Absolute or same-origin URL of an API path, following `VITE_API_BASE_URL`. */
export function apiUrl(path: string) {
  return `${API_BASE_URL}${path}`;
}
