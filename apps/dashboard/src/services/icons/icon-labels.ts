/** The name an icon is picked by: its name in the bucket, without `icons/`. */
export const iconName = (key: string) => key.replace(/^icons\//, "");
