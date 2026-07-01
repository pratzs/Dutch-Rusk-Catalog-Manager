import prisma from "../db.server";

const METAFIELD_NAMESPACE = "dutchrusk";
const METAFIELD_KEY_LOCATION = "target_location_gid";
const METAFIELD_KEY_USERNAME = "target_username";

async function adminGraphql(shop, query, variables) {
  const session = await prisma.session.findFirst({ where: { shop, isOnline: false } });
  if (!session?.accessToken) throw new Error(`No offline session for shop ${shop}`);
  const resp = await fetch(`https://${shop}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-access-token": session.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await resp.json();
  if (data.errors) throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
  const userErrors = data?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length) throw new Error(`metafieldsSet userErrors: ${JSON.stringify(userErrors)}`);
  return data.data;
}

const METAFIELDS_SET = `
  mutation SetPreselect($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key namespace }
      userErrors { field message }
    }
  }
`;

export async function writeTargetLocationMetafield({ shop, customerGid, companyLocationGid, username }) {
  if (!shop || !customerGid || !companyLocationGid) return;
  await adminGraphql(shop, METAFIELDS_SET, {
    metafields: [
      {
        ownerId: customerGid,
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY_LOCATION,
        type: "single_line_text_field",
        value: companyLocationGid,
      },
      {
        ownerId: customerGid,
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY_USERNAME,
        type: "single_line_text_field",
        value: username || "",
      },
    ],
  });
}

export async function readTargetLocationMetafield({ shop, customerGid }) {
  const data = await adminGraphql(shop, `
    query($id: ID!) {
      customer(id: $id) {
        loc: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY_LOCATION}") { value }
        usr: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY_USERNAME}") { value }
      }
    }
  `, { id: customerGid });
  return {
    companyLocationGid: data?.customer?.loc?.value || null,
    username: data?.customer?.usr?.value || null,
  };
}

export async function clearTargetLocationMetafield({ shop, customerGid }) {
  await adminGraphql(shop, METAFIELDS_SET, {
    metafields: [
      {
        ownerId: customerGid,
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY_LOCATION,
        type: "single_line_text_field",
        value: "",
      },
    ],
  });
}
