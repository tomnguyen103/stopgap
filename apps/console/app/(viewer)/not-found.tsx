import { RouteNotFound } from "../components/route-not-found";

export default function ViewerNotFound() {
  return <RouteNotFound title="Not found" home={{ href: "/overview", label: "Back to the overview" }} />;
}
