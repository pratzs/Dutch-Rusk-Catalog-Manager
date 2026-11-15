// Validate every Admin GraphQL document found in app/ against the live schema of
// one or more Admin API versions. Run before changing the API version the app
// pins, so a query that the new version would reject is found here and not in
// production.
//
//   node scripts/validate-admin-graphql.mjs 2026-04 2026-10
//
// Reads the offline token from the Session table (DATABASE_URL in .env).
// Documents with ${} interpolation are checked with the interpolation removed,
// so a failure on one of those needs a look by eye.
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import {
  getIntrospectionQuery,
  buildClientSchema,
  parse,
  validate,
  specifiedRules,
  NoUnusedFragmentsRule,
  KnownFragmentNamesRule,
  NoDeprecatedCustomRule,
} from "graphql";

const versions = process.argv.slice(2);
if (!versions.length) {
  console.error("usage: node scripts/validate-admin-graphql.mjs <version> [<version>...]");
  process.exit(2);
}

const prisma = new PrismaClient();
const session = await prisma.session.findFirst({
  where: { isOnline: false, accessToken: { not: "" } },
  orderBy: { id: "desc" },
});
await prisma.$disconnect();

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "types" && e.name !== "node_modules") walk(f);
    } else if (/\.(js|jsx|ts|tsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) {
      files.push(f);
    }
  }
})("app");

const BT = String.fromCharCode(96);
const docs = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  // Walk template literals by hand: start at a backtick, stop at the next
  // unescaped one. Nested templates inside ${} are rare in query text and
  // simply fail to parse, which is reported.
  let i = 0;
  while ((i = src.indexOf(BT, i)) >= 0) {
    let j = i + 1;
    while (j < src.length && src[j] !== BT) j += src[j] === "\\" ? 2 : 1;
    const text = src.slice(i + 1, j);
    const body = text.replace(/^\s*#graphql/, "").trim();
    if (/^(query|mutation|fragment|\{)[\s({\w]/.test(body) && body.includes("{")) {
      docs.push({ f, line: src.slice(0, i).split("\n").length, body, interp: text.includes("${") });
    }
    i = j + 1;
  }
}
console.log(`files ${files.length}, GraphQL documents ${docs.length}, with interpolation ${docs.filter((d) => d.interp).length}`);

const rules = specifiedRules.filter((r) => r !== NoUnusedFragmentsRule && r !== KnownFragmentNamesRule);
let failed = false;

for (const ver of versions) {
  const res = await fetch(`https://${session.shop}/admin/api/${ver}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
    body: JSON.stringify({ query: getIntrospectionQuery() }),
  });
  const served = res.headers.get("x-shopify-api-version");
  const json = await res.json();
  if (!json.data) {
    console.log(`\n=== ${ver}: could not read the schema: ${JSON.stringify(json).slice(0, 200)}`);
    failed = true;
    continue;
  }
  const schema = buildClientSchema(json.data);

  let ok = 0;
  const invalid = [];
  const unparsed = [];
  const deprecated = new Map();
  for (const d of docs) {
    let ast;
    try {
      ast = parse(d.interp ? d.body.replace(/\$\{[^}]*\}/g, "") : d.body);
    } catch (e) {
      unparsed.push(`${d.f}:${d.line}${d.interp ? " (interpolated)" : ""} ${e.message.slice(0, 90)}`);
      continue;
    }
    const errs = validate(schema, ast, rules);
    if (errs.length) invalid.push(`${d.f}:${d.line}${d.interp ? " (interpolated)" : ""} ${errs.map((e) => e.message).join(" | ").slice(0, 320)}`);
    else ok++;
    for (const e of validate(schema, ast, [NoDeprecatedCustomRule])) {
      const k = e.message.slice(0, 150);
      deprecated.set(k, (deprecated.get(k) ?? 0) + 1);
    }
  }
  console.log(`\n=== requested ${ver}, served ${served}: valid ${ok}, INVALID ${invalid.length}, could not parse ${unparsed.length}`);
  invalid.forEach((x) => console.log("  INVALID", x));
  unparsed.forEach((x) => console.log("  UNPARSED", x));
  console.log(`  deprecated fields in use: ${deprecated.size}`);
  [...deprecated].forEach(([k, v]) => console.log(`    ${v}x ${k}`));
  if (invalid.length) failed = true;
}
process.exit(failed ? 1 : 0);
