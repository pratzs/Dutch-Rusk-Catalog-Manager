import { DrAuthPage, storefrontUrl } from "../components/DrAuth";
import { useLoaderData } from "react-router";

// Sign-in pages are never cached: a stored copy could show an old page or an old sign-in.
export const headers = () => ({ "Cache-Control": "no-store" });
export const meta = () => [{ title: "Password changed | Dutch Rusk" }, { name: "robots", content: "noindex" }];

export const loader = () => ({ storefront: storefrontUrl() });

export default function Done() {
  const { storefront } = useLoaderData();
  return (
    <DrAuthPage title="Password changed" intro="Your new password is saved. Sign in with your store's email address and your new password.">
      <a className="dra-btn dra-btn--primary" href={storefront}>Go to the Dutch Rusk website</a>
    </DrAuthPage>
  );
}

// Branded error page instead of React Router's raw one.
export { DrAuthErrorBoundary as ErrorBoundary } from "../components/DrAuth";
