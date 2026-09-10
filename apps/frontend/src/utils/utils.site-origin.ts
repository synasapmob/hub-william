import { useSyncExternalStore } from "react";

import catalogService from "@/services/catalog";

const subscribe = () => () => {};
const getBrowserSnapshot = () => window.location.origin;
const getServerSnapshot = () => catalogService.publishedSiteOrigin;

/**
 * The host serving this build without making server render and hydration
 * disagree. An origin cannot change without a full navigation, so there is no
 * browser event to subscribe to.
 */
export default function useSiteOrigin() {
  return useSyncExternalStore(subscribe, getBrowserSnapshot, getServerSnapshot);
}
