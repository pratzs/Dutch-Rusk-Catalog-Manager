import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigate, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  Checkbox,
  Text,
  BlockStack,
  InlineStack,
  Divider,
  Banner,
  Spinner,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";

const VARIANT_TYPES = [
  { label: "Shipper", value: "Shipper" },
  { label: "Outer", value: "Outer" },
  { label: "Bag", value: "Bag" },
  { label: "Each", value: "Each" },
  { label: "Packet", value: "Packet" },
  { label: "Block", value: "Block" },
  { label: "Tray", value: "Tray" },
];

export async function loader({ request }) {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const catalogId = url.searchParams.get("catalogId");
  const catalogName = url.searchParams.get("catalogName");

  if (!catalogId) return redirect("/app/catalog-manager");

  const rule = await prisma.catalogRule.findUnique({
    where: { catalogId },
  });

  return json({
    catalogId,
    catalogName,
    hiddenVariantTypes: rule ? rule.hiddenVariantTypes : [],
  });
}

export async function action({ request }) {
  await authenticate.admin(request);
  const formData = await request.formData();
  const catalogId = formData.get("catalogId");
  const catalogName = formData.get("catalogName");
  const hiddenVariantTypes = formData.getAll("hiddenVariantTypes");

  await prisma.catalogRule.upsert({
    where: { catalogId },
    update: { hiddenVariantTypes, catalogName },
    create: { catalogId, catalogName, hiddenVariantTypes },
  });

  return redirect("/app/catalog-manager");
}

export default function CatalogRules() {
  const { catalogId, catalogName, hiddenVariantTypes } = useLoaderData();
  const [selected, setSelected] = useState(hiddenVariantTypes);
  const [saved, setSaved] = useState(false);
  const submit = useSubmit();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const handleToggle = (value) => {
    setSelected((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    );
    setSaved(false);
  };

  const handleSave = () => {
    const formData = new FormData();
    formData.append("catalogId", catalogId);
    formData.append("catalogName", catalogName);
    selected.forEach((v) => formData.append("hiddenVariantTypes", v));
    submit(formData, { method: "post" });
    setSaved(true);
  };

  return (
    <Page
      title={`Rules for: ${catalogName}`}
      subtitle="Tick the variant types to HIDE from this catalog's customers"
      backAction={{ onAction: () => navigate("/app/catalog-manager") }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd">Bulk Rules — Hide by Variant Type</Text>
              <Text tone="subdued">
                Any variant whose name starts with the selected type will be
                hidden from customers assigned to this catalog.
              </Text>
              <Divider />
              <BlockStack gap="300">
                {VARIANT_TYPES.map((vt) => (
                  <Checkbox
                    key={vt.value}
                    label={`Hide all "${vt.label}" variants`}
                    checked={selected.includes(vt.value)}
                    onChange={() => handleToggle(vt.value)}
                  />
                ))}
              </BlockStack>
              <Divider />
              <InlineStack align="end" gap="300">
                <Button onClick={() => navigate("/app/catalog-manager")}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleSave}
                  loading={isSaving}
                >
                  Save Rules
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd">How this works</Text>
              <Text tone="subdued">
                Rules apply to ALL products in this catalog. For example,
                ticking "Shipper" will hide every Shipper variant (Shipper 6
                Outer, Shipper 12 Outer, etc.) from customers in this catalog.
              </Text>
              <Divider />
              <Text variant="headingMd">Need product-level control?</Text>
              <Text tone="subdued">
                Use the override button on the main page to hide specific
                variants on individual products only.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}