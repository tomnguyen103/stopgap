import { RouteNotFound } from "../components/route-not-found";

export default function PharmacistNotFound() {
  return <RouteNotFound title="Not found" home={{ href: "/queue", label: "Back to the queue" }} />;
}
