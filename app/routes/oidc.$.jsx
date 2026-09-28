// Any other /oidc address (a mistyped or cut-off link) gets the branded
// "Page not found" page instead of the plain 404.
export const loader = () => {
  throw new Response("Not found", { status: 404 });
};

export default function NotFound() {
  return null;
}

export { DrAuthErrorBoundary as ErrorBoundary } from "../components/DrAuth";
