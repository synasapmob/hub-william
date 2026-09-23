import { useState, type ComponentProps } from "react";

interface ImageFallBackProps extends ComponentProps<"img"> {
  fallback?: string;
}

export default function ImageFallBack({
  alt,
  className,
  fallback,
  onError,
  src,
  ...props
}: ImageFallBackProps) {
  const [failedSource, setFailedSource] = useState<string | null>(null);

  if (src && failedSource === src)
    return <span className={className}>{fallback ?? alt}</span>;

  return (
    <img
      {...props}
      alt={alt}
      className={className}
      src={src}
      onError={(event) => {
        setFailedSource(src ?? null);
        onError?.(event);
      }}
    />
  );
}
