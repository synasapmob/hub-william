import { Navigate } from "react-router";

export default function NotFoundRoute() {
  return <Navigate replace to="/" />;
}
