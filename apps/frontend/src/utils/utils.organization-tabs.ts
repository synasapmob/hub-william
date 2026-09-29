// The Organization page shows its My organizations dialog while this search
// parameter has this value, so a link can open it (an invitation notification,
// for one) and closing it removes the parameter again.
export const ORGANIZATION_TAB_PARAM = "tab";
export const MY_ORGANIZATION_TAB = "my-organization";
export const MY_ORGANIZATION_PATH = `/organization?${ORGANIZATION_TAB_PARAM}=${MY_ORGANIZATION_TAB}`;
