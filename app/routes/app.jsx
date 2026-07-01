// app/routes/app.jsx
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

export const loader = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");
  try {
    await authenticate.admin(request);
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[app] authenticate.admin failed with non-Response error:", err.message || err);
    throw err;
  }
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();
  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/catalog-manager">Catalog Manager</s-link>
        <s-link href="/app/customers">Customers</s-link>
        <s-link href="/app/audit">Audit Report</s-link>
        <s-link href="/app/clone">Copy Rules</s-link>
        <s-link href="/app/migrate">Migrate Tool</s-link>
        <s-link href="/app/help">Help</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
