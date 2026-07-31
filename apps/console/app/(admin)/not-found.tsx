import { RouteNotFound } from "../components/route-not-found";

export default function AdminNotFound() {
  return <RouteNotFound title="Not found" home={{ href: "/admin", label: "Back to administration" }} />;
}
