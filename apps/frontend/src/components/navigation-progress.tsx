import { useLocation, useNavigation } from "react-router";
import { tv } from "tailwind-variants";

const progress = tv({
  slots: {
    track:
      "pointer-events-none fixed inset-x-0 top-0 z-100 h-0.5 transition-opacity duration-150",
    indicator:
      "size-full origin-left bg-indigo-500 transition-transform duration-200 ease-out",
  },
  variants: {
    pending: {
      true: {
        track: "opacity-100 delay-100",
        indicator: "animate-navigation-progress",
      },
      false: {
        track: "opacity-0 delay-200",
        indicator: "scale-x-100",
      },
    },
  },
});

/** Route loading only; same-page filters and background queries keep their own UI. */
export default function NavigationProgress() {
  const navigation = useNavigation();
  const location = useLocation();
  const pending =
    navigation.state !== "idle" &&
    navigation.location?.pathname !== location.pathname;
  const styles = progress({ pending });

  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      aria-hidden={!pending}
      className={styles.track()}
    >
      <div className={styles.indicator()} />
    </div>
  );
}
