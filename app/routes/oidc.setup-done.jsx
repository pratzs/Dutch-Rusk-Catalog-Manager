import { DrAuthPage, storefrontUrl } from "../components/DrAuth";
import { useLoaderData } from "react-router";

// Sign-in pages are never cached: a stored copy could show an old page or an old sign-in.
export const headers = () => ({ "Cache-Control": "no-store" });
export const meta = () => [{ title: "Password saved | Dutch Rusk" }, { name: "robots", content: "noindex" }];

export const loader = () => ({ storefront: storefrontUrl() });

export default function Done() {
  const { storefront } = useLoaderData();
  return (
    <DrAuthPage title="Password saved" intro="You're all set. Next time, sign in with your store's email address and this password, or with an emailed code.">
      <a className="dra-btn dra-btn--primary" href={storefront}>Go to the Dutch Rusk website</a>
    </DrAuthPage>
  );
}
