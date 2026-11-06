/**
 * Leave this app for another page, such as a payment page. A separate function so
 * a test can see where the page would go.
 */
export function redirectTo(url: string) {
  window.location.assign(url);
}
