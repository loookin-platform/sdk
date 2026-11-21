// Usage: LOOOKIN_WORKSPACE=acme LOOOKIN_KEY=ins_... node examples/node/send.mjs
// Run `npm run build` first. In your own project import from "@loookin/sdk/node".
import { createClient } from "../../dist/node.js";

const { LOOOKIN_WORKSPACE: workspace, LOOOKIN_KEY: key } = process.env;
const loookin = createClient({ workspace, key, debug: true });

for (const company of ["example-company-1", "example-company-2"]) {
  for (let i = 0; i < 5; i++) console.log(loookin.track({ event: "example_sent", company, properties: { position: i }, context: { source: "system" } }));
}
await loookin.shutdown();
