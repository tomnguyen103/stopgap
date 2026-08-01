import { RouteNotFound } from "../components/route-not-found";

export default function DirectorNotFound() {
  return (
    <RouteNotFound title="Not found" home={{ href: "/oversight", label: "Back to oversight" }} />
  );
}
