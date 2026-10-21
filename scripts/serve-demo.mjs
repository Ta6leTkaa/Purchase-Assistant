import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
const routes = new Map([
  ["/family.html", "tests/fixtures/family.html"],
  ["/legacy/basic_profile_form.html", "tests/fixtures/legacy/basic_profile_form.html"],
  ["/legacy/intent_form.html", "tests/fixtures/legacy/intent_form.html"]
]);
const server = createServer(async (req, res) => {
  const path = routes.get(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
  if (!path) {res.writeHead(404); res.end("Not found. Open /family.html"); return;}
  try {
    const body = await readFile(new URL(`../${path}`, import.meta.url));
    res.writeHead(200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"});
    res.end(body);
  } catch {res.writeHead(500); res.end("Fixture unavailable");}
});
server.listen(4173, "127.0.0.1", () => console.log("Demo: http://127.0.0.1:4173/family.html"));
