/** A file in `public/`, beneath whichever base path serves this build. */
export default function assetPath(file: string) {
  return `${import.meta.env.BASE_URL}${file.replace(/^\/+/, "")}`;
}
